import { describe, expect, it } from 'vitest';
import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';
import { parseLogLine } from '@/features/logs/hooks/logParsing';
import { buildUsageDetailsFromAnalyticsEvents } from './analyticsAdapters';
import { buildEventRows } from './eventRows';

const fixture = (
  executor: string,
  failed: boolean,
  stream: boolean
): MonitoringAnalyticsEventRow => ({
  event_hash: 'one',
  request_id: 'aabb1122',
  timestamp_ms: Date.UTC(2026, 8, 27, 12),
  model: 'gpt-5.4',
  requested_model: 'gpt-5.4',
  resolved_model: 'gpt-5.4',
  response_model: 'gpt-5.4-2026-03-05',
  endpoint: 'POST /v1/responses',
  method: 'POST',
  path: '/v1/responses',
  auth_index: 'auth-one',
  source: 'shared.json',
  source_hash: 'source-one',
  api_key_hash: 'key-one',
  auth_file_snapshot: 'shared.json',
  auth_provider_snapshot: 'codex',
  account_snapshot: 'user@example.com',
  auth_label_snapshot: 'Shared Codex',
  auth_account_id_snapshot: 'account-one',
  executor_type: executor,
  reasoning_effort: 'high',
  service_tier: 'priority',
  session_id: 'session-one',
  turn_id: 'turn-one',
  parent_session_id: 'parent-one',
  stream,
  system: 'windows',
  turn_state_len: '780',
  oailb_node: 'unified-96',
  access_token_sha256: 'a'.repeat(64),
  input_tokens: 100,
  output_tokens: 20,
  reasoning_tokens: 5,
  cached_tokens: 30,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  total_tokens: 125,
  latency_ms: 1500,
  ttft_ms: 120,
  failed,
  fail_status_code: failed ? 429 : undefined,
  fail_summary: failed ? 'rate limited' : '',
  header_trace_id: 'upstream-trace-one',
});

const display = (event: MonitoringAnalyticsEventRow) =>
  buildEventRows(
    buildUsageDetailsFromAnalyticsEvents([event]),
    new Map(),
    new Map(),
    { byAuthIndex: new Map(), bySource: new Map(), byIdentityKey: new Map() },
    new Map(),
    {},
    new Map()
  )[0];

describe('Codex runtime existing log and request-monitoring display', () => {
  it.each([false, true])(
    'retains request correlation, diagnostics and token fields with failed=%s',
    (failed) => {
      for (const stream of [false, true]) {
        const native = display(fixture('CodexExecutor', failed, stream));
        const runtime = display(fixture('CodexRuntimeExecutor', failed, stream));
        expect(runtime).toEqual({
          ...native,
          executorType: 'CodexRuntimeExecutor',
          searchText: runtime.searchText,
        });
        expect(runtime).toMatchObject({
          requestId: 'aabb1122',
          provider: 'codex',
          providerIdentity: 'codex',
          authIndex: 'auth-one',
          accountId: 'account-one',
          requestedModel: 'gpt-5.4',
          responseModel: 'gpt-5.4-2026-03-05',
          sessionId: 'session-one',
          turnId: 'turn-one',
          parentSessionId: 'parent-one',
          failed,
          stream,
          latencyMs: 1500,
          ttftMs: 120,
          reasoningEffort: 'high',
          serviceTier: 'priority',
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 5,
          cachedTokens: 30,
          headerTraceId: 'upstream-trace-one',
          oailbNode: 'unified-96',
        });
        if (failed)
          expect(runtime).toMatchObject({ failStatusCode: 429, failSummary: 'rate limited' });
        const line = `[2026-09-27 12:00:00] [aabb1122] [shared.json] [session-one] [turn-one] [${failed ? 'error' : 'info '}] [gin_logger.go:114] ${failed ? 429 : 200} | 1.5s | unified-96 | gpt-5.4/gpt-5.4-2026-03-05 | 780/780 | 192.0.2.1 | POST "/v1/responses"`;
        expect(parseLogLine(line)).toMatchObject({
          requestId: runtime.requestId,
          statusCode: failed ? 429 : 200,
          latency: '1.5s',
          oailbNode: runtime.oailbNode,
          method: 'POST',
          path: '"/v1/responses"',
        });
        expect(parseLogLine(line).message).toContain('[shared.json] [session-one] [turn-one]');
      }
    }
  );
});
