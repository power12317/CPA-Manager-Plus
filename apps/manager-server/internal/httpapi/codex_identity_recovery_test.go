package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/usagepricing"
	monitoring "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

// The fixture reproduces the persisted f0fcb9f5 format. Both fully rebuilt and
// interrupted databases must recover through the same one-time transition.
func verifyRejectedCodexRecovery(t *testing.T, count, coverage int) {
	t.Helper()
	ctx := context.Background()
	cfg := testutil.NewConfig(t)
	st := testutil.NewStore(t, cfg)
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := st.RunDerivedStartupMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	const from int64 = 1_800_057_600_000
	if err := st.SaveModelPrices(ctx, map[string]store.ModelPrice{"gpt-recovery": {Prompt: 1}}); err != nil {
		t.Fatal(err)
	}
	exec(`with recursive ids(id) as (select 1 union all select id+1 from ids where id < ?)
		insert into usage_events(event_hash,timestamp_ms,timestamp,model,provider,auth_provider_snapshot,auth_file_snapshot,auth_index,auth_account_id_snapshot,account_snapshot,input_tokens,normalized_total_input_tokens,total_tokens,raw_json,created_at_ms)
		select printf('%064x',id),?+id,'2027-01-15T00:00:00Z','gpt-recovery','codex','codex',
		case when id%2=0 then 'codex-windows.json' else 'codex.json' end,
		case when id%2=0 then 'windows' else 'mac' end,'workspace','same@example.com',10,10,10,'{"original":true}',?+id from ids`, count, from, from)
	// Materialize physical-credential keys, then stamp the actual rejected v3
	// revisions. coverage controls how far each interrupted worker got.
	if _, err := st.CatchUpAccountHistoryRollups(ctx, coverage, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CatchUpUsagePricing(ctx, coverage, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CatchUpUsageMonitoringProjection(ctx, coverage, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CatchUpUsageMonitoringStats(ctx, coverage, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"usage_pricing_rollup_state", "usage_pricing_account_rollups_v1", "usage_pricing_hourly_rollups_v1", "usage_monitoring_rollup_state", "usage_monitoring_account_daily_rollups_v1", "usage_monitoring_api_key_daily_rollups_v1"} {
		exec(`update ` + table + ` set structure_revision=replace(structure_revision,':codex-2:',':codex-3:')`)
	}
	exec(`update settings set value='identity-3:codex-3:model-1' where key='usage_account_history_identity_format_version'`)
	exec(`delete from settings where key='codex_credential_history_start_after_id'`)
	// An existing pre-f0 snapshot must not block recovery or be overwritten.
	exec(`create table usage_account_model_rollups_legacy_identity_v3_codex_v3 (sentinel text)`)
	exec(`insert into usage_account_model_rollups_legacy_identity_v3_codex_v3 values ('preserve-original-snapshot')`)
	exec(`insert into settings(key,value,updated_at_ms) values ('unrelated_configuration','{"device-convergence":false,"ticket":true}',42)`)
	readSettings := func() map[string]string {
		t.Helper()
		rows, err := db.Query(`select key,value from settings where key not in ('usage_account_history_identity_format_version','codex_credential_history_start_after_id') order by key`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		result := map[string]string{}
		for rows.Next() {
			var key, value string
			if err := rows.Scan(&key, &value); err != nil {
				t.Fatal(err)
			}
			result[key] = value
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return result
	}
	wantSettings := readSettings()
	exec(`create trigger preserve_raw_update before update on usage_events begin select raise(abort,'raw history must remain immutable'); end`)
	exec(`create trigger preserve_raw_delete before delete on usage_events begin select raise(abort,'raw history must remain immutable'); end`)
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	st, err = store.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("f0fcb9f5 database cannot start: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("pre-listener recovery blocked startup: %s", elapsed)
	}
	var revision, status string
	var repaired, target int64
	if err := db.QueryRow(`select value from settings where key='usage_account_history_identity_format_version'`).Scan(&revision); err != nil || revision != "identity-3:codex-2:model-1" {
		t.Fatalf("revision=%q %v", revision, err)
	}
	if err := db.QueryRow(`select status,last_event_id,target_event_id from usage_data_migrations where name=?`, sqliterepo.CodexIdentityRecoveryName).Scan(&status, &repaired, &target); err != nil || status != "pending" || repaired != 0 || target != int64(count) {
		t.Fatalf("recovery not pending: %s %d/%d %v", status, repaired, target, err)
	}
	if got := readSettings(); !reflect.DeepEqual(got, wantSettings) {
		t.Fatalf("unrelated settings changed: got=%v want=%v", got, wantSettings)
	}
	server := httptest.NewServer(New(cfg, st, collector.NewManager(cfg, st)).Handler())
	client := &http.Client{Timeout: 5 * time.Second}
	for _, path := range []string{"/health", "/management.html", "/usage-service/info"} {
		response, err := client.Get(server.URL + path)
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("startup %s=%d", path, response.StatusCode)
		}
	}
	server.Close()
	if err := st.RunDerivedStartupMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	request := monitoring.AccountHistoryRequest{Accounts: []monitoring.AccountHistoryTarget{
		{RowKey: "mac", AuthFileSnapshot: "codex.json", AuthIndex: "mac", AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com"},
		{RowKey: "windows", System: "windows", AuthFileSnapshot: "codex-windows.json", AuthIndex: "windows", AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com"},
	}}
	checkHistory := func(newWindows bool) {
		t.Helper()
		res, err := monitoring.New(st).AccountHistory(ctx, request)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Items) != 2 || res.Items[0].TotalRequests != int64(count) || res.Items[0].TotalTokens != int64(count)*10 || math.Abs(res.Items[0].TotalCost-float64(count)*10/1e6) > 1e-9 {
			t.Fatalf("Mac history=%+v", res)
		}
		wantCalls, wantTokens := int64(0), int64(0)
		if newWindows {
			wantCalls, wantTokens = 1, 100
		}
		if res.Items[1].TotalRequests != wantCalls || res.Items[1].TotalTokens != wantTokens {
			t.Fatalf("Windows inherited rejected history: %+v", res.Items[1])
		}
	}
	checkHistory(false)
	// Failure must leave the checkpoint intact and be resumable without another
	// schema migration. Normal worker error reporting feeds the recovery journal.
	exec(`create trigger fail_projection_repair before update on usage_monitoring_event_projection_v1 begin select raise(abort,'injected repair failure'); end`)
	_, failure := st.CatchUpUsageMonitoringProjection(ctx, 50, time.Now().UnixMilli())
	if failure == nil {
		t.Fatal("injected repair failure was ignored")
	}
	if err := st.RecordUsageMonitoringFailure(ctx, "projection_v1", failure, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := st.CheckCodexIdentityRecoveryProgress(ctx); err != nil {
		t.Fatal(err)
	}
	var recordedFailure string
	if err := db.QueryRow(`select last_error from usage_data_migrations where name=?`, sqliterepo.CodexIdentityRecoveryName).Scan(&recordedFailure); err != nil || !strings.Contains(recordedFailure, "injected repair failure") {
		t.Fatalf("recovery failure not recorded: %q %v", recordedFailure, err)
	}
	exec(`drop trigger fail_projection_repair`)
	runBatch := func(limit int) {
		t.Helper()
		now := time.Now().UnixMilli()
		if _, err := st.CatchUpAccountHistoryRollups(ctx, limit, now); err != nil {
			t.Fatal(err)
		}
		if _, err := st.CatchUpUsagePricing(ctx, limit, now); err != nil {
			t.Fatal(err)
		}
		if _, err := st.CatchUpUsageMonitoringProjection(ctx, limit, now); err != nil {
			t.Fatal(err)
		}
		if _, err := st.CatchUpUsageMonitoringStats(ctx, limit, now); err != nil {
			t.Fatal(err)
		}
		if err := st.CheckCodexIdentityRecoveryProgress(ctx); err != nil {
			t.Fatal(err)
		}
	}
	runBatch(50)
	cp, err := st.AccountHistoryRollupCheckpoint(ctx)
	if err != nil || cp.LastEventID != 50 {
		t.Fatalf("checkpoint=%+v %v", cp, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := st.CatchUpAccountHistoryRollups(cancelled, 50, time.Now().UnixMilli()); err == nil {
		t.Fatal("cancelled recovery succeeded")
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	resumed, err := st.AccountHistoryRollupCheckpoint(ctx)
	if err != nil || resumed.LastEventID != cp.LastEventID {
		t.Fatalf("restart reset recovery: %+v %v", resumed, err)
	}
	checkHistory(false)
	if _, err := st.InsertEvents(ctx, []usage.Event{{EventHash: canonicalCompatEventHash("new-windows-after-recovery"), TimestampMS: from + int64(count) + 1, Timestamp: "2027-01-15T01:00:00Z", Model: "gpt-recovery", Provider: "codex", AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com", AuthFileSnapshot: "codex-windows.json", AuthIndex: "windows", System: "windows", InputTokens: 100, TotalTokens: 100}}); err != nil {
		t.Fatal(err)
	}
	checkHistory(true)
	for batch := 0; ; batch++ {
		if batch > count/1000+10 {
			t.Fatal("recovery did not complete")
		}
		runBatch(1000)
		if err := db.QueryRow(`select status from usage_data_migrations where name=?`, sqliterepo.CodexIdentityRecoveryName).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == "completed" {
			break
		}
	}
	runBatch(1000)
	checkHistory(true)
	maintenance, err := st.DerivedMaintenanceStatus(ctx)
	if err != nil || maintenance.Required {
		t.Fatalf("recovered database still requires maintenance: %+v %v", maintenance, err)
	}
	// Assert corrected active derivations, not merely a relabeled version.
	var badKeys int
	if err := db.QueryRow(`select count(*) from usage_monitoring_event_projection_v1 where event_id<=? and account_key like '%:codex-credential:%'`, count).Scan(&badKeys); err != nil || badKeys != 0 {
		t.Fatalf("rejected projection keys remain: %d %v", badKeys, err)
	}
	for _, table := range []string{"usage_account_model_rollups", "usage_pricing_account_rollups_v1"} {
		var calls int64
		where := "account_key like '%:codex-member:%'"
		if strings.Contains(table, "pricing") {
			priceRevision, err := usagepricing.StructureRevision(ctx, db)
			if err != nil {
				t.Fatal(err)
			}
			where += fmt.Sprintf(" and structure_revision='%s'", priceRevision)
		}
		if err := db.QueryRow(`select coalesce(sum(calls),0) from ` + table + ` where ` + where).Scan(&calls); err != nil || calls != int64(count) {
			t.Fatalf("%s not restored: calls=%d %v", table, calls, err)
		}
	}
	if got := readSettings(); !reflect.DeepEqual(got, wantSettings) {
		t.Fatal("recovery changed unrelated settings")
	}
	var originalSnapshot string
	if err := db.QueryRow(`select sentinel from usage_account_model_rollups_legacy_identity_v3_codex_v3`).Scan(&originalSnapshot); err != nil || originalSnapshot != "preserve-original-snapshot" {
		t.Fatalf("original snapshot changed: %q %v", originalSnapshot, err)
	}
	var rejectedCalls int64
	if err := db.QueryRow(`select coalesce(sum(calls),0) from usage_account_model_rollups_rejected_codex_v3`).Scan(&rejectedCalls); err != nil || rejectedCalls != int64(coverage) {
		t.Fatalf("rejected audit snapshot changed: %d %v", rejectedCalls, err)
	}
	var rawCount, tokens int64
	if err := db.QueryRow(`select count(*),sum(total_tokens) from usage_events where raw_json='{"original":true}'`).Scan(&rawCount, &tokens); err != nil || rawCount != int64(count) || tokens != int64(count)*10 {
		t.Fatalf("raw events changed: %d/%d %v", rawCount, tokens, err)
	}
	completedCP, err := st.AccountHistoryRollupCheckpoint(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = store.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	again, err := st.AccountHistoryRollupCheckpoint(ctx)
	if err != nil || again.LastEventID != completedCP.LastEventID {
		t.Fatal("completed recovery restarted")
	}
	checkHistory(true)
}

func TestRejectedCodexIdentityRecovery(t *testing.T) {
	for _, coverage := range []int{100, 1000} {
		t.Run(fmt.Sprintf("coverage_%d", coverage), func(t *testing.T) { verifyRejectedCodexRecovery(t, 1000, coverage) })
	}
}
