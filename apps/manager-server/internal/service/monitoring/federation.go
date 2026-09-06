package monitoring

import (
	"context"
	"encoding/json"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

type federatedPercentilesKey struct{}

// The federation reducer computes percentiles once from the combined samples.
func WithFederatedPercentiles(ctx context.Context) context.Context {
	return context.WithValue(ctx, federatedPercentilesKey{}, true)
}
func federatedPercentiles(ctx context.Context) bool {
	value, _ := ctx.Value(federatedPercentilesKey{}).(bool)
	return value
}

func (s *Service) FederationSamples(ctx context.Context, req Request) (map[string]any, error) {
	location, err := resolveAnalyticsLocation(req.TimeZone)
	if err != nil {
		return nil, err
	}
	rows, err := s.store.UsageEvents.LatencyObservations(ctx, buildFilter(req))
	if err != nil {
		return nil, err
	}
	granularity := normalizeGranularity(req.Include.Granularity, req.FromMS, req.ToMS)
	samples := make([]any, 0, len(rows))
	for _, row := range rows {
		samples = append(samples, map[string]any{"bucket": float64(usage.AnalyticsBucketMS(row.TimestampMS, granularity, location)), "latency": float64(row.LatencyMS), "ttft": float64(row.TTFTMS), "api_key_hash": row.APIKeyHash})
	}
	return map[string]any{"samples": samples}, nil
}

// Recompute anomalies from the combined traffic distribution.
func FinalizeFederatedAnalytics(payload map[string]any) {
	if _, requested := payload["anomaly_points"]; !requested {
		return
	}
	encoded, err := json.Marshal(payload["timeline"])
	if err != nil {
		return
	}
	var timeline []TimelinePoint
	if json.Unmarshal(encoded, &timeline) != nil {
		return
	}
	granularity, _ := payload["granularity"].(string)
	payload["anomaly_points"] = buildAnomalyPoints(timeline, granularity)
}
