package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

func newIndexedCodexRecoveryFixture(t *testing.T) (config.Config, *store.Store, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)
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
	// Production databases have these indexes before f0fcb9f5. The original
	// recovery fixture omitted this post-listener startup phase entirely.
	if err := st.RunDerivedStartupMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	before, err := st.DerivedMaintenanceStatus(ctx)
	if err != nil || before.Required {
		t.Fatalf("pre-upgrade database is not healthy: %+v %v", before, err)
	}
	var schema string
	if err := db.QueryRow(`select sql from sqlite_master where name='usage_account_model_rollups'`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	exec(`insert into usage_account_model_rollups(account_key,model,billing_model,service_tier,calls,first_seen_ms,last_seen_ms,updated_at_ms) values ('old-account','model','model','',100,1,2,3)`)
	// f0fcb9f5 parks the v2 table; SQLite carries both named indexes with it.
	exec(`alter table usage_account_model_rollups rename to usage_account_model_rollups_legacy_identity_v3_codex_v3`)
	exec(schema)
	exec(`update settings set value='identity-3:codex-3:model-1' where key='usage_account_history_identity_format_version'`)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	// a02947dc repairs the identity and creates the current table, but leaves
	// those same two index names on the pre-f0 snapshot.
	pending, err := st.DerivedMaintenanceStatus(ctx)
	if err != nil || pending.DeferredIndexes != 2 {
		t.Fatalf("reproduction expected exactly two missing indexes: %+v %v", pending, err)
	}
	return cfg, st, db
}

func TestCodexRecoveryRestoresIndexesParkedByF0(t *testing.T) {
	_, st, _ := newIndexedCodexRecoveryFixture(t)
	ctx := context.Background()
	if err := st.RunDerivedStartupMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := st.DerivedMaintenanceStatus(ctx)
	if err != nil || after.Required || after.PerformanceDegraded {
		t.Fatalf("Codex recovery left the database degraded: %+v %v", after, err)
	}
}

