package usage

import (
	"encoding/json"
	"testing"
	"time"
)

func TestUnavailableUsageIsNotEstimatedFromOtherTokenFields(t *testing.T) {
	for _, raw := range []string{
		`{"usage_unavailable":true,"input_tokens":99,"output_tokens":99}`,
		`{"tokens":null,"input_tokens":99}`,
		`{"response_metadata":{"usage_unavailable":true},"input_tokens":99}`,
	} {
		event, err := NormalizeRaw([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		if event.TotalTokens != 0 || event.InputTokens != 0 || event.ResponseMetadata == nil || !event.ResponseMetadata.UsageUnavailable {
			t.Fatalf("event = %#v", event)
		}
		metadata := ParseResponseHeaderMetadataFromRawJSON(raw, time.Now())
		if metadata == nil || !metadata.UsageUnavailable {
			t.Fatalf("raw read fallback = %#v", metadata)
		}
	}
}

func TestKnownZeroUsageRemainsKnown(t *testing.T) {
	event, err := NormalizeRaw([]byte(`{"tokens":{"input_tokens":0,"output_tokens":0},"failed":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if event.ResponseMetadata != nil && event.ResponseMetadata.UsageUnavailable {
		t.Fatal("known zero treated as unavailable")
	}
	encoded, err := json.Marshal(Detail{Tokens: Tokens{}, Failed: true})
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err = json.Unmarshal(encoded, &record); err != nil {
		t.Fatal(err)
	}
	if record["tokens"] == nil || record["usage_unavailable"] != nil {
		t.Fatalf("known usage = %s", encoded)
	}
}
