package monitoring

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestCodexCredentialHistoryAndWindowsRemainSeparateAcrossReadPaths(t *testing.T) {
	st := newMonitoringTestStore(t)
	ctx := context.Background()
	const from = int64(1_800_057_600_000) // UTC midnight: exercise daily rollups too.
	const to = from + 86_400_000
	if err := st.SaveModelPrices(ctx, map[string]store.ModelPrice{"gpt-credential": {Prompt: 1, Completion: 2}}); err != nil {
		t.Fatal(err)
	}
	targets := []AccountHistoryTarget{
		{RowKey: "mac", AuthFileSnapshot: "codex-pro.json", AuthIndex: "mac-index"},
		{RowKey: "windows", AuthFileSnapshot: "codex-pro-windows.json", AuthIndex: "windows-index"},
		{RowKey: "other-file", AuthFileSnapshot: "another.json", AuthIndex: "mac-index"},
		{RowKey: "other-index", AuthFileSnapshot: "codex-pro.json", AuthIndex: "another-index"},
	}
	request := AccountWindowUsageRequest{}
	for i := range targets {
		targets[i].AuthProviderSnapshot = "codex"
		targets[i].AuthAccountIDSnapshot = "same-workspace"
		targets[i].AccountSnapshot = "same@example.com"
		request.Windows = append(request.Windows, AccountWindowUsageTarget{
			RowKey: targets[i].RowKey, ProviderWindowID: "primary", Period: "current", FromMS: from, ToMS: to,
			AuthFileSnapshot: targets[i].AuthFileSnapshot, AuthIndex: targets[i].AuthIndex,
			AuthProviderSnapshot: "codex", AuthAccountIDSnapshot: "same-workspace", AccountSnapshot: "same@example.com",
		})
	}
	makeEvent := func(hash string, target int, failed bool, input int64) usage.Event {
		e := monitoringEvent(hash, from+input, "gpt-credential", targets[target].AuthIndex, "", failed, input, input/2, 0, 0, input+input/2, nil)
		e.Provider = "codex"
		e.AuthProviderSnapshot = "codex"
		e.AuthFileSnapshot = targets[target].AuthFileSnapshot
		e.AuthAccountIDSnapshot = "same-workspace"
		e.AccountSnapshot = "same@example.com"
		e.Source = e.AuthFileSnapshot
		if target == 1 {
			e.System = "windows"
		} else {
			e.System = "mac"
		}
		return e
	}
	if _, err := st.InsertEvents(ctx, []usage.Event{
		makeEvent("mac-ok", 0, false, 100), makeEvent("mac-failure", 0, true, 200),
		makeEvent("windows-ok", 1, false, 1000), makeEvent("other-file", 2, false, 5000),
		makeEvent("other-index", 3, true, 9000),
	}); err != nil {
		t.Fatal(err)
	}
	service := New(st)
	assertSeparated := func(phase string) {
		t.Helper()
		history, err := service.AccountHistory(ctx, AccountHistoryRequest{Accounts: targets})
		if err != nil {
			t.Fatal(err)
		}
		window, err := service.AccountWindowUsage(ctx, request)
		if err != nil {
			t.Fatal(err)
		}
		if len(history.Items) != 4 || len(window.Items) != 4 {
			t.Fatalf("%s: history=%+v window=%+v", phase, history, window)
		}
		keys := map[string]bool{}
		for i, expected := range []struct {
			calls, success, tokens int64
			cost                   float64
		}{
			{2, 1, 450, .0006}, {1, 1, 1500, .002}, {1, 1, 7500, .01}, {1, 0, 13500, .018},
		} {
			h, w := history.Items[i], window.Items[i]
			if keys[h.AccountKey] || h.AccountKey == "" {
				t.Fatalf("%s: credentials share a history key: %s", phase, h.AccountKey)
			}
			keys[h.AccountKey] = true
			if !h.Matched || h.TotalRequests != expected.calls || h.SuccessCalls != expected.success || h.FailureCalls != expected.calls-expected.success || h.TotalTokens != expected.tokens || math.Abs(h.TotalCost-expected.cost) > 1e-9 {
				t.Fatalf("%s: history %s = %+v", phase, targets[i].RowKey, h)
			}
			if !w.Matched || w.TotalRequests != h.TotalRequests || w.TotalTokens != h.TotalTokens || w.TotalCost != h.TotalCost || w.SuccessCalls != h.SuccessCalls || w.FailureCalls != h.FailureCalls {
				t.Fatalf("%s: window %s = %+v; history=%+v", phase, targets[i].RowKey, w, h)
			}
			wantRate := float64(expected.success) / float64(expected.calls)
			if h.SuccessRate == nil || w.SuccessRate == nil || *h.SuccessRate != wantRate || *w.SuccessRate != wantRate {
				t.Fatalf("%s: success rate mixed for %s", phase, targets[i].RowKey)
			}
			if int64(len(h.RecentRequests)) != expected.calls || h.LatestRequest == nil {
				t.Fatalf("%s: recent requests mixed for %s: %+v", phase, targets[i].RowKey, h.RecentRequests)
			}
		}
	}
	assertSeparated("raw history before workers start")
	for _, batch := range []int{2, 100} {
		for _, catchUp := range []func(context.Context, int, int64) error{
			func(ctx context.Context, n int, now int64) error {
				_, err := st.CatchUpAccountHistoryRollups(ctx, n, now)
				return err
			},
			func(ctx context.Context, n int, now int64) error {
				_, err := st.CatchUpUsagePricing(ctx, n, now)
				return err
			},
			func(ctx context.Context, n int, now int64) error {
				_, err := st.CatchUpUsageMonitoringProjection(ctx, n, now)
				return err
			},
			func(ctx context.Context, n int, now int64) error {
				_, err := st.CatchUpUsageMonitoringStats(ctx, n, now)
				return err
			},
		} {
			if err := catchUp(ctx, batch, time.Now().UnixMilli()); err != nil {
				t.Fatal(err)
			}
		}
		assertSeparated("partial/complete rollups and raw tail")
	}
}
