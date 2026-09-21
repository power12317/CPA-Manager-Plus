package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usagepricing"
	monitoring "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

func verifyCredentialHistoryUpgradeServesBeforeRebuildAndResumes(t *testing.T, count int) {
	t.Helper()
	totalTokens := int64(count/4*300 + count/4*3*30)
	const from = int64(1_800_057_600_000)
	ctx := context.Background()
	cfg := testutil.NewConfig(t)
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	testutil.EnsureAdminCredential(t, st)
	if err := st.SaveModelPrices(ctx, map[string]store.ModelPrice{"gpt-credential": {Prompt: 1, Completion: 2}}); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`with recursive ids(id) as (select 1 union all select id+1 from ids where id < ?)
		insert into usage_events (event_hash, timestamp_ms, timestamp, model, provider,
			auth_provider_snapshot, auth_file_snapshot, auth_index, auth_account_id_snapshot,
			account_snapshot, source, failed, input_tokens, normalized_total_input_tokens,
			output_tokens, total_tokens, raw_json, created_at_ms)
		select printf('%064x', id), ?+id, '2027-01-15T00:00:00Z', 'gpt-credential', 'codex', 'codex',
			case when id%4=0 then 'codex-windows.json' else 'codex-mac.json' end,
			case when id%4=0 then 'windows-index' else 'mac-index' end,
			'same-workspace', 'same@example.com', '', case when id%4=1 then 1 else 0 end,
			case when id%4=0 then 200 else 20 end, case when id%4=0 then 200 else 20 end,
			case when id%4=0 then 100 else 10 end, case when id%4=0 then 300 else 30 end,
			'{"immutable":true}', ?+id from ids`, count, from, from)
	// Seed the shared-member aggregate produced by the previous release.
	oldKey := fmt.Sprintf("usage-account-history:3:codex-member:%X:%X:%X", "codex", "same-workspace", "same@example.com")
	exec(`insert into usage_account_model_rollups
		(account_key, model, billing_model, service_tier, calls, total_tokens, first_seen_ms, last_seen_ms, updated_at_ms)
		values (?, 'gpt-credential', 'gpt-credential', '', ?, ?, ?, ?, 1)`, oldKey, count, totalTokens, from+1, from+int64(count))
	revision, err := usagepricing.StructureRevision(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	oldRevision := strings.ReplaceAll(revision, "codex-3", "codex-2")
	exec(`insert into usage_pricing_account_rollups_v1
		(structure_revision, account_key, model, billing_model, pricing_model, service_tier,
		context_threshold_tokens, calls, total_tokens, first_seen_ms, last_seen_ms, updated_at_ms)
		values (?, ?, 'gpt-credential', 'gpt-credential', 'gpt-credential', '', -1, ?, ?, ?, ?, 1)`, oldRevision, oldKey, count, totalTokens, from+1, from+int64(count))
	exec(`update usage_pricing_rollup_state set structure_revision=?, status='ready', coverage_event_id=?, backfill_last_event_id=?, target_event_id=? where rollup_name='pricing_v1'`, oldRevision, count, count, count)
	// Simulate an unfinished older cleanup job as well as the revision being upgraded.
	exec(`create table usage_account_model_rollups_legacy_identity_v3_codex_v2 (sentinel integer)`)
	exec(`insert into usage_account_model_rollups_legacy_identity_v3_codex_v2 values (1)`)
	if _, err := st.CatchUpUsageMonitoringProjection(ctx, 1000, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	exec(`update usage_monitoring_event_projection_v1 set account_key=?`, oldKey)
	exec(`update usage_monitoring_rollup_state set structure_revision='identity-3:codex-2:model-1:project-v1' where rollup_name='projection_v1'`)
	exec(`update settings set value='identity-3:codex-2:model-1' where key='usage_account_history_identity_format_version'`)
	exec(`insert into usage_rollup_checkpoints(name, last_event_id, updated_at_ms) values ('account_history', ?, 1) on conflict(name) do update set last_event_id=excluded.last_event_id`, count)
	exec(`create trigger reject_history_rewrite before update on usage_events begin select raise(abort, 'immutable history'); end`)
	exec(`create trigger reject_history_delete before delete on usage_events begin select raise(abort, 'immutable history'); end`)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	st, err = store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("%d-row metadata migration blocked startup for %s", count, elapsed)
	}
	state, err := st.UsageMonitoringState(ctx, "projection_v1")
	if err != nil || state.CoverageEventID != 0 || state.TargetEventID != int64(count) {
		t.Fatalf("projection not scheduled: %+v %v", state, err)
	}
	checkpoint, err := st.AccountHistoryRollupCheckpoint(ctx)
	if err != nil || checkpoint.LastEventID != 0 {
		t.Fatalf("history not scheduled: %+v %v", checkpoint, err)
	}

	request := monitoring.AccountHistoryRequest{Accounts: []monitoring.AccountHistoryTarget{
		{RowKey: "mac", AuthFileSnapshot: "codex-mac.json", AuthIndex: "mac-index", AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "same-workspace", AccountSnapshot: "same@example.com"},
		{RowKey: "windows", AuthFileSnapshot: "codex-windows.json", AuthIndex: "windows-index", AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "same-workspace", AccountSnapshot: "same@example.com"},
	}}
	assertHistory := func(phase string) {
		t.Helper()
		result, err := monitoring.New(st).AccountHistory(ctx, request)
		if err != nil || len(result.Items) != 2 {
			t.Fatalf("%s: %+v %v", phase, result, err)
		}
		for i, want := range []struct {
			calls, success, tokens int64
			cost                   float64
		}{
			{int64(count * 3 / 4), int64(count / 2), int64(count * 3 / 4 * 30), float64(count*3/4) * 40 / 1_000_000},
			{int64(count / 4), int64(count / 4), int64(count / 4 * 300), float64(count/4) * 400 / 1_000_000},
		} {
			item := result.Items[i]
			if !item.Matched || item.TotalRequests != want.calls || item.SuccessCalls != want.success || item.FailureCalls != want.calls-want.success || item.TotalTokens != want.tokens || math.Abs(item.TotalCost-want.cost) > 1e-9 {
				t.Fatalf("%s: credential %d got %+v", phase, i, item)
			}
		}
	}
	// Start a real listener while every derived checkpoint is still incomplete.
	server := httptest.NewServer(New(cfg, st, collector.NewManager(cfg, st)).Handler())
	client := &http.Client{Timeout: 10 * time.Second}
	for _, path := range []string{"/health", "/management.html"} {
		response, err := client.Get(server.URL + path)
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			server.Close()
			t.Fatalf("startup %s: %d", path, response.StatusCode)
		}
	}
	// The fallback intentionally scans 100k rows. Race-instrumented SQLite is
	// much slower than production; keep the strict deadline above for startup
	// endpoints without treating instrumentation overhead as a read failure.
	client.Timeout = time.Minute
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	httpRequest, err := http.NewRequest(http.MethodPost, server.URL+"/v0/management/monitoring/account-history", strings.NewReader(string(payload)))
	if err != nil {
		t.Fatal(err)
	}
	httpRequest.Header.Set("Authorization", "Bearer "+testutil.AdminKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := client.Do(httpRequest)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	var responseBody monitoring.AccountHistoryResponse
	decodeErr := json.NewDecoder(response.Body).Decode(&responseBody)
	_ = response.Body.Close()
	server.Close()
	if response.StatusCode != http.StatusOK || decodeErr != nil || len(responseBody.Items) != 2 || responseBody.Items[0].TotalRequests != int64(count*3/4) || responseBody.Items[1].TotalRequests != int64(count/4) {
		t.Fatalf("history unavailable before rebuild: status=%d body=%+v err=%v", response.StatusCode, responseBody, decodeErr)
	}
	assertHistory("before first batch")
	if _, err := st.CatchUpAccountHistoryRollups(ctx, 1000, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CatchUpUsagePricing(ctx, 1000, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CatchUpUsageMonitoringProjection(ctx, 1000, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	before, err := st.AccountHistoryRollupCheckpoint(ctx)
	if err != nil || before.LastEventID != 1000 {
		t.Fatalf("first batch=%+v %v", before, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := st.CatchUpAccountHistoryRollups(cancelled, 1000, time.Now().UnixMilli()); err == nil {
		t.Fatal("cancelled rebuild succeeded")
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	after, err := st.AccountHistoryRollupCheckpoint(ctx)
	if err != nil || after.LastEventID != before.LastEventID {
		t.Fatalf("checkpoint lost on restart: before=%+v after=%+v err=%v", before, after, err)
	}
	assertHistory("after interrupted rebuild and restart")
	for batch := 0; ; batch++ {
		if batch > count/1000+5 {
			t.Fatal("rebuild failed to converge")
		}
		r, err := st.CatchUpAccountHistoryRollups(ctx, 1000, time.Now().UnixMilli())
		if err != nil {
			t.Fatal(err)
		}
		p, err := st.CatchUpUsagePricing(ctx, 1000, time.Now().UnixMilli())
		if err != nil {
			t.Fatal(err)
		}
		m, err := st.CatchUpUsageMonitoringProjection(ctx, 1000, time.Now().UnixMilli())
		if err != nil {
			t.Fatal(err)
		}
		if !r.Pending && !p.Pending && !m.Pending {
			break
		}
	}
	assertHistory("after rebuild completion")
	var actualCount, tokens int64
	if err := db.QueryRow(`select count(*), sum(total_tokens) from usage_events where raw_json='{"immutable":true}'`).Scan(&actualCount, &tokens); err != nil || actualCount != int64(count) || tokens != totalTokens {
		t.Fatalf("raw history changed: count=%d tokens=%d err=%v", actualCount, tokens, err)
	}
}
