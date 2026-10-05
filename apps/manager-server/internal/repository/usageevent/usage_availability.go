package usageevent

import (
	"encoding/json"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

// Do not promote Detail.MarshalJSON: streaming must also preserve the raw
// metadata overlay, including extension fields from newer CPA versions.
func (detail rawMetadataDetail) MarshalJSON() ([]byte, error) {
	type plainDetail usage.Detail
	record := struct {
		plainDetail
		ResponseMetadata json.RawMessage `json:"response_metadata,omitempty"`
	}{plainDetail(detail.Detail), detail.ResponseMetadata}
	metadata := usage.ResponseHeaderMetadataFromJSON(string(detail.ResponseMetadata))
	if metadata != nil && metadata.UsageUnavailable {
		return usage.MarshalUnavailableUsage(record)
	}
	return json.Marshal(record)
}

func (event rawMetadataEvent) MarshalJSON() ([]byte, error) {
	type plainEvent rawMetadataEvent
	metadata := usage.ResponseHeaderMetadataFromJSON(string(event.ResponseMetadata))
	if metadata != nil && metadata.UsageUnavailable {
		return usage.MarshalUnavailableUsage(plainEvent(event))
	}
	return json.Marshal(plainEvent(event))
}
