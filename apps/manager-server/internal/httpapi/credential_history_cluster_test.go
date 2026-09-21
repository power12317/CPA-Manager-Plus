package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	clustersvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cluster"
	monitoring "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestClusterHistorySeparatesInstancesAndCodexSystems(t *testing.T) {
	ctx := context.Background()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"usage-statistics-enabled":true,"items":[],"files":[]}`)
	}))
	defer upstream.Close()
	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)
	disabled := false
	if err := st.SaveManagerConfig(ctx, model.ManagerConfig{
		CPAConnection: model.ManagerCPAConnectionConfig{CPABaseURL: upstream.URL + "/a", ManagementKey: "test-cpa-key"},
		Collector:     model.ManagerCollectorConfig{Enabled: &disabled},
	}); err != nil {
		t.Fatal(err)
	}
	protector, err := security.NewProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	server := New(cfg, st, collector.NewManager(cfg, st))
	cluster := server.EnableCluster(protector)
	cluster.Start(ctx)
	t.Cleanup(func() { _ = cluster.Close(ctx) })
	id, err := cluster.Save(ctx, "", clustersvc.Input{Name: "B", BaseURL: upstream.URL + "/b", ManagementKey: "test-cpa-key", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	child, err := cluster.Runtime(id)
	if err != nil {
		t.Fatal(err)
	}
	childStore := child.(*instanceRuntime).server.appCtx.Store
	const from = int64(1_800_057_600_000)
	makeEvent := func(system string, tokens int64) usage.Event {
		return usage.Event{
			EventHash: canonicalCompatEventHash(fmt.Sprintf("%s-%d", system, tokens)), TimestampMS: from + tokens,
			Timestamp: time.UnixMilli(from + tokens).UTC().Format(time.RFC3339Nano), CreatedAtMS: from + tokens,
			Model: "gpt-credential", Provider: "codex", AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "same-workspace",
			AccountSnapshot: "same@example.com", AuthFileSnapshot: "codex-" + system + ".json", AuthIndex: system + "-index",
			System: system, InputTokens: tokens, TotalTokens: tokens,
		}
	}
	if _, err := st.InsertEvents(ctx, []usage.Event{makeEvent("mac", 10), makeEvent("windows", 20)}); err != nil {
		t.Fatal(err)
	}
	if _, err := childStore.InsertEvents(ctx, []usage.Event{makeEvent("mac", 100), makeEvent("windows", 200)}); err != nil {
		t.Fatal(err)
	}
	historyRequest := monitoring.AccountHistoryRequest{}
	windowRequest := monitoring.AccountWindowUsageRequest{}
	for _, instance := range []string{"default", id} {
		for _, system := range []string{"mac", "windows"} {
			row := instance + "/" + system
			file := "@cpamp/" + instance + "/codex-" + system + ".json"
			index := "@cpamp/" + instance + "/" + system + "-index"
			historyRequest.Accounts = append(historyRequest.Accounts, monitoring.AccountHistoryTarget{
				RowKey: row, AuthFileSnapshot: file, AuthIndex: index, AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "same-workspace", AccountSnapshot: "same@example.com",
			})
			windowRequest.Windows = append(windowRequest.Windows, monitoring.AccountWindowUsageTarget{
				RowKey: row, ProviderWindowID: "primary", Period: "current", FromMS: from, ToMS: from + 86_400_000,
				ModelScope:       monitoring.AccountWindowModelScope{Kind: "all", Complete: true},
				AuthFileSnapshot: file, AuthIndex: index, AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "same-workspace", AccountSnapshot: "same@example.com",
			})
		}
	}
	for _, query := range []struct {
		path    string
		request any
	}{
		{"account-history", historyRequest}, {"account-window-usage", windowRequest},
	} {
		body, err := json.Marshal(query.request)
		if err != nil {
			t.Fatal(err)
		}
		response := testutil.Request(t, server.Handler(), http.MethodPost, "/api/aggregate/v0/management/monitoring/"+query.path, string(body), testutil.AdminKey)
		testutil.RequireStatus(t, response, http.StatusOK)
		var result struct {
			Items []struct {
				RowKey        string `json:"row_key"`
				TotalRequests int64  `json:"total_requests"`
				TotalTokens   int64  `json:"total_tokens"`
			} `json:"items"`
		}
		testutil.DecodeJSON(t, response, &result)
		want := map[string]int64{"default/mac": 10, "default/windows": 20, id + "/mac": 100, id + "/windows": 200}
		if len(result.Items) != len(want) {
			t.Fatalf("%s: %+v", query.path, result)
		}
		for _, item := range result.Items {
			if tokens, ok := want[item.RowKey]; !ok || item.TotalRequests != 1 || item.TotalTokens != tokens {
				t.Fatalf("%s: merged credential %+v", query.path, item)
			}
			delete(want, item.RowKey)
		}
	}
}
