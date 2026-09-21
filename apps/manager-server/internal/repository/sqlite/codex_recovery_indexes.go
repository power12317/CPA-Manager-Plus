package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"
)

const codexRecoveryIndexBudget = 5 * time.Second

var codexRecoveryIndexes = []struct{ name, column string }{
	{"idx_usage_account_model_rollups_last_seen", "last_seen_ms"},
	{"idx_usage_account_model_rollups_auth_index", "auth_index"},
}

// repairCodexRecoveryIndexes is post-listener work for the specific f0fcb9f5 /
// a02947dc table-parking regression. SQLite kept the canonical index names on
// the parked tables, so ordinary startup preparation permanently deferred them.
// Each index is an atomic, time-bounded unit of work. sqlite_master records
// completion, so cancellation rolls back only the current index and a restart
// or the existing maintenance loop resumes the remaining work without touching
// history rows or rollup checkpoints.
func repairCodexRecoveryIndexes(ctx context.Context, db *sql.DB) error {
	var recovering bool
	if err := db.QueryRowContext(ctx, `select exists(select 1 from usage_data_migrations where name=?)`, CodexIdentityRecoveryName).Scan(&recovering); err != nil {
		return err
	}
	if !recovering {
		return nil
	}
	for _, index := range codexRecoveryIndexes {
		var table string
		err := db.QueryRowContext(ctx, `select tbl_name from sqlite_master where type='index' and name=?`, index.name).Scan(&table)
		if err == nil && table == usageAccountModelRollupsTable {
			continue
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		batchCtx, cancel := context.WithTimeout(ctx, codexRecoveryIndexBudget)
		err = repairCodexRecoveryIndex(batchCtx, db, index.name, index.column)
		cancel()
		if err != nil {
			return fmt.Errorf("restore Codex history index %s: %w", index.name, err)
		}
	}
	return nil
}

func repairCodexRecoveryIndex(ctx context.Context, db *sql.DB, name, column string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var oldTable string
	err = tx.QueryRowContext(ctx, `select tbl_name from sqlite_master where type='index' and name=?`, name).Scan(&oldTable)
	if err == nil && oldTable == usageAccountModelRollupsTable {
		return tx.Commit()
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if oldTable != "" && oldTable != rejectedCodexHistoryTable && oldTable != "usage_account_model_rollups_legacy_identity_v3_codex_v3" {
		return fmt.Errorf("index belongs to unrelated table %s; leaving it unchanged", oldTable)
	}
	log.Printf("[codex-identity-recovery] restoring history index=%s previousTable=%s", name, oldTable)
	if oldTable != "" {
		if _, err := tx.ExecContext(ctx, `drop index `+name); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `create index `+name+` on usage_account_model_rollups(`+column+`)`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `delete from usage_derived_deferred_indexes where index_name=?`, name); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[codex-identity-recovery] restored history index=%s table=%s", name, usageAccountModelRollupsTable)
	return nil
}
