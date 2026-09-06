package cluster

import (
	"encoding/json"
	monitoringsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"math"
	"reflect"
	"sort"
	"strings"
)

func number(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case int:
		return float64(v)
	}
	return 0
}
func count(row map[string]any) float64 {
	for _, key := range []string{"total_calls", "calls", "total_requests", "total"} {
		if _, ok := row[key]; ok {
			return number(row[key])
		}
	}
	return 0
}
func ratio(a, b float64) float64 {
	if b <= 0 {
		return 0
	}
	return a / b
}

var grouping = map[string][]string{
	"timeline": {"bucket_ms"}, "traffic_timeline": {"bucket_ms"}, "points": {"bucket_ms"},
	"hourly_distribution": {"hour"}, "hourly_activity": {"bucket_ms"}, "heatmap": {"weekday", "hour"},
	"model_share": {"model"}, "model_stats": {"model"}, "top_models_today": {"model"}, "model_cost_rank": {"model"},
	"models": {"model"}, "token_mix": {"key"}, "model_contributors": {"key"}, "provider_contributors": {"key"}, "api_key_contributors": {"key"},
	"api_key_stats": {"api_key_hash"}, "api_key_timeline": {"api_key_hash", "bucket_ms"},
}

func rowIdentity(row map[string]any, keys []string) string {
	values := make([]any, 0, len(keys))
	for _, key := range keys {
		value, ok := row[key]
		if !ok {
			return ""
		}
		values = append(values, value)
	}
	encoded, _ := json.Marshal(values)
	return string(encoded)
}

// Merge additive metrics, while keeping metadata and identity fields intact.
// Rates and rankings are finalized only after all instances have contributed.
func mergePayload(left, right any, parent, path string) any {
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	switch a := left.(type) {
	case map[string]any:
		b, ok := right.(map[string]any)
		if !ok {
			return left
		}
		aCount, bCount := count(a), count(b)
		aLatencySamples, bLatencySamples := number(a["latency_samples"]), number(b["latency_samples"])
		for key, value := range b {
			if key == "success_rate" || key == "failure_rate" {
				a[key] = ratio(number(a[key])*aCount+number(value)*bCount, aCount+bCount)
				continue
			}
			if strings.Contains(key, "average_latency") {
				av, bv := a[key], value
				weightA, weightB := aCount, bCount
				if _, ok := a["latency_samples"]; ok {
					weightA = aLatencySamples
				}
				if _, ok := b["latency_samples"]; ok {
					weightB = bLatencySamples
				}
				if av == nil {
					weightA = 0
				}
				if bv == nil {
					weightB = 0
				}
				if weightA+weightB > 0 {
					a[key] = (number(av)*weightA + number(bv)*weightB) / (weightA + weightB)
				}
				continue
			}
			// CPA configuration scalar values are not additive. Lists are federated
			// for the original overview's provider/key counts; per-instance editing is scoped.
			if strings.HasSuffix(path, "/config") {
				if _, ok := value.([]any); !ok {
					if old, exists := a[key]; exists && !reflect.DeepEqual(old, value) && key != "instanceCoverage" {
						mixed, _ := a["_cpampMixedFields"].([]any)
						a["_cpampMixedFields"] = appendUnique(mixed, key)
					}
					if _, exists := a[key]; !exists {
						a[key] = value
					}
					continue
				}
			}
			a[key] = mergePayload(a[key], value, key, path)
		}
		return a
	case []any:
		b, ok := right.([]any)
		if !ok {
			return left
		}
		keys, group := grouping[parent]
		if group {
			index := map[string]int{}
			for i, x := range a {
				if row, ok := x.(map[string]any); ok {
					if id := rowIdentity(row, keys); id != "" {
						index[id] = i
					}
				}
			}
			for _, x := range b {
				row, ok := x.(map[string]any)
				if !ok {
					a = appendUnique(a, x)
					continue
				}
				id := rowIdentity(row, keys)
				if i, ok := index[id]; ok && id != "" {
					a[i] = mergePayload(a[i], x, parent, path)
				} else {
					if id != "" {
						index[id] = len(a)
					}
					a = append(a, x)
				}
			}
			return a
		}
		for _, x := range b {
			if _, isString := x.(string); isString {
				a = appendUnique(a, x)
			} else {
				a = append(a, x)
			}
		}
		return a
	case float64:
		b, ok := right.(float64)
		if !ok {
			return left
		}
		if parent == "id" || parent == "hour" || parent == "hour_index" || parent == "weekday" || parent == "bucket_ms" || parent == "bucket_end_ms" || parent == "now_ms" || parent == "today_start_ms" || parent == "from_ms" || parent == "to_ms" || parent == "limit" || parent == "version" || parent == "batchSize" || parent == "pollIntervalMs" || parent == "queryLimit" || parent == "queueRetentionSeconds" {
			return a
		}
		if strings.HasPrefix(parent, "first_") || parent == "startedAt" {
			if a == 0 {
				return b
			}
			if b == 0 {
				return a
			}
			return math.Min(a, b)
		}
		if strings.HasPrefix(parent, "last") || strings.HasPrefix(parent, "next_") || strings.Contains(parent, "timestamp") || strings.Contains(parent, "updated") || strings.Contains(parent, "generated") || strings.HasSuffix(parent, "AtMs") || strings.HasPrefix(parent, "max_") {
			return math.Max(a, b)
		}
		if strings.Contains(parent, "rate") || strings.Contains(parent, "share") || strings.Contains(parent, "percent") || strings.HasPrefix(parent, "p95_") || parent == "intensity" {
			return a
		}
		return a + b
	case bool:
		if b, ok := right.(bool); ok {
			return a || b
		}
		return a
	case string:
		b, ok := right.(string)
		if ok && (parent == "lastError" || parent == "error") {
			if a == "" {
				return b
			}
			if b != "" && a != b {
				return a + "; " + b
			}
		}
		return a
	default:
		return left
	}
}

