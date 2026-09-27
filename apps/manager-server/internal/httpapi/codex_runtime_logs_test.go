package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

// CPA publishes both execution modes through its existing queue. Changing the
// executor must not change the request-monitoring contract or credential filter.
func TestCodexRuntimeRequestMonitoringParity(t *testing.T) {
	for _, failed := range []bool{false, true} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("failed=%t/stream=%t", failed, stream), func(t *testing.T) {
				var native map[string]any
				for _, executor := range []string{"CodexExecutor", "CodexRuntimeExecutor"} {
					handler, db := newCompatHandler(t, testutil.NewConfig(t), nil)
					record := map[string]any{
						"timestamp": "2026-05-06T00:00:00Z", "request_id": "aabb1122",
						"provider": "codex", "executor_type": executor,
						"model": "gpt-5.4", "requested_model": "gpt-5.4", "resolved_model": "gpt-5.4", "response_model": "gpt-5.4-2026-03-05",
						"auth_index": "auth-one", "source": "shared.json", "auth_file_snapshot": "shared.json",
						"account_snapshot": "user@example.com", "auth_label_snapshot": "Shared Codex", "auth_provider_snapshot": "codex", "auth_account_id_snapshot": "account-one",
						"endpoint": "POST /v1/responses", "client_ip": "192.0.2.1", "user_agent": "test-client",
						"session_id": "session-one", "turn_id": "turn-one", "parent_session_id": "parent-one",
						"system": "windows", "turn_state_len": "780", "oailb_node": "unified-96", "access_token_sha256": strings.Repeat("a", 64),
						"stream": stream, "reasoning_effort": "high", "request_service_tier": "priority", "response_service_tier": "default",
						"input_tokens": 100, "output_tokens": 20, "cached_tokens": 30, "reasoning_tokens": 5, "total_tokens": 125,
						"latency_ms": 1500, "ttft_ms": 120, "failed": failed,
						"response_metadata": map[string]any{"trace": map[string]any{"primary_trace_id": "upstream-trace-one"}},
					}
					if failed {
						record["fail_status_code"] = 429
						record["fail_body"] = `{"error":{"message":"rate limited","code":"rate_limit_exceeded"}}`
					}
					raw, _ := json.Marshal(record)
					event, err := usage.NormalizeRaw(raw)
					if err != nil {
						t.Fatal(err)
					}
					if _, err := db.InsertEvents(context.Background(), []usage.Event{event}); err != nil {
						t.Fatal(err)
					}
					const query = `{"from_ms":1778025599000,"to_ms":1778025601000,"filters":{"providers":["codex"],"auth_indices":["auth-one"]},"include":{"events_page":{"limit":10}}}`
					rr := testutil.Request(t, handler, http.MethodPost, "/v0/management/monitoring/analytics", query, testutil.AdminKey)
					testutil.RequireStatus(t, rr, http.StatusOK)
					var response struct {
						Events struct {
							Items []map[string]any `json:"items"`
						} `json:"events"`
					}
					testutil.DecodeJSON(t, rr, &response)
					if len(response.Events.Items) != 1 {
						t.Fatalf("filtered request missing: %s", rr.Body.String())
					}
					row := response.Events.Items[0]
					for key, want := range map[string]any{
						"request_id": "aabb1122", "auth_index": "auth-one", "auth_file_snapshot": "shared.json", "auth_provider_snapshot": "codex",
						"model": "gpt-5.4", "response_model": "gpt-5.4-2026-03-05", "executor_type": executor,
						"session_id": "session-one", "turn_id": "turn-one", "parent_session_id": "parent-one", "oailb_node": "unified-96",
						"stream": stream, "failed": failed, "reasoning_effort": "high", "service_tier": "priority",
						"latency_ms": float64(1500), "ttft_ms": float64(120), "header_trace_id": "upstream-trace-one",
						"input_tokens": float64(100), "output_tokens": float64(20), "cached_tokens": float64(30), "reasoning_tokens": float64(5),
					} {
						if !reflect.DeepEqual(row[key], want) {
							t.Fatalf("%s %s = %#v, want %#v", executor, key, row[key], want)
						}
					}
					if failed && (row["fail_status_code"] != float64(429) || !strings.Contains(fmt.Sprint(row["fail_summary"]), "rate limited")) {
						t.Fatalf("upstream failure not retained: %#v", row)
					}
					if _, ok := row["fail_body"]; ok {
						t.Fatal("raw error body exposed by monitoring")
					}
					if _, ok := row["raw_json"]; ok {
						t.Fatal("raw event exposed by monitoring")
					}
					delete(row, "executor_type")
					delete(row, "event_hash")
					if native == nil {
						native = row
					} else if !reflect.DeepEqual(native, row) {
						t.Fatalf("native/runtime request metadata differ:\nnative=%#v\nruntime=%#v", native, row)
					}
				}
			})
		}
	}
}

func TestCodexRuntimeRequestLogProxyParity(t *testing.T) {
	for _, executor := range []string{"CodexExecutor", "CodexRuntimeExecutor"} {
		t.Run(executor, func(t *testing.T) {
			requestLog := "=== API REQUEST ===\nRequest ID: aabb1122\nExecutor: " + executor + "\nPOST /backend-api/codex/responses\n{\"model\":\"gpt-5.4\"}\n=== API RESPONSE ===\nStatus: 429\nX-Request-Id: upstream-trace-one\n{\"error\":{\"message\":\"rate limited\"}}\n"
			responses := map[string]string{
				"/v0/management/logs":                                          `{"lines":["[2026-09-27 12:00:00] [aabb1122] [info ] [gin_logger.go:114] 429 | 120ms | unified-96 | gpt-5.4/gpt-5.4 | 780/780 | 192.0.2.1 | POST \"/v1/responses\""],"line-count":1}`,
				"/v0/management/request-log-by-id/aabb1122":                    requestLog,
				"/v0/management/request-error-logs":                            `{"files":[{"name":"request-error-aabb1122.log"}]}`,
				"/v0/management/request-error-logs/request-error-aabb1122.log": requestLog,
			}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer cpa-key" {
					http.Error(w, "bad management key", 401)
					return
				}
				body, ok := responses[r.URL.Path]
				if !ok {
					http.NotFound(w, r)
					return
				}
				if strings.Contains(r.URL.Path, "aabb1122") {
					w.Header().Set("Content-Type", "text/plain")
					w.Header().Set("Content-Disposition", `attachment; filename="request-aabb1122.log"`)
				}
				_, _ = w.Write([]byte(body))
			}))
			t.Cleanup(upstream.Close)
			handler, _ := newCompatHandler(t, testutil.NewConfig(t), &store.Setup{CPAUpstreamURL: upstream.URL, ManagementKey: "cpa-key"})
			for path, body := range responses {
				rr := testutil.Request(t, handler, http.MethodGet, path, "", testutil.AdminKey)
				testutil.RequireStatus(t, rr, http.StatusOK)
				if rr.Body.String() != body {
					t.Fatalf("%s log content changed: %s", path, rr.Body.String())
				}
				if strings.Contains(path, "aabb1122") && rr.Header().Get("Content-Disposition") == "" {
					t.Fatal("log download attachment header lost")
				}
			}
		})
	}
}
