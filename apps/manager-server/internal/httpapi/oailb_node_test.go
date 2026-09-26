package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestOailbNodeSurvivesRawProjectionAndMonitoringAPI(t *testing.T) {
	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)
	ctx := context.Background()
	for i, node := range []string{"unified-96", "", "chat.gateway.unified-96.api.openai.com"} {
		raw, _ := json.Marshal(map[string]any{
			"timestamp": time.UnixMilli(1_790_424_000_000 + int64(i)).UTC().Format(time.RFC3339Nano),
			"model":     "gpt-test", "provider": "codex", "oailb_node": node, "total_tokens": 3,
		})
		event, err := usage.NormalizeRaw(raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.InsertEvents(ctx, []usage.Event{event}); err != nil {
			t.Fatal(err)
		}
	}
	filter := store.AnalyticsFilter{FromMS: 1_790_424_000_000, ToMS: 1_790_424_100_000}
	checkPage := func(page store.EventsPage) {
		t.Helper()
		if len(page.Items) != 3 {
			t.Fatalf("page count=%d", len(page.Items))
		}
		if page.Items[0].OailbNode != "" || page.Items[1].OailbNode != "" || page.Items[2].OailbNode != "unified-96" {
			t.Fatalf("nodes=%q/%q/%q", page.Items[0].OailbNode, page.Items[1].OailbNode, page.Items[2].OailbNode)
		}
	}
	page, err := st.EventsPageWithFilter(ctx, filter, 0, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	checkPage(page)
	for phase := 0; phase < 2; phase++ {
		page, _, available, err := st.UsageMonitoringEventsPage(ctx, filter, 0, 0, 10)
		if err != nil || !available {
			t.Fatalf("projection phase=%d available=%v err=%v", phase, available, err)
		}
		checkPage(page)
		if _, err := st.CatchUpUsageMonitoringProjection(ctx, 10, time.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	handler := New(cfg, st, collector.NewManager(cfg, st)).Handler()
	response := testutil.Request(t, handler, http.MethodPost, "/v0/management/monitoring/analytics",
		`{"from_ms":1790424000000,"to_ms":1790424100000,"include":{"events_page":{"limit":10}}}`, testutil.AdminKey)
	testutil.RequireStatus(t, response, http.StatusOK)
	var body struct {
		Events struct {
			Items []map[string]any `json:"items"`
		} `json:"events"`
	}
	testutil.DecodeJSON(t, response, &body)
	if len(body.Events.Items) != 3 || body.Events.Items[2]["oailb_node"] != "unified-96" {
		t.Fatalf("API body=%s", response.Body.String())
	}
	for _, item := range body.Events.Items[:2] {
		if _, present := item["oailb_node"]; present {
			t.Fatalf("empty/invalid node leaked: %+v", item)
		}
	}
	if strings.Contains(response.Body.String(), "chat.gateway") {
		t.Fatal("full host leaked")
	}
}

func TestOailbNodeUpgrade100kIsBoundedAndRestartSafe(t *testing.T) {
	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	exec := func(query string) {
		t.Helper()
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	// Build a pre-feature database, then simulate a rolled-back schema transaction.
	exec(`alter table usage_events drop column oailb_node`)
	exec(`with recursive ids(id) as (select 1 union all select id+1 from ids where id<100000)
		insert into usage_events(event_hash,timestamp_ms,timestamp,model,input_tokens,total_tokens,raw_json,created_at_ms)
		select printf('%064x',id),1790424000000+id,'2026-09-26T12:00:00Z','gpt-test',3,3,'{"legacy":true}',id from ids`)
	exec(`create trigger protect_oailb_upgrade_updates before update on usage_events begin select raise(abort,'must not rewrite history'); end`)
	exec(`create trigger protect_oailb_upgrade_deletes before delete on usage_events begin select raise(abort,'must not delete history'); end`)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`alter table usage_events add column oailb_node text`); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		started := time.Now()
		opened, err := store.Open(cfg.DBPath)
		if err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(started); elapsed > 10*time.Second {
			_ = opened.Close()
			t.Fatalf("metadata startup took %s", elapsed)
		}
		// No workers or historical rebuild need to finish for HTTP to serve.
		server := httptest.NewServer(New(cfg, opened, collector.NewManager(cfg, opened)).Handler())
		for _, path := range []string{"/health", "/management.html"} {
			response, err := server.Client().Get(server.URL + path)
			if err != nil {
				server.Close()
				_ = opened.Close()
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK {
				server.Close()
				_ = opened.Close()
				t.Fatalf("%s status=%d", path, response.StatusCode)
			}
		}
		server.Close()
		if err := opened.Close(); err != nil {
			t.Fatal(err)
		}
		var count, unchanged, total, nodes int64
		if err := db.QueryRow(`select count(*), sum(raw_json='{"legacy":true}'), sum(total_tokens), count(oailb_node) from usage_events`).Scan(&count, &unchanged, &total, &nodes); err != nil {
			t.Fatal(err)
		}
		if count != 100000 || unchanged != count || total != 300000 || nodes != 0 {
			t.Fatalf("history changed: %d/%d/%d nodes=%d", count, unchanged, total, nodes)
		}
	}
}
