package usage

import "encoding/json"

func usageUnavailableFromRecord(record map[string]any) bool {
	if record["usage_unavailable"] == true {
		return true
	}
	if tokens, present := record["tokens"]; present && tokens == nil {
		return true
	}
	if metadata, ok := record["response_metadata"].(map[string]any); ok {
		return metadata["usage_unavailable"] == true
	}
	return false
}

func attachUsageAvailability(metadata *ResponseHeaderMetadata, record map[string]any) *ResponseHeaderMetadata {
	if !usageUnavailableFromRecord(record) {
		return metadata
	}
	if metadata == nil {
		metadata = &ResponseHeaderMetadata{}
	}
	metadata.UsageUnavailable = true
	return metadata
}

// MarshalUnavailableUsage preserves the request's outcome and timing while
// preventing internal numeric aggregation placeholders from becoming reported
// zero usage. Callers pass an alias without MarshalJSON to avoid recursion.
func MarshalUnavailableUsage(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var record map[string]json.RawMessage
	if err = json.Unmarshal(encoded, &record); err != nil {
		return nil, err
	}
	for _, key := range []string{
		"input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens",
		"cache_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens",
	} {
		if _, present := record[key]; present {
			record[key] = json.RawMessage("null")
		}
	}
	record["usage_unavailable"] = json.RawMessage("true")
	record["tokens"] = json.RawMessage("null")
	record["token_breakdown"] = json.RawMessage("null")
	return json.Marshal(record)
}

func (detail Detail) MarshalJSON() ([]byte, error) {
	type plainDetail Detail
	if detail.ResponseMetadata != nil && detail.ResponseMetadata.UsageUnavailable {
		return MarshalUnavailableUsage(plainDetail(detail))
	}
	return json.Marshal(plainDetail(detail))
}
