package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usagepricing"
	monitoring "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usageidentity"
)

func verifyMacBaselinePreservedWithoutRebuild(t *testing.T, count int, withDevin ...bool) {
	t.Helper()
	ctx := context.Background()
	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	const from int64 = 1_800_057_600_000
	exec(`with recursive ids(id) as (select 1 union all select id+1 from ids where id < ?)
		insert into usage_events(event_hash,timestamp_ms,timestamp,model,provider,auth_provider_snapshot,auth_file_snapshot,auth_index,auth_account_id_snapshot,account_snapshot,input_tokens,total_tokens,raw_json,created_at_ms)
		select printf('%064x',id),?+id,'2027-01-15T00:00:00Z','gpt-test','codex','codex',
		case when id%2=0 then 'codex-windows.json' else 'codex.json' end,
		case when id%2=0 then 'win' else 'mac' end,'workspace','same@example.com',30,30,'{"old":true}',?+id from ids`, count, from, from)
	oldKey, _ := usageidentity.HistoricalAccountKey(usageidentity.Fields{AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com"})
	// The retained total deliberately includes history no longer in raw rows.
	// Recalculation would lose this total, so the test must read it unchanged.
	const oldCalls int64 = 200000
	const oldTokens int64 = 6000000
	exec(`insert into usage_account_model_rollups(account_key,model,billing_model,service_tier,calls,success_calls,total_tokens,first_seen_ms,last_seen_ms,updated_at_ms)
		values (?,'gpt-test','gpt-test','',?,?,?,1,2,3)`, oldKey, oldCalls, oldCalls, oldTokens)
	revision, err := usagepricing.StructureRevision(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	exec(`insert into usage_pricing_account_rollups_v1(structure_revision,account_key,model,billing_model,pricing_model,service_tier,context_threshold_tokens,calls,success_calls,total_tokens,first_seen_ms,last_seen_ms,updated_at_ms)
		values (?,?,'gpt-test','gpt-test','gpt-test','',-1,?,?,?,1,2,3)`, revision, oldKey, oldCalls, oldCalls, oldTokens)
	exec(`insert into usage_rollup_checkpoints(name,last_event_id,updated_at_ms) values ('account_history',?,123) on conflict(name) do update set last_event_id=excluded.last_event_id,updated_at_ms=123`, count)
	exec(`update usage_pricing_rollup_state set structure_revision=?,status='ready',backfill_last_event_id=?,coverage_event_id=?,target_event_id=?,updated_at_ms=123 where rollup_name='pricing_v1'`, revision, count, count, count)
	exec(`update usage_monitoring_rollup_state set structure_revision=?,status='ready',backfill_last_event_id=?,coverage_event_id=?,target_event_id=?,updated_at_ms=123 where rollup_name='projection_v1'`, usageidentity.MonitoringProjectionStructureRevision(), count, count, count)
	exec(`delete from settings where key=?`, usageidentity.CredentialCutoverSetting)
	for _, table := range []string{"usage_events", "usage_account_model_rollups", "usage_pricing_account_rollups_v1"} {
		for _, operation := range []string{"update", "delete"} {
			condition := ""
			if len(withDevin) > 0 && withDevin[0] {
				condition = fmt.Sprintf("when old.account_key = '%s'", oldKey)
				if table == "usage_events" {
					condition = fmt.Sprintf("when old.provider = 'codex' and old.id <= %d", count)
				}
			}
			exec(fmt.Sprintf(`create trigger protect_%s_%s before %s on %s %s begin select raise(abort,'must not modify old history'); end`, table, operation, operation, table, condition))
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	st, err = store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("startup blocked: %s", elapsed)
	}
	var boundary int64
	if err := db.QueryRow(`select value from settings where key=?`, usageidentity.CredentialCutoverSetting).Scan(&boundary); err != nil || boundary != int64(count) {
		t.Fatalf("boundary=%d err=%v", boundary, err)
	}
	cp, err := st.AccountHistoryRollupCheckpoint(ctx)
	if err != nil || cp.LastEventID != int64(count) || cp.UpdatedAtMS != 123 {
		t.Fatalf("checkpoint reset: %+v %v", cp, err)
	}
	pricingState, err := st.UsagePricingState(ctx)
	if err != nil || pricingState.CoverageEventID != int64(count) || pricingState.Status != "ready" {
		t.Fatalf("pricing rebuild scheduled: %+v %v", pricingState, err)
	}
	projectionState, err := st.UsageMonitoringState(ctx, "projection_v1")
	if err != nil || projectionState.CoverageEventID != int64(count) || projectionState.Status != "ready" {
		t.Fatalf("projection rebuild scheduled: %+v %v", projectionState, err)
	}
	server := httptest.NewServer(New(cfg, st, collector.NewManager(cfg, st)).Handler())
	for _, path := range []string{"/health", "/management.html"} {
		resp, err := server.Client().Get(server.URL + path)
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatal(resp.StatusCode)
		}
	}
	server.Close()
	req := monitoring.AccountHistoryRequest{Accounts: []monitoring.AccountHistoryTarget{
		{RowKey: "mac", AuthFileSnapshot: "codex.json", AuthIndex: "mac", AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com"},
		{RowKey: "win", System: "windows", AuthFileSnapshot: "codex-windows.json", AuthIndex: "win", AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com"},
	}}
	check := func(macTokens, winTokens int64) {
		t.Helper()
		res, err := monitoring.New(st).AccountHistory(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Items) != 2 || res.Items[0].TotalTokens != macTokens || res.Items[1].TotalTokens != winTokens {
			t.Fatalf("history %+v", res)
		}
		if winTokens == 0 && (res.Items[1].TotalRequests != 0 || len(res.Items[1].RecentRequests) != 0) {
			t.Fatalf("Windows inherited old usage: %+v", res.Items[1])
		}
	}
	check(oldTokens, 0)
	for i, target := range req.Accounts {
		e := usage.Event{EventHash: canonicalCompatEventHash(fmt.Sprintf("new-%d", i)), TimestampMS: from + int64(count) + int64(i) + 1, Timestamp: "2027-01-15T00:00:01Z", Model: "gpt-test", Provider: "codex", AuthProviderSnapshot: "codex", AuthFileSnapshot: target.AuthFileSnapshot, AuthIndex: target.AuthIndex, AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com", InputTokens: int64(i+1) * 100, TotalTokens: int64(i+1) * 100}
		if _, err := st.InsertEvents(ctx, []usage.Event{e}); err != nil {
			t.Fatal(err)
		}
	}
	check(oldTokens+100, 200)
	for _, catchUp := range []func(context.Context, int, int64) error{
		func(c context.Context, n int, now int64) error {
			r, e := st.CatchUpAccountHistoryRollups(c, n, now)
			if r.Rebuilt || r.Processed != 2 {
				t.Fatalf("old history reprocessed: %+v", r)
			}
			return e
		},
		func(c context.Context, n int, now int64) error {
			r, e := st.CatchUpUsagePricing(c, n, now)
			if r.Rebuilt || r.Processed != 2 {
				t.Fatalf("old prices reprocessed: %+v", r)
			}
			return e
		},
	} {
		if err := catchUp(ctx, 100, time.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	check(oldTokens+100, 200)
	if len(withDevin) > 0 && withDevin[0] {
		// Reproduce the official Devin semantics upgrade beside an existing
		// Codex baseline whose full raw history is no longer retained.
		exec(`update usage_data_migrations set status='completed',last_event_id=0,target_event_id=0,processed_rows=0,changed_rows=0,applied_rows=0 where name='usage_cache_accounting_v2'`)
		exec(`insert into settings(key,value,updated_at_ms) values ('usage_cache_accounting_semantics_revision','1',0) on conflict(key) do update set value='1'`)
		for i, system := range []string{"mac", "windows"} {
			exec(`insert into usage_events(event_hash,timestamp_ms,timestamp,model,provider,executor_type,auth_provider_snapshot,auth_file_snapshot,auth_index,system,input_tokens,output_tokens,cached_tokens,cache_read_tokens,cache_input_mode,normalized_uncached_input_tokens,normalized_total_input_tokens,normalized_cache_read_tokens,normalized_cache_creation_tokens,total_tokens,raw_json,created_at_ms)
			values (?,?,'2027-01-15T00:00:01Z','devin-model','devin','DevinExecutor','devin','devin.json','devin-auth',?,100,5,80,80,'separate_from_input',100,180,80,0,105,'{"tokens":{"input_tokens":100,"output_tokens":5,"cached_tokens":80,"cache_read_tokens":80,"total_tokens":105}}',1)`, canonicalCompatEventHash(fmt.Sprintf("devin-%d", i)), from+int64(count)+3+int64(i), system)
		}
		if _, err := st.CatchUpAccountHistoryRollups(ctx, 100, time.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if _, err := st.CatchUpUsagePricing(ctx, 100, time.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if _, err := st.DiscoverUsageCacheAccounting(ctx); err != nil {
			t.Fatal(err)
		}
		live := httptest.NewServer(New(cfg, st, collector.NewManager(cfg, st)).Handler())
		defer func() { live.Close() }()
		probe := func() {
			t.Helper()
			for _, path := range []string{"/health", "/management.html"} {
				response, err := live.Client().Get(live.URL + path)
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				if response.StatusCode != http.StatusOK {
					t.Fatalf("listener unavailable during accounting update: %d", response.StatusCode)
				}
			}
		}
		probe()
		restarted := false
		for batch := 0; batch < count/256+100; batch++ {
			result, err := st.RunUsageCacheAccountingBatch(ctx, 256)
			if err != nil {
				t.Fatal(err)
			}
			if result.State.AppliedRows > 0 && !restarted {
				check(oldTokens+100, 200)
				probe()
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				if _, err := st.RunUsageCacheAccountingBatch(cancelled, 256); err == nil {
					t.Fatal("cancelled migration unexpectedly ran")
				}
				live.Close()
				if err := st.Close(); err != nil {
					t.Fatal(err)
				}
				st, err = store.Open(cfg.DBPath)
				if err != nil {
					t.Fatal(err)
				}
				live = httptest.NewServer(New(cfg, st, collector.NewManager(cfg, st)).Handler())
				probe()
				state, err := st.DiscoverUsageCacheAccounting(ctx)
				if err != nil || state.AppliedRows != result.State.AppliedRows {
					t.Fatalf("restart lost progress: %+v %v", state, err)
				}
				restarted = true
			}
			if result.Completed {
				break
			}
		}
		ready, err := st.UsageCacheAccountingMigrationReady(ctx)
		if err != nil || !ready || !restarted {
			t.Fatalf("migration did not resume and complete: ready=%v restarted=%v err=%v", ready, restarted, err)
		}
		check(oldTokens+100, 200)
		for i := 0; i < count/256+100; i++ {
			history, err := st.CatchUpAccountHistoryRollups(ctx, 256, time.Now().UnixMilli())
			if err != nil {
				t.Fatal(err)
			}
			pricing, err := st.CatchUpUsagePricing(ctx, 256, time.Now().UnixMilli())
			if err != nil {
				t.Fatal(err)
			}
			if !history.Pending && !pricing.Pending && !pricing.ContinueSoon {
				break
			}
		}
		check(oldTokens+100, 200)
		var remaining int
		if err := db.QueryRow(`select count(*) from usage_rollup_checkpoints where name like 'codex_baseline:%'`).Scan(&remaining); err != nil || remaining != 0 {
			t.Fatalf("completed rebuild retained preservation markers: %d %v", remaining, err)
		}
		var corrected int
		if err := db.QueryRow(`select count(*) from usage_events where provider='devin' and cache_input_mode='read_included_creation_separate' and normalized_total_input_tokens=100 and normalized_uncached_input_tokens=20 and total_tokens=105`).Scan(&corrected); err != nil || corrected != 2 {
			t.Fatalf("Devin correction failed: %d %v", corrected, err)
		}
		devin, err := monitoring.New(st).AccountHistory(ctx, monitoring.AccountHistoryRequest{Accounts: []monitoring.AccountHistoryTarget{
			{RowKey: "a", System: "mac", AuthFileSnapshot: "devin.json", AuthIndex: "devin-auth", AuthProviderSnapshot: "devin"},
			{RowKey: "b", System: "windows", AuthFileSnapshot: "devin.json", AuthIndex: "devin-auth", AuthProviderSnapshot: "devin"},
		}})
		if err != nil || len(devin.Items) != 2 {
			t.Fatalf("Devin history: %+v %v", devin, err)
		}
		for _, item := range devin.Items {
			if item.TotalRequests != 2 || item.TotalTokens != 210 {
				t.Fatalf("Devin was platform-split: %+v", item)
			}
		}
		live.Close()
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	check(oldTokens+100, 200)
	var actual int64
	if err := db.QueryRow(`select value from settings where key=?`, usageidentity.CredentialCutoverSetting).Scan(&actual); err != nil || actual != boundary {
		t.Fatalf("restart moved boundary: %d %v", actual, err)
	}
	for _, table := range []string{"usage_account_model_rollups", "usage_pricing_account_rollups_v1"} {
		var calls, tokens int64
		if err := db.QueryRow(`select calls,total_tokens from `+table+` where account_key=?`, oldKey).Scan(&calls, &tokens); err != nil || calls != oldCalls || tokens != oldTokens {
			t.Fatalf("%s baseline changed: %d/%d %v", table, calls, tokens, err)
		}
	}
	// CPA Panel and Full Docker share the same service response contract.
	body, _ := json.Marshal(req)
	rr := testutil.Request(t, New(cfg, st, collector.NewManager(cfg, st)).Handler(), http.MethodPost, "/v0/management/monitoring/account-history", string(body), testutil.AdminKey)
	testutil.RequireStatus(t, rr, 200)
}

func TestMacBaselinePreservesCheckpointsAndWindowsStartsEmpty(t *testing.T) {
	verifyMacBaselinePreservedWithoutRebuild(t, 1000)
}

func TestDevinAccountingPreservesCodexBaselineAcrossRestart(t *testing.T) {
	verifyMacBaselinePreservedWithoutRebuild(t, 1000, true)
}