func appendUnique(items []any, value any) []any {
	for _, x := range items {
		if text, ok := x.(string); ok && text == value {
			return items
		}
	}
	return append(items, value)
}

func recalculateRates(row map[string]any) {
	calls := count(row)
	success := number(row["success_calls"])
	failure := number(row["failure_calls"])
	if _, ok := row["success"]; ok {
		success = number(row["success"])
	}
	if _, ok := row["failure"]; ok {
		failure = number(row["failure"])
	}
	if _, ok := row["failures"].(float64); ok {
		failure = number(row["failures"])
	}
	if _, ok := row["success_rate"]; ok {
		if _, has := row["success_calls"]; has {
			row["success_rate"] = ratio(success, calls)
		} else if _, has := row["success"]; has {
			row["success_rate"] = ratio(success, calls)
		}
	}
	if _, ok := row["failure_rate"]; ok {
		row["failure_rate"] = ratio(failure, calls)
	}
	if _, ok := row["average_cost_per_call"]; ok {
		row["average_cost_per_call"] = ratio(number(row["total_cost"]), calls)
	}
	if _, ok := row["approx_task_success_rate"]; ok {
		row["approx_task_success_rate"] = ratio(number(row["approx_tasks"])-number(row["approx_task_failures"]), number(row["approx_tasks"]))
	}
	if _, ok := row["cache_hit_rate"]; ok {
		hit := number(row["cache_hit_tokens"])
		total := number(row["cache_hit_input_tokens"])
		if _, exists := row["cache_hit_tokens"]; !exists {
			hit = number(row["cached_tokens"]) + number(row["cache_read_tokens"])
			total = number(row["input_tokens"])
		}
		row["cache_hit_rate"] = math.Min(1, ratio(hit, total))
	}
}

