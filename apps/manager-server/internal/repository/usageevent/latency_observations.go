package usageevent

import "context"

type LatencyObservation struct {
	TimestampMS int64
	LatencyMS   int64
	TTFTMS      int64
	APIKeyHash  string
}

// Federation combines timing observations, never averages per-CPA percentiles.
func (r *repository) LatencyObservations(ctx context.Context, filter AnalyticsFilter) ([]LatencyObservation, error) {
	where, args := analyticsWhere(filter)
	rows, err := r.db.QueryContext(ctx, `select timestamp_ms,coalesce(latency_ms,0),coalesce(ttft_ms,0),coalesce(api_key_hash,'') from usage_events `+where+` and (latency_ms > 0 or ttft_ms > 0)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]LatencyObservation, 0)
	for rows.Next() {
		var row LatencyObservation
		if err := rows.Scan(&row.TimestampMS, &row.LatencyMS, &row.TTFTMS, &row.APIKeyHash); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
