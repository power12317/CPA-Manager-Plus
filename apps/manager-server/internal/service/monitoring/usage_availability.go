package monitoring

import (
	"encoding/json"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func (row EventRow) MarshalJSON() ([]byte, error) {
	type plainEventRow EventRow
	if row.ResponseMetadata != nil && row.ResponseMetadata.UsageUnavailable {
		return usage.MarshalUnavailableUsage(plainEventRow(row))
	}
	return json.Marshal(plainEventRow(row))
}