func finalizePayload(value any, parent, path string, body []byte) any {
	switch row := value.(type) {
	case map[string]any:
		for key, x := range row {
			row[key] = finalizePayload(x, key, path, body)
		}
		recalculateRates(row)
		if parent == "events" || parent == "drilldown_preview" {
			if items, ok := row["items"].([]any); ok {
				sort.SliceStable(items, func(i, j int) bool {
					a, _ := items[i].(map[string]any)
					b, _ := items[j].(map[string]any)
					if number(a["timestamp_ms"]) != number(b["timestamp_ms"]) {
						return number(a["timestamp_ms"]) > number(b["timestamp_ms"])
					}
					return number(a["id"]) > number(b["id"])
				})
				var input struct {
					Include map[string]struct {
						Limit int `json:"limit"`
					} `json:"include"`
				}
				_ = json.Unmarshal(body, &input)
				key := "events_page"
				if parent == "drilldown_preview" {
					key = parent
				}
				limit := input.Include[key].Limit
				if limit <= 0 {
					limit = 100
				}
				if len(items) > limit {
					items = items[:limit]
					row["has_more"] = true
				}
				row["items"] = items
				if len(items) > 0 {
					last, _ := items[len(items)-1].(map[string]any)
					row["next_before_ms"] = last["timestamp_ms"]
					row["next_before_id"] = last["id"]
				}
			}
		}
		if parent == "" {
			finalizeLatency(row, path)
			if strings.HasSuffix(path, "/monitoring/analytics") {
				monitoringsvc.FinalizeFederatedAnalytics(row)
			}
			if rows, ok := row["top_models_today"].([]any); ok {
				sortByMetric(rows, "calls")
				if len(rows) > 5 {
					row["top_models_today"] = rows[:5]
				}
			}
			if rows, ok := row["model_cost_rank"].([]any); ok {
				sortByMetric(rows, "cost")
			}
			if rows, ok := row["recent_failures"].([]any); ok {
				sortByMetric(rows, "timestamp_ms")
				limit := 5
				var input struct {
					Include struct {
						RecentFailures int `json:"recent_failures"`
					} `json:"include"`
				}
				_ = json.Unmarshal(body, &input)
				if input.Include.RecentFailures > 0 {
					limit = input.Include.RecentFailures
				}
				if len(rows) > limit {
					row["recent_failures"] = rows[:limit]
				}
			}
			// The existing collector/system cards continue using their established shape.
			if collector, ok := row["collector"].(map[string]any); ok {
				collector["upstream"] = ""
			}
		}
		return row
	case []any:
		for i, x := range row {
			row[i] = finalizePayload(x, parent, path, body)
		}
		if parent == "model_share" || parent == "model_stats" {
			sortByMetric(row, "calls")
		}
		if parent == "points" {
			var maximum float64
			for _, x := range row {
				m, _ := x.(map[string]any)
				maximum = math.Max(maximum, number(m["calls"]))
			}
			for _, x := range row {
				m, _ := x.(map[string]any)
				if _, ok := m["tone"]; !ok {
					continue
				}
				m["intensity"] = ratio(number(m["calls"]), maximum)
				tone := "good"
				if future, _ := m["future"].(bool); future {
					tone = "future"
				} else if number(m["calls"]) == 0 {
					tone = "empty"
				} else if number(m["failure_rate"]) >= .1 {
					tone = "bad"
				} else if number(m["failure_rate"]) > 0 {
					tone = "warn"
				}
				m["tone"] = tone
			}
		}
		if parent == "hourly_activity" {
			var calls, tokens float64
			for _, x := range row {
				m, _ := x.(map[string]any)
				calls += number(m["calls"])
				tokens += number(m["tokens"])
			}
			for _, x := range row {
				m, _ := x.(map[string]any)
				m["intensity"] = math.Max(ratio(number(m["calls"]), calls), ratio(number(m["tokens"]), tokens))
			}
		}
		if keys, ok := grouping[parent]; ok && len(keys) > 0 {
			sort.SliceStable(row, func(i, j int) bool {
				a, aok := row[i].(map[string]any)
				b, bok := row[j].(map[string]any)
				if !aok || !bok {
					return false
				}
				return number(a[keys[0]]) < number(b[keys[0]])
			})
		}
		if parent == "token_mix" || strings.HasSuffix(parent, "_contributors") {
			total := float64(0)
			for _, x := range row {
				m, _ := x.(map[string]any)
				if parent == "token_mix" {
					total += number(m["tokens"])
				} else {
					total += count(m)
				}
			}
			for _, x := range row {
				m, _ := x.(map[string]any)
				if parent == "token_mix" {
					m["share"] = ratio(number(m["tokens"]), total)
				} else {
					m["share"] = ratio(count(m), total)
				}
			}
		}
		if parent == "traffic_timeline" {
			var calls, tokens float64
			for _, x := range row {
				m, _ := x.(map[string]any)
				calls += number(m["calls"])
				tokens += number(m["tokens"])
			}
			for _, x := range row {
				m, _ := x.(map[string]any)
				m["calls_share"] = ratio(number(m["calls"]), calls)
				m["tokens_share"] = ratio(number(m["tokens"]), tokens)
			}
		}
		return row
	default:
		return value
	}
}

