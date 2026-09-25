// Package usagebaseline preserves the established Codex history boundary when
// shared derived data is rebuilt for another provider. Only bounded checkpoint
// metadata is added; existing baseline rows and raw Codex events stay intact.
package usagebaseline

import (
	"context"
	"database/sql"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usageidentity"
)

const History = "codex_baseline:account_history"
const Pricing = "codex_baseline:pricing:"

// Capture runs in the transaction that invalidates shared rollups. The
// original watermarks survive interruption until each rebuild catches up.
func Capture(ctx context.Context, tx *sql.Tx) error {
	for _, query := range []string{
		`insert into usage_rollup_checkpoints(name,last_event_id,updated_at_ms)
   select '` + History + `', min(last_event_id, ` + usageidentity.SQLCredentialCutover() + `), 0
   from usage_rollup_checkpoints where name = 'account_history' and last_event_id > 0
   and ` + usageidentity.SQLCredentialCutover() + ` > 0
   on conflict(name) do nothing`,
		`insert into usage_rollup_checkpoints(name,last_event_id,updated_at_ms)
   select '` + Pricing + `' || structure_revision, min(coverage_event_id, ` + usageidentity.SQLCredentialCutover() + `), 0
   from usage_pricing_rollup_state where rollup_name = 'pricing_v1' and coverage_event_id > 0
   and structure_revision <> '' and status <> 'clearing'
   and ` + usageidentity.SQLCredentialCutover() + ` > 0
   on conflict(name) do nothing`,
	} {
		if _, err := tx.ExecContext(ctx, query); err != nil {
			return err
		}
	}
	return nil
}

func HistoryWatermark() string {
	return "coalesce((select last_event_id from usage_rollup_checkpoints where name = '" + History + "'),0)"
}

func PricingWatermark(revisionExpression string) string {
	return "coalesce((select last_event_id from usage_rollup_checkpoints where name = '" + Pricing + "' || " + revisionExpression + "),0)"
}

// Historical keys are disjoint from credential: and codex-credential keys.
// Older workspace/member rows can lack their provider snapshot.
func HistoricalRow() string {
	return `(lower(trim(coalesce(auth_provider_snapshot,''))) = 'codex'
    or account_key like 'usage-account-history:%:codex-member:%')
   and account_key not like 'credential:%'
   and account_key not like 'usage-account-history:%:codex-credential:%'`
}

func KeepHistoryRow() string {
	return "(" + HistoryWatermark() + " > 0 and " + HistoricalRow() + ")"
}

func KeepPricingRow() string {
	return "(" + PricingWatermark("structure_revision") + " > 0 and " + HistoricalRow() + ")"
}

func EventOutsideBaseline(alias, watermark string) string {
	prefix := ""
	if alias != "" {
		prefix = alias + "."
	}
	provider := "lower(trim(coalesce(nullif(" + prefix + "auth_provider_snapshot,'')," + prefix + "provider,'')))"
	return "(" + prefix + "id > " + watermark + " or " + provider + " <> 'codex')"
}

func ReleaseHistory(ctx context.Context, tx *sql.Tx, throughID int64) error {
	_, err := tx.ExecContext(ctx, `delete from usage_rollup_checkpoints where name = ? and last_event_id <= ?`, History, throughID)
	return err
}

func ReleasePricing(ctx context.Context, tx *sql.Tx, revision string, throughID int64) error {
	_, err := tx.ExecContext(ctx, `delete from usage_rollup_checkpoints where name = ? and last_event_id <= ?`, Pricing+revision, throughID)
	return err
}
