package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

// Runtime configuration and OAuth are owned by CPA. The Manager proxy must
// preserve their payloads and responses while using the selected CPA key.
func TestCodexRuntimeManagementProxy(t *testing.T) {
	for _, prefix := range []string{"", "/api/instances/default"} {
		t.Run("scope="+prefix, func(t *testing.T) {
			type request struct{ method, path, query, body, auth string }
			requests := make(chan request, 20)
			responseCode := http.StatusOK
			responseBody := `{"enabled":false,"workers":[],"credentials":[]}`
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasPrefix(r.URL.Path, "/v0/management/codex-runtime") {
					http.NotFound(w, r)
					return
				}
				body, _ := io.ReadAll(r.Body)
				requests <- request{r.Method, r.URL.Path, r.URL.RawQuery, string(body), r.Header.Get("Authorization")}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(responseCode)
				_, _ = io.WriteString(w, responseBody)
			}))
			t.Cleanup(upstream.Close)
			cfg := testutil.NewConfig(t)
			db := testutil.NewStore(t, cfg)
			if err := db.SaveSetup(context.Background(), store.Setup{
				CPAUpstreamURL: upstream.URL,
				ManagementKey:  "saved-cpa-key",
				Queue:          "usage",
				PopSide:        "right",
			}); err != nil {
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
			handler := server.Handler()
			cases := []struct{ method, suffix, body string }{
				{http.MethodGet, "", ""},
				{http.MethodPatch, "", `{"enabled":false}`},
				{http.MethodPut, "", `{"workers":[{"id":"one","url":"ws://codex:38317","auth_file":"fixed.json","models":["gpt-5"]}]}`},
				{http.MethodPost, "/credentials", `{"name":"fixed.json","worker_id":"one","enabled":true}`},
				{http.MethodPost, "/test", `{"worker_id":"one"}`},
				{http.MethodPost, "/login/start", `{"worker_id":"one"}`},
				{http.MethodPost, "/login/callback", `{"worker_id":"one","login_id":"login-1","redirect_url":"http://localhost:1455/auth/callback?code=a%2Bb&state=one"}`},
				{http.MethodGet, "/login/status?worker_id=one&login_id=login-1", ""},
			}
			for _, tc := range cases {
				t.Run(tc.method+tc.suffix, func(t *testing.T) {
					path := "/v0/management/codex-runtime" + tc.suffix
					rr := testutil.Request(t, handler, tc.method, prefix+path, tc.body, testutil.AdminKey)
					testutil.RequireStatus(t, rr, responseCode)
					if rr.Body.String() != responseBody {
						t.Fatalf("response body changed: %s", rr.Body.String())
					}
					got := <-requests
					if got.method != tc.method || got.body != tc.body || got.auth != "Bearer saved-cpa-key" {
						t.Fatalf("unexpected upstream request: %#v", got)
					}
					gotPath := got.path
					if got.query != "" {
						gotPath += "?" + got.query
					}
					if gotPath != path {
						t.Fatalf("upstream path = %q, want %q", gotPath, path)
					}
				})
			}
			for _, code := range []int{http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusConflict} {
				responseCode = code
				responseBody = `{"error":"runtime unavailable"}`
				rr := testutil.Request(t, handler, http.MethodPost, prefix+"/v0/management/codex-runtime/test", `{"worker_id":"one"}`, testutil.AdminKey)
				testutil.RequireStatus(t, rr, code)
				if rr.Body.String() != responseBody {
					t.Fatalf("error body changed: %s", rr.Body.String())
				}
				<-requests
			}
		})
	}
}