func verifyCompletedCodexRecoveryIndexRepair(t *testing.T, count int) {
	t.Helper()
	ctx := context.Background()
	cfg, st, db := newIndexedCodexRecoveryFixture(t)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	// The user already finished a02947dc. Keep the corrected totals and all
	// checkpoints: this follow-up must repair indexes, never rerun that recovery.
	exec(`update usage_data_migrations set status='completed',finished_at_ms=42 where name='codex_identity_v3_recovery'`)
	for _, name := range []string{"idx_usage_account_model_rollups_last_seen", "idx_usage_account_model_rollups_auth_index"} {
		exec(`insert into usage_derived_deferred_indexes(index_name,table_name,reason,created_at_ms,updated_at_ms) values (?,'usage_account_model_rollups','legacy_index_replacement',1,1)`, name)
	}
	exec(`insert into usage_rollup_checkpoints(name,last_event_id,updated_at_ms) values ('account_history',987654,123) on conflict(name) do update set last_event_id=987654,updated_at_ms=123`)
	exec(`insert into settings(key,value,updated_at_ms) values ('index-repair-test','preserve-settings',123)`)
	exec(`with recursive ids(id) as (select 1 union all select id+1 from ids where id < ?)
		insert into usage_events(event_hash,timestamp_ms,timestamp,model,total_tokens,raw_json,created_at_ms)
		select printf('%064x',id),id,'2026-09-21T00:00:00Z','model',100,'{"preserve":true}',id from ids`, count)
	exec(`with recursive ids(id) as (select 1 union all select id+1 from ids where id < ?)
		insert into usage_account_model_rollups(account_key,auth_index,model,billing_model,service_tier,calls,total_tokens,first_seen_ms,last_seen_ms,updated_at_ms)
		select 'account-'||id,'auth-'||id,'model','model','',42,4200,id,id,id from ids`, count)
	exec(`insert into usage_account_model_rollups_legacy_identity_v3_codex_v3 select * from usage_account_model_rollups`)
	for _, table := range []string{"usage_events", "usage_account_model_rollups", "usage_account_model_rollups_legacy_identity_v3_codex_v3"} {
		for _, operation := range []string{"update", "delete"} {
			exec(fmt.Sprintf(`create trigger preserve_%s_%s before %s on %s begin select raise(abort,'index repair must not alter rows'); end`, table, operation, operation, table))
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("index repair blocked pre-listener startup: %s", elapsed)
	}
	pending, err := st.DerivedMaintenanceStatus(ctx)
	if err != nil || pending.DeferredIndexes != 2 {
		t.Fatalf("indexes changed before listener: %+v %v", pending, err)
	}
	server := httptest.NewServer(New(cfg, st, collector.NewManager(cfg, st)).Handler())
	defer server.Close()
	client := &http.Client{Timeout: 2 * time.Second}
	checkHTTP := func() {
		t.Helper()
		for _, path := range []string{"/health", "/management.html"} {
			response, err := client.Get(server.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("%s unavailable during index repair: %d", path, response.StatusCode)
			}
		}
	}
	checkHTTP()
	finished := make(chan error, 1)
	go func() { finished <- st.RunDerivedStartupMaintenance(ctx) }()
	checkHTTP()
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	after, err := st.DerivedMaintenanceStatus(ctx)
	if err != nil || after.Required || after.DeferredIndexes != 0 || after.PerformanceDegraded || after.Command != "" {
		t.Fatalf("repair did not clear real maintenance state: %+v %v", after, err)
	}
	var deferred int
	if err := db.QueryRow(`select count(*) from usage_derived_deferred_indexes`).Scan(&deferred); err != nil || deferred != 0 {
		t.Fatalf("stale deferred index ledger remains: %d %v", deferred, err)
	}
	for _, index := range []struct{ name, column string }{
		{"idx_usage_account_model_rollups_last_seen", "last_seen_ms"},
		{"idx_usage_account_model_rollups_auth_index", "auth_index"},
	} {
		var table, column string
		if err := db.QueryRow(`select tbl_name from sqlite_master where name=?`, index.name).Scan(&table); err != nil || table != "usage_account_model_rollups" {
			t.Fatalf("index %s still targets %s: %v", index.name, table, err)
		}
		if err := db.QueryRow(`select name from pragma_index_info(?)`, index.name).Scan(&column); err != nil || column != index.column {
			t.Fatalf("index %s definition changed: %s %v", index.name, column, err)
		}
		var id, parent, unused int
		var plan string
		if err := db.QueryRow(`explain query plan select account_key from usage_account_model_rollups where `+index.column+`=?`, 1).Scan(&id, &parent, &unused, &plan); err != nil || !strings.Contains(plan, index.name) {
			t.Fatalf("query does not use restored index %s: %s %v", index.name, plan, err)
		}
	}
	var rows, calls, tokens int64
	if err := db.QueryRow(`select count(*),sum(calls),sum(total_tokens) from usage_account_model_rollups`).Scan(&rows, &calls, &tokens); err != nil || rows != int64(count) || calls != int64(count)*42 || tokens != int64(count)*4200 {
		t.Fatalf("corrected totals changed: %d %d %d %v", rows, calls, tokens, err)
	}
	if err := db.QueryRow(`select count(*),sum(total_tokens) from usage_events where raw_json='{"preserve":true}'`).Scan(&rows, &tokens); err != nil || rows != int64(count) || tokens != int64(count)*100 {
		t.Fatalf("raw requests changed: %d %d %v", rows, tokens, err)
	}
	if err := db.QueryRow(`select count(*),sum(calls) from usage_account_model_rollups_legacy_identity_v3_codex_v3`).Scan(&rows, &calls); err != nil || rows != int64(count)+1 || calls != int64(count)*42+100 {
		t.Fatalf("pre-f0 snapshot changed: %d %d %v", rows, calls, err)
	}
	cp, err := st.AccountHistoryRollupCheckpoint(ctx)
	if err != nil || cp.LastEventID != 987654 || cp.UpdatedAtMS != 123 {
		t.Fatalf("history rebuild was rescheduled: %+v %v", cp, err)
	}
	var recoveryState string
	var finishedAt int64
	if err := db.QueryRow(`select status,finished_at_ms from usage_data_migrations where name='codex_identity_v3_recovery'`).Scan(&recoveryState, &finishedAt); err != nil || recoveryState != "completed" || finishedAt != 42 {
		t.Fatalf("completed data recovery was changed: %s %d %v", recoveryState, finishedAt, err)
	}
	var setting string
	if err := db.QueryRow(`select value from settings where key='index-repair-test'`).Scan(&setting); err != nil || setting != "preserve-settings" {
		t.Fatalf("settings changed: %s %v", setting, err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.RunDerivedStartupMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	after, err = st.DerivedMaintenanceStatus(ctx)
	if err != nil || after.Required {
		t.Fatalf("maintenance warning returned after restart: %+v %v", after, err)
	}
}

func TestCompletedCodexRecoveryIndexRepair(t *testing.T) {
	verifyCompletedCodexRecoveryIndexRepair(t, 1000)
}
