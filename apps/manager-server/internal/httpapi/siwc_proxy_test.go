package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

func TestSIWCScopedV8ProxyAndCredentialIdentity(t *testing.T) {
	for _, prefix := range []string{"", "/api/instances/default"} {
		t.Run(prefix, func(t *testing.T) {
			var mu sync.Mutex
			var forwarded []string
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer saved-cpa-key" {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/v0/management/auth-files" || r.URL.Path == "/v8/management/credentials" {
					io.WriteString(w, `{"files":[{"name":"same.json","id":"same.json","type":"codex","auth_index":"1","siwc_bind_supported":true,"siwc_bound":true,"use_siwc":false}]}`)
					return
				}
				body, _ := io.ReadAll(r.Body)
				if strings.HasPrefix(r.URL.Path, "/v8/") {
					mu.Lock()
					forwarded = append(forwarded, r.Method+" "+r.URL.RequestURI()+" "+string(body))
					mu.Unlock()
					if r.Header.Get("X-CPAMP-Auth-File-Mutation-Identity") != "" {
						t.Error("local identity metadata leaked upstream")
					}
				}
				io.WriteString(w, `{"status":"ok"}`)
			}))
			defer upstream.Close()
			cfg := testutil.NewConfig(t)
			cfg.BasePath = "/tools/cpamp"
			db := testutil.NewStore(t, cfg)
			if err := db.SaveSetup(context.Background(), store.Setup{CPAUpstreamURL: upstream.URL, ManagementKey: "saved-cpa-key", Queue: "usage", PopSide: "right"}); err != nil {
				t.Fatal(err)
			}
			server := New(cfg, db, collector.NewManager(cfg, db))
			if prefix != "" {
				protector, err := security.NewProtector(make([]byte, 32))
				if err != nil {
					t.Fatal(err)
				}
				cluster := server.EnableCluster(protector)
				cluster.Start(context.Background())
				t.Cleanup(func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					if err := cluster.Close(ctx); err != nil {
						t.Error(err)
					}
				})
				deadline := time.Now().Add(5 * time.Second)
				for {
					if _, err := cluster.Runtime("default"); err == nil {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("default instance did not load")
					}
					time.Sleep(time.Millisecond)
				}
			}
			request := func(method, path, body, index, key string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "/tools/cpamp"+prefix+"/v8/management"+path, strings.NewReader(body))
				r.Header.Set("Authorization", "Bearer "+key)
				r.Header.Set("Content-Type", "application/json")
				if index != "" {
					r.Header.Set("X-CPAMP-Auth-File-Mutation-Identity", url.QueryEscape(`[{"name":"same.json","authIndex":"`+index+`","provider":"codex"}]`))
				}
				w := httptest.NewRecorder()
				server.Handler().ServeHTTP(w, r)
				return w
			}
			testutil.RequireStatus(t, request("GET", "/credentials", "", "", "wrong-key"), http.StatusUnauthorized)
			testutil.RequireStatus(t, request("GET", "/credentials", "", "", testutil.AdminKey), http.StatusOK)
			for _, tc := range []struct{ method, path, body, identity string }{
				{"POST", "/oauth/siwc/bind", `{"name":"same.json"}`, "1"},
				{"POST", "/oauth/callback", `{"provider":"codex","redirect_url":"http://127.0.0.1:1455/auth/callback?code=a%2Bb&state=s&client_id=issued"}`, ""},
				{"GET", "/oauth/status?state=s", "", ""},
				{"DELETE", "/oauth/session?state=s", "", ""},
				{"PATCH", "/credentials/fields", `{"name":"same.json","use_siwc":true,"allow_codex_client_siwc":false}`, "1"},
				{"PATCH", "/credentials/fields", `{"name":"same.json","use_siwc":false,"allow_codex_client_siwc":true}`, "1"},
			} {
				testutil.RequireStatus(t, request(tc.method, tc.path, tc.body, tc.identity, testutil.AdminKey), http.StatusOK)
				mu.Lock()
				got := forwarded[len(forwarded)-1]
				mu.Unlock()
				prefix := tc.method + " /v8/management" + tc.path + " "
				if !strings.HasPrefix(got, prefix) {
					t.Fatalf("official v8 payload changed: %s", got)
				}
				body := strings.TrimPrefix(got, prefix)
				if tc.body == "" {
					if body != "" {
						t.Fatalf("unexpected request body: %s", body)
					}
				} else {
					var actual, expected any
					if json.Unmarshal([]byte(body), &actual) != nil || json.Unmarshal([]byte(tc.body), &expected) != nil || !reflect.DeepEqual(actual, expected) {
						t.Fatalf("official v8 payload changed: %s", got)
					}
				}
			}
			mu.Lock()
			before := len(forwarded)
			mu.Unlock()
			for _, tc := range []struct{ method, path, body string }{
				{"POST", "/oauth/siwc/bind", `{"name":"same.json"}`},
				{"PATCH", "/credentials/fields", `{"name":"same.json","use_siwc":true,"allow_codex_client_siwc":false}`},
			} {
				response := request(tc.method, tc.path, tc.body, "replaced-auth-index", testutil.AdminKey)
				if response.Code != http.StatusConflict && response.Code != http.StatusNotFound {
					t.Fatalf("replaced credential accepted: %d %s", response.Code, response.Body.String())
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if len(forwarded) != before {
				t.Fatal("stale credential mutation reached CPA")
			}
		})
	}
}
