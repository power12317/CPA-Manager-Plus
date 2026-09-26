package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	clustersvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cluster"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

type borrowTestCPA struct {
	mu             sync.Mutex
	writes         []map[string]string
	settings       map[string]string
	status         int
	disabled       bool
	cookieRequests int
}

func newBorrowTestCPA(t *testing.T, key, prefix string) (*httptest.Server, *borrowTestCPA) {
	t.Helper()
	state := &borrowTestCPA{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key {
			w.WriteHeader(401)
			return
		}
		if !strings.HasPrefix(r.URL.Path, prefix+"/v0/management/") {
			w.WriteHeader(404)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, prefix+"/v0/management/")
		state.mu.Lock()
		defer state.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch path {
		case "codex-oailb-borrow":
			if state.status != 0 {
				w.WriteHeader(state.status)
				_, _ = w.Write([]byte(`{"error":"source-secret target-secret oauth-secret cookie-secret"}`))
				return
			}
			if r.Method == http.MethodPut {
				var input map[string]string
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Error(err)
					w.WriteHeader(400)
					return
				}
				state.writes = append(state.writes, input)
				state.settings = input
				_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"supported": true, "config": state.settings})
			}
		case "auth-files":
			_ = json.NewEncoder(w).Encode(map[string]any{"files": []map[string]any{
				{"id": "stable-oauth-id", "name": "codex-user-windows.json", "auth_index": "temporary-index", "provider": "codex", "account_type": "oauth", "disabled": state.disabled, "access_token": "oauth-secret"},
				{"id": "disabled", "name": "disabled.json", "provider": "codex", "account_type": "oauth", "disabled": true},
				{"id": "api-key", "name": "api-key.json", "provider": "codex", "account_type": "api_key"},
				{"id": "devin", "name": "devin.json", "provider": "devin", "account_type": "oauth"},
				{"name": "no-id.json", "auth_index": "only-index", "provider": "codex", "account_type": "oauth"},
				{"id": "runtime", "name": "runtime.json", "provider": "codex", "account_type": "oauth", "runtime_only": true},
				{"id": "duplicate", "name": "a.json", "provider": "codex", "account_type": "oauth"},
				{"id": "duplicate", "name": "b.json", "provider": "codex", "account_type": "oauth"},
			}})
		case "codex/oailb/borrow":
			state.cookieRequests++
			_ = json.NewEncoder(w).Encode(map[string]string{"value": "cookie-secret"})
		case "config":
			_, _ = w.Write([]byte(`{"usage-statistics-enabled":true,"redis-usage-queue-retention-seconds":60}`))
		case "usage-queue":
			_, _ = w.Write([]byte(`{"items":[]}`))
		default:
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		}
	}))
	t.Cleanup(server.Close)
	return server, state
}

