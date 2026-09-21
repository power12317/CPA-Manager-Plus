package worker

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestWorkersCompleteRejectedCodexIdentityRecovery(t *testing.T) {
	for _, eventCount := range []int{0, 20} {
		t.Run(fmt.Sprintf("events_%d", eventCount), func(t *testing.T) {
			ctx := context.Background()
			path := filepath.Join(t.TempDir(), "usage.sqlite")
			db, err := sqliterepo.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = db.Close() }()
			st := store.New(db)
			for i := 0; i < eventCount; i++ {
				event := usagePricingRollupWorkerEvent(fmt.Sprintf("recovery-%d", i), 1_800_000_000_000+int64(i), 10)
				event.AuthProviderSnapshot = "codex"
				event.AuthFileSnapshot = "codex.json"
				if _, err := st.InsertEvents(ctx, []usage.Event{event}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.Exec(`update settings set value='identity-3:codex-3:model-1' where key='usage_account_history_identity_format_version'`); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`delete from settings where key='codex_credential_history_start_after_id'`); err != nil {
				t.Fatal(err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			db, err = sqliterepo.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			st = store.New(db)
			history := NewAccountHistoryRollupWorker(st)
			history.batchLimit, history.maxBatches = 3, 1
			derived := NewUsagePricingRollupWorker(st)
			derived.batchLimit, derived.maxBatches = 3, usageDerivedTaskCount
			for batch := 0; batch < 20; batch++ {
				history.catchUp(ctx)
				derived.catchUp(ctx)
				var status string
				var progress int64
				if err := db.QueryRow(`select status,last_event_id from usage_data_migrations where name=?`, sqliterepo.CodexIdentityRecoveryName).Scan(&status, &progress); err != nil {
					t.Fatal(err)
				}
				if status == "completed" {
					if progress != int64(eventCount) {
						t.Fatalf("completed at %d, want %d", progress, eventCount)
					}
					return
				}
			}
			t.Fatal("normal workers did not complete recovery")
		})
	}
}

func TestWorkersDoNotScheduleRecoveryForHealthyDatabase(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	st := store.New(db)
	NewAccountHistoryRollupWorker(st).catchUp(ctx)
	NewUsagePricingRollupWorker(st).catchUp(ctx)
	var jobs int
	if err := db.QueryRow(`select count(*) from usage_data_migrations where name=?`, sqliterepo.CodexIdentityRecoveryName).Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("healthy database recovery jobs=%d %v", jobs, err)
	}
}
