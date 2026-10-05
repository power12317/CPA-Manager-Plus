package monitoring

import (
	"encoding/json"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
	"testing"
)

func TestEventRowUnknownUsageJSON(t *testing.T) {
	latency := int64(123)
	encoded, err := json.Marshal(EventRow{
		Model: "gpt-6.1-sol", LatencyMS: &latency,
		ResponseMetadata: &usage.ResponseHeaderMetadata{UsageUnavailable: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err = json.Unmarshal(encoded, &record); err != nil {
		t.Fatal(err)
	}
	if record["usage_unavailable"] != true || record["latency_ms"] != float64(123) {
		t.Fatalf("row = %s", encoded)
	}
	for _, key := range []string{"tokens", "token_breakdown", "input_tokens", "output_tokens", "cached_tokens", "total_tokens"} {
		if value, ok := record[key]; !ok || value != nil {
			t.Fatalf("%s = %#v, want null", key, value)
		}
	}
}