func TestOailbBorrowUsesRegistrySecretsAndStableCredentialOnCurrentInstance(t *testing.T) {
	ctx := context.Background()
	target, targetState := newBorrowTestCPA(t, "target-secret", "/target")
	source, sourceState := newBorrowTestCPA(t, "source-secret", "/source")
	another, anotherState := newBorrowTestCPA(t, "another-secret", "/another")
	cfg := testutil.NewConfig(t)
	cfg.BasePath = "/panel"
	protector, err := security.NewProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(cfg.DBPath, protector)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	testutil.EnsureAdminCredential(t, db)
	disabled := false
	if err := db.SaveManagerConfig(ctx, model.ManagerConfig{CPAConnection: model.ManagerCPAConnectionConfig{CPABaseURL: target.URL + "/target", ManagementKey: "target-secret"}, Collector: model.ManagerCollectorConfig{Enabled: &disabled}}); err != nil {
		t.Fatal(err)
	}
	server := New(cfg, db, collector.NewManager(cfg, db))
	cluster := server.EnableCluster(protector)
	cluster.Start(ctx)
	t.Cleanup(func() { _ = cluster.Close(ctx) })
	sourceID, err := cluster.Save(ctx, "", clustersvc.Input{Name: "Source", BaseURL: source.URL + "/source/v0/management", ManagementKey: "source-secret", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	otherID, err := cluster.Save(ctx, "", clustersvc.Input{Name: "Another", BaseURL: another.URL + "/another", ManagementKey: "another-secret", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, id, suffix, body, key string) *httptest.ResponseRecorder {
		t.Helper()
		result := testutil.Request(t, server.Handler(), method, "/panel/api/instances/"+id+"/oailb-borrow"+suffix, body, key)
		for _, secret := range []string{"source-secret", "target-secret", "another-secret", "oauth-secret", "cookie-secret", "source-management-key", "temporary-index"} {
			if strings.Contains(result.Body.String(), secret) {
				t.Fatalf("secret or transient identity exposed: %s", result.Body.String())
			}
		}
		return result
	}
	testutil.RequireStatus(t, request("GET", "default", "", "", "target-secret"), 401)
	empty := request("GET", "default", "", "", testutil.AdminKey)
	testutil.RequireStatus(t, empty, 200)
	var state clustersvc.OailbBorrowStatus
	testutil.DecodeJSON(t, empty, &state)
	if !state.Supported || state.Configured {
		t.Fatalf("unexpected default: %+v", state)
	}
	listed := request("GET", "default", "/credentials?source="+sourceID, "", testutil.AdminKey)
	testutil.RequireStatus(t, listed, 200)
	var choices struct {
		Credentials []clustersvc.OailbBorrowCredential `json:"credentials"`
	}
	testutil.DecodeJSON(t, listed, &choices)
	if len(choices.Credentials) != 1 || choices.Credentials[0].ID != "stable-oauth-id" || choices.Credentials[0].Name != "codex-user-windows.json" {
		t.Fatalf("wrong credential choices: %+v", choices)
	}
	selection, _ := json.Marshal(clustersvc.OailbBorrowSelection{SourceInstanceID: sourceID, SourceAuthID: "stable-oauth-id"})
	for _, invalid := range []string{`null`, `{"sourceInstanceId":"default","sourceAuthId":"stable-oauth-id"}`, `{"source-url":"https://untrusted.invalid","source-management-key":"forged"}`, `{} {}`} {
		testutil.RequireStatus(t, request("PUT", "default", "", invalid, testutil.AdminKey), 400)
	}
	wrongIndex, _ := json.Marshal(clustersvc.OailbBorrowSelection{SourceInstanceID: sourceID, SourceAuthID: "temporary-index"})
	testutil.RequireStatus(t, request("PUT", "default", "", string(wrongIndex), testutil.AdminKey), 409)
	saved := request("PUT", "default", "", string(selection), testutil.AdminKey)
	testutil.RequireStatus(t, saved, 200)
	testutil.DecodeJSON(t, saved, &state)
	if !state.Configured || state.SourceInstanceID != sourceID || state.SourceAuthID != "stable-oauth-id" {
		t.Fatalf("wrong saved state: %+v", state)
	}
	targetState.mu.Lock()
	writeCount := len(targetState.writes)
	if writeCount != 1 {
		targetState.mu.Unlock()
		t.Fatalf("unexpected writes: %d", writeCount)
	}
	payload := targetState.writes[0]
	targetState.mu.Unlock()
	if len(payload) != 5 || payload["source-management-key"] != "source-secret" || payload["source-url"] != source.URL+"/source" || payload["source-auth-id"] != "stable-oauth-id" || payload["source-auth-file"] != "codex-user-windows.json" || payload["source-instance-id"] != sourceID {
		t.Fatalf("wrong CPA request: %+v", payload)
	}
	testutil.RequireStatus(t, request("GET", "default", "", "", testutil.AdminKey), 200)
	// A second borrower may use exactly the same source without reassigning it.
	testutil.RequireStatus(t, request("PUT", otherID, "", string(selection), testutil.AdminKey), 200)
	sourceState.mu.Lock()
	if len(sourceState.writes) != 0 || sourceState.cookieRequests != 0 {
		t.Error("Manager wrote to source or obtained a cookie")
	}
	sourceState.disabled = true
	sourceState.mu.Unlock()
	anotherState.mu.Lock()
	if len(anotherState.writes) != 1 {
		t.Error("second borrower was not configured")
	}
	anotherState.mu.Unlock()
	testutil.RequireStatus(t, request("PUT", "default", "", string(selection), testutil.AdminKey), 409)
	sourceState.mu.Lock()
	sourceState.disabled = false
	sourceState.status = 404
	sourceState.mu.Unlock()
	testutil.RequireStatus(t, request("GET", "default", "/credentials?source="+sourceID, "", testutil.AdminKey), 409)
	sourceState.mu.Lock()
	sourceState.status = 500
	sourceState.mu.Unlock()
	testutil.RequireStatus(t, request("GET", "default", "/credentials?source="+sourceID, "", testutil.AdminKey), 503)
	sourceState.mu.Lock()
	sourceState.status = 0
	sourceState.mu.Unlock()
	testutil.RequireStatus(t, request("PUT", "default", "", `{}`, testutil.AdminKey), 200)
	targetState.mu.Lock()
	if len(targetState.writes) != 2 || len(targetState.writes[1]) != 0 {
		t.Error("clearing did not send an empty object")
	}
	targetState.mu.Unlock()
	for _, code := range []int{404, 405, 501} {
		targetState.mu.Lock()
		targetState.status = code
		targetState.mu.Unlock()
		unsupported := request("GET", "default", "", "", testutil.AdminKey)
		testutil.RequireStatus(t, unsupported, 200)
		testutil.DecodeJSON(t, unsupported, &state)
		if state.Supported {
			t.Fatalf("HTTP %d was not treated as unsupported", code)
		}
		testutil.RequireStatus(t, request("PUT", "default", "", `{}`, testutil.AdminKey), 409)
	}
	targetState.mu.Lock()
	targetState.status = 500
	targetState.mu.Unlock()
	testutil.RequireStatus(t, request("GET", "default", "", "", testutil.AdminKey), 502)
	// Unrelated CPA settings still work when borrowing is unsupported/broken.
	testutil.RequireStatus(t, testutil.Request(t, server.Handler(), "GET", "/panel/api/instances/default/v0/management/config", "", testutil.AdminKey), 200)
	rt, err := cluster.Runtime(sourceID)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := sql.Open("sqlite", rt.(*instanceRuntime).server.appCtx.Config.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var raw string
	if err := reader.QueryRow(`select value from settings where key='manager_config_v1'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "source-secret") || !strings.Contains(raw, "enc:v1:") {
		t.Fatal("source registry secret was not encrypted")
	}
}
