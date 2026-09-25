package cluster

import (
	"encoding/json"
	"math"
	"testing"
)

func jsonValue(t *testing.T, raw string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestFederationRecomputesRatesAndKeepsBucketIdentity(t *testing.T) {
	a := jsonValue(t, `{"summary":{"total_calls":10,"success_calls":9,"failure_calls":1,"success_rate":0.9,"input_tokens":1000,"cached_tokens":100,"cache_read_tokens":100,"cache_hit_rate":0.2},"hourly_activity":[{"hour_index":3,"bucket_ms":1000,"calls":10,"tokens":1000,"intensity":1}],"api_key_stats":[{"api_key_hash":"same","calls":10,"average_latency_ms":100,"latency_samples":1}],"channel_health":[{"calls":10,"failures":1,"failure_rate":0.1}]}`)
	b := jsonValue(t, `{"summary":{"total_calls":90,"success_calls":45,"failure_calls":45,"success_rate":0.5,"input_tokens":9000,"cached_tokens":900,"cache_read_tokens":1800,"cache_hit_rate":0.3},"hourly_activity":[{"hour_index":3,"bucket_ms":1000,"calls":90,"tokens":9000,"intensity":1}],"api_key_stats":[{"api_key_hash":"same","calls":90,"average_latency_ms":1000,"latency_samples":9}],"channel_health":[{"calls":90,"failures":45,"failure_rate":0.5}]}`)
	result := finalizePayload(mergePayload(a, b, "", "/v0/management/monitoring/analytics"), "", "/v0/management/monitoring/analytics", nil).(map[string]any)
	summary := result["summary"].(map[string]any)
	if number(summary["total_calls"]) != 100 || math.Abs(number(summary["success_rate"])-.54) > .000001 || math.Abs(number(summary["cache_hit_rate"])-.29) > .000001 {
		t.Fatalf("bad totals/rates: %#v", summary)
	}
	activity := result["hourly_activity"].([]any)
	if len(activity) != 1 || number(activity[0].(map[string]any)["hour_index"]) != 3 {
		t.Fatalf("bucket identity changed: %#v", activity)
	}
	keys := result["api_key_stats"].([]any)
	if len(keys) != 1 || number(keys[0].(map[string]any)["average_latency_ms"]) != 910 {
		t.Fatalf("latency weighted by requests instead of observed samples: %#v", keys)
	}
	health := result["channel_health"].([]any)
	if number(health[0].(map[string]any)["failure_rate"]) != .1 || number(health[1].(map[string]any)["failure_rate"]) != .5 {
		t.Fatalf("failure counts were discarded: %#v", health)
	}
}

func TestFederationPreservesArchiveCoverageAcrossInstances(t *testing.T) {
	a := jsonValue(t, `{"coverage":{"mode":"aggregate_only","raw_complete":false,"raw_deleted_event_count":2,"min_deleted_timestamp_ms":200,"max_deleted_timestamp_ms":300,"comparison_min_deleted_timestamp_ms":90,"fidelity_limitations":["event_details_require_raw_events"],"auxiliary_ranges":[{"scope":"rolling_30m","from_ms":10,"to_ms":500,"raw_deleted_event_count":1,"min_deleted_timestamp_ms":300}]}}`)
	b := jsonValue(t, `{"coverage":{"mode":"mixed","raw_complete":true,"raw_deleted_event_count":3,"min_deleted_timestamp_ms":100,"max_deleted_timestamp_ms":400,"comparison_min_deleted_timestamp_ms":60,"fidelity_limitations":["event_details_require_raw_events","filter_options_require_raw_events"],"auxiliary_ranges":[{"scope":"rolling_30m","from_ms":10,"to_ms":500,"raw_deleted_event_count":2,"min_deleted_timestamp_ms":200}]}}`)
	result := mergePayload(a, b, "", "/v0/management/monitoring/analytics").(map[string]any)["coverage"].(map[string]any)
	if result["raw_complete"] != false || result["mode"] != "mixed" || number(result["raw_deleted_event_count"]) != 5 || number(result["min_deleted_timestamp_ms"]) != 100 || number(result["max_deleted_timestamp_ms"]) != 400 || number(result["comparison_min_deleted_timestamp_ms"]) != 60 {
		t.Fatalf("incorrect coverage: %#v", result)
	}
	if len(result["fidelity_limitations"].([]any)) != 2 {
		t.Fatal("lost or duplicated limitations")
	}
	ranges := result["auxiliary_ranges"].([]any)
	if len(ranges) != 1 || number(ranges[0].(map[string]any)["raw_deleted_event_count"]) != 3 || number(ranges[0].(map[string]any)["min_deleted_timestamp_ms"]) != 200 {
		t.Fatalf("incorrect auxiliary ranges: %#v", ranges)
	}
}
