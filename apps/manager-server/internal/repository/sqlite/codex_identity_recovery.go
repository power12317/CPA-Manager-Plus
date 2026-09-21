package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usageidentity"
)

const (
	rejectedCodexIdentityRevision = "identity-3:codex-3:model-1"
	CodexIdentityRecoveryName     = "codex_identity_v3_recovery"
	// Retain the rejected aggregates as an audit snapshot after recovery too.
	// This name is deliberately outside the ordinary stale-table cleanup list.
	rejectedCodexHistoryTable = "usage_account_model_rollups_rejected_codex_v3"
)

// recoverRejectedCodexIdentity schedules a one-time correction of f0fcb9f5.
// It runs before the ordinary identity migrations, and touches only bounded
// metadata/schema. Existing post-listener workers rebuild affected derivations
// in checkpointed batches; immutable events and unrelated settings stay intact.
func recoverRejectedCodexIdentity(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var version string
	err = tx.QueryRow(`select value from settings where key=?`, accountHistoryIdentityFormatVersionKey).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && version != rejectedCodexIdentityRevision) {
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	var target int64
	if err := tx.QueryRow(`select coalesce(max(id),0) from usage_events`).Scan(&target); err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	if err := parkDerivedTable(tx, usageAccountModelRollupsTable, rejectedCodexHistoryTable); err != nil {
		return err
	}
	if _, err := tx.Exec(createUsageAccountModelRollupsTable); err != nil {
		return err
	}
	if _, err := tx.Exec(`delete from usage_rollup_checkpoints where name='account_history'`); err != nil {
		return err
	}
	if err := scheduleUsageRollupRebuild(tx, "account_history"); err != nil {
		return err
	}
	// The failed interim release may have been stopped at any point. Do not
	// trust its old or partially rebuilt pricing/stats coverage, even if one
	// worker had not yet switched to codex-3. A mismatching revision makes
	// readers use raw fallback until the normal workers establish v2 coverage.
	for _, statement := range []string{
		`update usage_pricing_rollup_state set structure_revision='codex-v3-recovery', status='pending',
		backfill_last_event_id=0, coverage_event_id=0, target_event_id=?, processed_events=0,
		last_run_started_at_ms=null, finished_at_ms=null, last_error=null where rollup_name='pricing_v1'`,
		`update usage_monitoring_rollup_state set structure_revision='codex-v3-recovery', status='pending',
		backfill_last_event_id=0, coverage_event_id=0, target_event_id=?, processed_events=0,
		last_run_started_at_ms=null, finished_at_ms=null, last_error=null where rollup_name='stats_v1'`,
	} {
		if _, err := tx.Exec(statement, target); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`update usage_monitoring_rollup_state set structure_revision=?, status='pending',
		backfill_last_event_id=0, coverage_event_id=0, target_event_id=?, processed_events=0,
		last_run_started_at_ms=null, finished_at_ms=null, last_error=null where rollup_name='projection_v1'`,
		usageidentity.MonitoringProjectionStructureRevision(), target); err != nil {
		return err
	}
	if _, err := tx.Exec(`update usage_monitoring_search_index_state set ready=0 where id=1`); err != nil {
		return err
	}
	if _, err := tx.Exec(`insert into settings(key,value,updated_at_ms) values (?,?,?)
		on conflict(key) do nothing`, usageidentity.CredentialCutoverSetting, fmt.Sprint(target), now); err != nil {
		return err
	}
	if _, err := tx.Exec(`insert into usage_data_migrations(name,status,last_event_id,target_event_id,processed_rows,changed_rows,updated_at_ms)
		values (?,'pending',0,?,0,0,?)`, CodexIdentityRecoveryName, target, now); err != nil {
		return err
	}
	if _, err := tx.Exec(`update settings set value=?,updated_at_ms=? where key=?`, usageidentity.AccountHistoryStructureRevision(), now, accountHistoryIdentityFormatVersionKey); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[codex-identity-recovery] detected rejected revision=%s; scheduled correction targetEventID=%d; raw history and application settings preserved", version, target)
	return nil
}

// CheckCodexIdentityRecoveryProgress persists progress for the one-time repair.
// Calling it repeatedly or after restart cannot reschedule completed work.
func CheckCodexIdentityRecoveryProgress(ctx context.Context, db *sql.DB) error {
	// Normal databases and completed repairs must not acquire SQLite's
	// immediate writer lock every time the usage worker wakes up.
	var pending bool
	if err := db.QueryRowContext(ctx, `select exists(select 1 from usage_data_migrations where name=? and status<>'completed')`, CodexIdentityRecoveryName).Scan(&pending); err != nil {
		return err
	}
	if !pending {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var status, lastError string
	var target, previous int64
	err = tx.QueryRowContext(ctx, `select status,target_event_id,last_event_id,coalesce(last_error,'') from usage_data_migrations where name=?`, CodexIdentityRecoveryName).Scan(&status, &target, &previous, &lastError)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && status == "completed") {
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	var account int64
	if err := tx.QueryRowContext(ctx, `select coalesce((select last_event_id from usage_rollup_checkpoints where name='account_history'),0)`).Scan(&account); err != nil {
		return err
	}
	progress := min(account, target)
	ready := account >= target
	failure := ""
	for _, task := range []struct{ table, name string }{
		{"usage_pricing_rollup_state", "pricing_v1"},
		{"usage_monitoring_rollup_state", "stats_v1"},
		{"usage_monitoring_rollup_state", "projection_v1"},
	} {
		var revision, taskStatus, taskError string
		var coverage int64
		err := tx.QueryRowContext(ctx, `select structure_revision,status,coverage_event_id,coalesce(last_error,'') from `+task.table+` where rollup_name=?`, task.name).Scan(&revision, &taskStatus, &coverage, &taskError)
		if err != nil {
			return err
		}
		valid := strings.Contains(revision, ":codex-"+usageidentity.CodexIdentityRevision+":") && taskStatus != "clearing" && taskStatus != "failed"
		if !valid {
			coverage = 0
		}
		progress = min(progress, coverage)
		ready = ready && valid && coverage >= target && (target > 0 || taskStatus == "ready")
		if taskError != "" {
			failure = task.name + ": " + taskError
		}
	}
	next := "running"
	if ready {
		next = "completed"
	}
	now := time.Now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `update usage_data_migrations set status=?,last_event_id=?,processed_rows=?,
		started_at_ms=coalesce(started_at_ms,?),updated_at_ms=?,finished_at_ms=case when ? then ? else null end,last_error=nullif(?,'') where name=?`,
		next, progress, progress, now, now, ready, now, failure, CodexIdentityRecoveryName); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if status == "pending" {
		log.Printf("[codex-identity-recovery] correction started targetEventID=%d", target)
	}
	if failure != "" && failure != lastError {
		log.Printf("[codex-identity-recovery] correction failed; retry will resume: %s", failure)
	}
	if progress/10000 > previous/10000 {
		log.Printf("[codex-identity-recovery] progress eventID=%d targetEventID=%d", progress, target)
	}
	if ready {
		log.Printf("[codex-identity-recovery] correction completed eventID=%d; database identity restored to %s", target, usageidentity.AccountHistoryStructureRevision())
	}
	return nil
}
