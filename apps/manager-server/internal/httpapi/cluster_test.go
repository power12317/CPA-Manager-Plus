package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	clustersvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cluster"
	monitoringsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestClusterScopedProxyCredentialsEncryptionAndRestart(t *testing.T) {
	ctx := context.Background()
	var requestsMu sync.Mutex
	requests := make(map[string][]string)
	upstream := func(name, key string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+key {
				w.WriteHeader(401)
				return
			}
			requestsMu.Lock()
			requests[name] = append(requests[name], r.Method+" "+r.URL.Path)
			requestsMu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/v0/management/config":
				fmt.Fprintf(w, `{"node":%q,"usage-statistics-enabled":true}`, name)
			case "/v0/management/auth-files":
				fmt.Fprint(w, `{"files":[{"name":"same.json","id":"same","type":"codex","auth_index":"1","access_token":"must-not-appear"}]}`)
			case "/v0/management/usage-queue":
				fmt.Fprint(w, `{"items":[]}`)
			case "/v0/management/codex-auth-url":
				fmt.Fprintf(w, `{"url":"https://auth.example/authorize","state":%q}`, name)
			case "/v0/management/get-auth-status":
				fmt.Fprintf(w, `{"status":"ok","node":%q}`, name)
			default:
				fmt.Fprint(w, `{"status":"ok"}`)
			}
		}))
	}
	a := upstream("A", "key-A")
	defer a.Close()
	b := upstream("B", "key-B")
	defer b.Close()
	protector, err := security.NewProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DBPath: filepath.Join(t.TempDir(), "usage.sqlite"), BasePath: "/tools/cpamp", Queue: "usage", PopSide: "right", CollectorMode: "http", PollInterval: time.Second, BatchSize: 100}
	db, err := store.Open(cfg.DBPath, protector)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	credential, err := security.NewAdminCredential("admin-secret", "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SaveAdminCredential(ctx, credential); err != nil {
		t.Fatal(err)
	}
	disabled := false
	if err := db.SaveManagerConfig(ctx, model.ManagerConfig{CPAConnection: model.ManagerCPAConnectionConfig{CPABaseURL: a.URL, ManagementKey: "key-A"}, Collector: model.ManagerCollectorConfig{Enabled: &disabled}}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if _, err := db.InsertEvents(ctx, []usage.Event{{EventHash: "legacy-event", TimestampMS: now, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), Model: "test-model", TotalTokens: 7, RawJSON: `{"legacy":true}`}}); err != nil {
		t.Fatal(err)
	}
	server := New(cfg, db, collector.NewManager(cfg, db))
	service := server.EnableCluster(protector)
	service.Start(ctx)
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		_ = service.Close(stopCtx)
	})
	h := server.Handler()
	request := func(method, path, body, key string) *httptest.ResponseRecorder {
		return testutil.Request(t, h, method, "/tools/cpamp"+path, body, key)
	}
	testutil.RequireStatus(t, request("GET", "/api/instances", "", "key-A"), 401)
	payload, _ := json.Marshal(clustersvc.Input{Name: "B", BaseURL: b.URL, ManagementKey: "key-B", Enabled: false})
	created := request("POST", "/api/instances", string(payload), "admin-secret")
	testutil.RequireStatus(t, created, 200)
	var result struct {
		ID string `json:"id"`
	}
	testutil.DecodeJSON(t, created, &result)
	id := result.ID
	childDBPath := filepath.Join(filepath.Dir(cfg.DBPath), "instances", id, "usage.sqlite")
	reader, err := sql.Open("sqlite", childDBPath)
	if err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := reader.QueryRow(`select value from settings where key='manager_config_v1'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "key-B") || !strings.Contains(raw, "enc:v1:") {
		t.Fatalf("CPA key not encrypted: %s", raw)
	}
	_ = reader.Close()
	items, err := service.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.ID == id && item.Enabled {
			t.Fatal("disabled state ignored")
		}
	}
	testutil.RequireStatus(t, request("GET", "/api/instances/"+id+"/v0/management/config", "", "admin-secret"), 503)
	// Enable without changing the connection. This works even if upstream is
	// temporarily offline and must not require resubmitting a secret.
	payload, _ = json.Marshal(clustersvc.Input{Name: "B", BaseURL: b.URL, Enabled: true})
	testutil.RequireStatus(t, request("PUT", "/api/instances/"+id, string(payload), "admin-secret"), 200)
	path := "/api/instances/" + id
	for _, check := range []struct{ path, node string }{{"/api/instances/default/v0/management/config", "A"}, {path + "/v0/management/config", "B"}, {path + "/v0/management/codex-auth-url", "B"}, {path + "/v0/management/get-auth-status?state=B", "B"}} {
		response := request("GET", check.path, "", "admin-secret")
		testutil.RequireStatus(t, response, 200)
		if !strings.Contains(response.Body.String(), `"`+check.node+`"`) {
			t.Fatalf("wrong instance: %s", response.Body.String())
		}
	}
	credentials := request("GET", "/api/cluster/credentials", "", "admin-secret")
	testutil.RequireStatus(t, credentials, 200)
	var aggregate clustersvc.Aggregate[[]map[string]any]
	testutil.DecodeJSON(t, credentials, &aggregate)
	if aggregate.Total != 2 || aggregate.Succeeded != 2 {
		t.Fatalf("aggregate=%s", credentials.Body.String())
	}
	if strings.Contains(credentials.Body.String(), "must-not-appear") || strings.Contains(credentials.Body.String(), "key-B") {
		t.Fatal("secret leaked into aggregate")
	}
	if aggregate.Instances[0].InstanceID == aggregate.Instances[1].InstanceID {
		t.Fatal("same file names collapsed source identities")
	}
	testutil.RequireStatus(t, request("GET", path+"/management.html", "", ""), 200)
	testutil.RequireStatus(t, request("GET", path+"/usage-service/info", "", ""), 200)
	testutil.RequireStatus(t, request("GET", path+"/v1/models", "", "key-B"), 200)
	testutil.RequireStatus(t, request("GET", path+"/v0/management/config", "", "key-B"), 401)
	root := request("GET", "/", "", "")
	testutil.RequireStatus(t, root, 307)
	if root.Header().Get("Location") != "management.html" {
		t.Fatal("redirect escaped deployment prefix")
	}
	// Existing history belongs only to the default instance.
	child, err := service.Runtime(id)
	if err != nil {
		t.Fatal(err)
	}
	childStore := child.(*instanceRuntime).server.appCtx.Store
	count, _, err := childStore.Counts(ctx)
	if err != nil || count != 0 {
		t.Fatalf("history leaked into B: count=%d err=%v", count, err)
	}
	count, _, err = db.Counts(ctx)
	if err != nil || count != 1 {
		t.Fatal("legacy history changed")
	}
	// The original page contracts now contain every instance, including exact
	// global percentiles and stable pagination when timestamps/local IDs collide.
	l1, l2 := int64(100), int64(900)
	_, err = childStore.InsertEvents(ctx, []usage.Event{
		{EventHash: "child-one", TimestampMS: now, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), Model: "test-model", TotalTokens: 120, AuthIndex: "1", AuthFileSnapshot: "same.json", LatencyMS: &l1},
		{EventHash: "child-two", TimestampMS: now, Timestamp: time.Now().UTC().Format(time.RFC3339Nano), Model: "test-model", TotalTokens: 80, AuthIndex: "1", AuthFileSnapshot: "same.json", LatencyMS: &l2, Failed: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	analyticsPath := "/api/aggregate/v0/management/monitoring/analytics"
	query := fmt.Sprintf(`{"from_ms":%d,"to_ms":%d,"include":{"summary":true,"summary_percentiles":true,"timeline":true,"events_page":{"limit":2}}}`, now-1000, now+1000)
	analytics := request("POST", analyticsPath, query, "admin-secret")
	testutil.RequireStatus(t, analytics, 200)
	var metrics monitoringsvc.Response
	testutil.DecodeJSON(t, analytics, &metrics)
	if metrics.Summary.TotalCalls != 3 || metrics.Summary.TotalTokens != 207 || metrics.Summary.FailureCalls != 1 {
		t.Fatalf("wrong global metrics: %s", analytics.Body.String())
	}
	if metrics.Summary.P95LatencyMS == nil || *metrics.Summary.P95LatencyMS != 900 || metrics.Summary.AverageLatencyMS == nil || *metrics.Summary.AverageLatencyMS != 500 {
		t.Fatalf("wrong global timings: %s", analytics.Body.String())
	}
	if metrics.Events == nil || len(metrics.Events.Items) != 2 || !metrics.Events.HasMore {
		t.Fatalf("wrong first page: %s", analytics.Body.String())
	}
	nextQuery := fmt.Sprintf(`{"from_ms":%d,"to_ms":%d,"include":{"events_page":{"limit":2,"before_ms":%d,"before_id":%d}}}`, now-1000, now+1000, metrics.Events.NextBeforeMS, metrics.Events.NextBeforeID)
	nextPage := request("POST", analyticsPath, nextQuery, "admin-secret")
	testutil.RequireStatus(t, nextPage, 200)
	var remainder monitoringsvc.Response
	testutil.DecodeJSON(t, nextPage, &remainder)
	if remainder.Events == nil || len(remainder.Events.Items) != 1 {
		t.Fatalf("wrong next page: %s", nextPage.Body.String())
	}
	filesResponse := request("GET", "/api/aggregate/v0/management/auth-files", "", "admin-secret")
	testutil.RequireStatus(t, filesResponse, 200)
	var scopedFiles struct {
		Files []map[string]any `json:"files"`
	}
	testutil.DecodeJSON(t, filesResponse, &scopedFiles)
	if len(scopedFiles.Files) != 2 || scopedFiles.Files[0]["name"] == scopedFiles.Files[1]["name"] {
		t.Fatalf("source files collided: %s", filesResponse.Body.String())
	}
	var target string
	for _, file := range scopedFiles.Files {
		if file["instanceId"] == id {
			target, _ = file["id"].(string)
		}
	}
	statusBody, _ := json.Marshal(map[string]any{"name": target, "disabled": true})
	statusResponse := request("PATCH", "/api/aggregate/v0/management/auth-files/status", string(statusBody), "admin-secret")
	testutil.RequireStatus(t, statusResponse, 200)
	requestsMu.Lock()
	aWrites, bWrites := 0, 0
	for _, seen := range requests["A"] {
		if seen == "PATCH /v0/management/auth-files/status" {
			aWrites++
		}
	}
	for _, seen := range requests["B"] {
		if seen == "PATCH /v0/management/auth-files/status" {
			bWrites++
		}
	}
	requestsMu.Unlock()
	if aWrites != 0 || bWrites != 1 {
		t.Fatalf("credential write reached wrong source: A=%d B=%d", aWrites, bWrites)
	}
	// Rotation is authoritative centrally; no child retains the old login.
	rotated, err := security.NewAdminCredential("rotated-admin", "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SaveAdminCredential(ctx, rotated); err != nil {
		t.Fatal(err)
	}
	testutil.RequireStatus(t, request("GET", path+"/v0/management/config", "", "admin-secret"), 401)
	testutil.RequireStatus(t, request("GET", path+"/v0/management/config", "", "rotated-admin"), 200)
	stopCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := service.Close(stopCtx); err != nil {
		t.Fatal(err)
	}
	restarted := New(cfg, db, collector.NewManager(cfg, db))
	service2 := restarted.EnableCluster(protector)
	service2.Start(ctx)
	defer service2.Close(stopCtx)
	// A metadata save waits for startup, without polling or changing its key.
	if _, err := service2.Save(ctx, id, clustersvc.Input{Name: "B restored", BaseURL: b.URL, Enabled: false}); err != nil {
		t.Fatal(err)
	}
	items, err = service2.List(ctx)
	if err != nil || len(items) != 2 {
		t.Fatalf("restart registry: %v", err)
	}
	if _, err := service2.Save(ctx, id, clustersvc.Input{Name: "B restored", BaseURL: b.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	restored := testutil.Request(t, restarted.Handler(), "GET", "/tools/cpamp"+path+"/v0/management/config", "", "rotated-admin")
	testutil.RequireStatus(t, restored, 200)
}
