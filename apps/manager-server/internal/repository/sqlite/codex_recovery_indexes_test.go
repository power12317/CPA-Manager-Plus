package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestCodexRecoveryIndexRepairResumesAfterCancellation(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "indexes.sqlite")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if db != nil {
			_ = db.Close()
		}
	}()
	if err := RunDerivedStartupMaintenance(ctx, db); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`alter table usage_account_model_rollups rename to usage_account_model_rollups_rejected_codex_v3`,
		createUsageAccountModelRollupsTable,
		`insert into usage_data_migrations(name,status,updated_at_ms) values ('codex_identity_v3_recovery','completed',1)`,
	} {
		if _, err := tx.Exec(statement); err != nil {
			_ = tx.Rollback()
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	first := codexRecoveryIndexes[0]
	// Fail after DROP INDEX, inside the same transaction. The old index must
	// survive a failed/cancelled creation until its replacement commits.
	if err := repairCodexRecoveryIndex(ctx, db, first.name, "injected_missing_column"); err == nil {
		t.Fatal("injected index creation failure succeeded")
	}
	var retainedTable string
	if err := db.QueryRow(`select tbl_name from sqlite_master where name=?`, first.name).Scan(&retainedTable); err != nil || retainedTable != rejectedCodexHistoryTable {
		t.Fatalf("failed repair did not roll back index removal: %s %v", retainedTable, err)
	}
	if err := repairCodexRecoveryIndex(ctx, db, first.name, first.column); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := repairCodexRecoveryIndexes(cancelled, db); err == nil {
		t.Fatal("cancelled repair succeeded")
	}
	assertOwner := func(db *sql.DB, name, want string) {
		t.Helper()
		var table string
		if err := db.QueryRow(`select tbl_name from sqlite_master where name=?`, name).Scan(&table); err != nil || table != want {
			t.Fatalf("%s owner=%s want=%s %v", name, table, want, err)
		}
	}
	assertOwner(db, first.name, usageAccountModelRollupsTable)
	assertOwner(db, codexRecoveryIndexes[1].name, rejectedCodexHistoryTable)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := repairCodexRecoveryIndexes(ctx, db); err != nil {
		t.Fatal(err)
	}
	assertOwner(db, first.name, usageAccountModelRollupsTable)
	assertOwner(db, codexRecoveryIndexes[1].name, usageAccountModelRollupsTable)
	status, err := ReadDerivedMaintenanceStatus(ctx, db)
	if err != nil || status.Required {
		t.Fatalf("resumed repair not healthy: %+v %v", status, err)
	}
}

func TestCodexRecoveryIndexRepairLeavesOtherMaintenanceUntouched(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "other.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`create table unrelated_history(last_seen_ms integer)`,
		`create index idx_usage_account_model_rollups_last_seen on unrelated_history(last_seen_ms)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := repairCodexRecoveryIndexes(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`insert into usage_data_migrations(name,status,updated_at_ms) values ('codex_identity_v3_recovery','completed',1)`); err != nil {
		t.Fatal(err)
	}
	if err := repairCodexRecoveryIndexes(context.Background(), db); err == nil {
		t.Fatal("repair unexpectedly changed an unrelated table's index")
	}
	var table string
	if err := db.QueryRow(`select tbl_name from sqlite_master where name='idx_usage_account_model_rollups_last_seen'`).Scan(&table); err != nil || table != "unrelated_history" {
		t.Fatalf("unrelated index changed: %s %v", table, err)
	}
	status, err := ReadDerivedMaintenanceStatus(context.Background(), db)
	if err != nil || !status.Required {
		t.Fatalf("unrelated warning was hidden: %+v %v", status, err)
	}
}
