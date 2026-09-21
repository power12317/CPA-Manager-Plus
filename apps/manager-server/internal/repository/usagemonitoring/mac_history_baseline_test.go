package usagemonitoring_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usageidentity"
)

func TestCodexWindowsIgnoresOldBaselineAcrossProjectionDailyAndRawTail(t *testing.T) {
	db, st := newMonitoringRepositoryStore(t)
	ctx := context.Background()
	const from int64 = 1_800_057_600_000
	event := func(hash, file, index string, tokens int64) usage.Event {
		e := monitoringRepositoryEvent(hash, from+tokens, "gpt-test", "key", "same@example.com", index, file, false, tokens, 0, 0)
		e.AuthFileSnapshot = file
		e.AuthAccountIDSnapshot = "workspace"
		return e
	}
	if _, err := st.InsertEvents(ctx, []usage.Event{
		event("old-mac", "codex.json", "mac", 10),
		event("old-windows", "codex-windows.json", "windows", 20),
		event("old-unprocessed", "codex-windows.json", "windows", 30),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`update settings set value='3' where key=?`, usageidentity.CredentialCutoverSetting); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CatchUpUsageMonitoringProjection(ctx, 2, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CatchUpUsageMonitoringStats(ctx, 2, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	windows := []store.AccountWindowUsageQuery{
		{RequestIndex: 0, FromMS: from, ToMS: from + testDayMS, AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com", AuthFileSnapshot: "codex.json", AuthIndex: "mac"},
		{RequestIndex: 1, FromMS: from, ToMS: from + testDayMS, AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com", AuthFileSnapshot: "codex-windows.json", AuthIndex: "windows"},
	}
	check := func(wantMac, wantWindows int64) {
		t.Helper()
		raw, err := st.AccountWindowModelStats(ctx, windows)
		if err != nil {
			t.Fatal(err)
		}
		projected, _, ok, err := st.UsageMonitoringAccountWindowStats(ctx, windows)
		if err != nil || !ok || !reflect.DeepEqual(raw, projected) {
			t.Fatalf("raw=%+v projected=%+v ok=%v err=%v", raw, projected, ok, err)
		}
		tokens := map[int]int64{}
		for _, row := range raw {
			tokens[row.RequestIndex] += row.TotalTokens
		}
		if tokens[0] != wantMac || tokens[1] != wantWindows {
			t.Fatalf("tokens=%v want Mac=%d Windows=%d", tokens, wantMac, wantWindows)
		}
	}
	check(60, 0)
	if _, err := st.InsertEvents(ctx, []usage.Event{event("new-mac", "codex.json", "mac", 100), event("new-windows", "codex-windows.json", "windows", 200)}); err != nil {
		t.Fatal(err)
	}
	check(160, 200)
	catchUpMonitoringRepository(t, ctx, st)
	check(160, 200)
	var oldKey string
	if err := db.QueryRow(`select account_key from usage_monitoring_event_projection_v1 where event_id=2`).Scan(&oldKey); err != nil {
		t.Fatal(err)
	}
	wantOld, _ := usageidentity.HistoricalAccountKey(usageidentity.Fields{AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "workspace", AccountSnapshot: "same@example.com"})
	if oldKey != wantOld {
		t.Fatalf("old projection was reclassified: %s", oldKey)
	}
}