func sortByMetric(rows []any, key string) {
	sort.SliceStable(rows, func(i, j int) bool {
		a, _ := rows[i].(map[string]any)
		b, _ := rows[j].(map[string]any)
		return number(a[key]) > number(b[key])
	})
}

func finalizeLatency(row map[string]any, path string) {
	hints, _ := row["_federation"].(map[string]any)
	delete(row, "_federation")
	if hints == nil {
		return
	}
	samples, _ := hints["samples"].([]any)
	type distribution struct{ latency, ttft []float64 }
	all := distribution{}
	buckets := map[int64]*distribution{}
	apiBuckets := map[string]map[int64]*distribution{}
	for _, x := range samples {
		sample, _ := x.(map[string]any)
		bucket := int64(number(sample["bucket"]))
		d := buckets[bucket]
		if d == nil {
			d = &distribution{}
			buckets[bucket] = d
		}
		if n := number(sample["latency"]); n > 0 {
			all.latency = append(all.latency, n)
			d.latency = append(d.latency, n)
		}
		if n := number(sample["ttft"]); n > 0 {
			all.ttft = append(all.ttft, n)
			d.ttft = append(d.ttft, n)
		}
		key, _ := sample["api_key_hash"].(string)
		if apiBuckets[key] == nil {
			apiBuckets[key] = map[int64]*distribution{}
		}
		if apiBuckets[key][bucket] == nil {
			apiBuckets[key][bucket] = &distribution{}
		}
		if n := number(sample["latency"]); n > 0 {
			apiBuckets[key][bucket].latency = append(apiBuckets[key][bucket].latency, n)
		}
	}
	apply := func(target map[string]any, d distribution) {
		if target == nil {
			return
		}
		if len(d.latency) > 0 {
			var sum float64
			for _, n := range d.latency {
				sum += n
			}
			target["average_latency_ms"] = sum / float64(len(d.latency))
			if _, ok := target["p95_latency_ms"]; ok {
				sort.Float64s(d.latency)
				target["p95_latency_ms"] = d.latency[int(math.Ceil(float64(len(d.latency))*.95))-1]
			}
		}
		if len(d.ttft) > 0 {
			if _, ok := target["p95_ttft_ms"]; ok {
				sort.Float64s(d.ttft)
				target["p95_ttft_ms"] = d.ttft[int(math.Ceil(float64(len(d.ttft))*.95))-1]
			}
		}
	}
	if strings.HasSuffix(path, "/dashboard/summary") {
		target, _ := row["today"].(map[string]any)
		apply(target, all)
	} else {
		target, _ := row["summary"].(map[string]any)
		apply(target, all)
		if timeline, ok := row["timeline"].([]any); ok {
			for _, x := range timeline {
				target, _ := x.(map[string]any)
				if d := buckets[int64(number(target["bucket_ms"]))]; d != nil {
					apply(target, *d)
				}
			}
		}
		if timeline, ok := row["api_key_timeline"].([]any); ok {
			for _, x := range timeline {
				target, _ := x.(map[string]any)
				key, _ := target["api_key_hash"].(string)
				if d := apiBuckets[key][int64(number(target["bucket_ms"]))]; d != nil {
					apply(target, *d)
				}
			}
		}
	}
}
