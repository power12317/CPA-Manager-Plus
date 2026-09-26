import { describe, expect, it } from 'vitest';
import { parseLogLine } from './logParsing';
import { resolveStatusGroup } from './logTypes';

const line =
  '[2026-09-26 18:00:00] [aabb1122] [info ] [gin_logger.go:103] 200 | 21ms | 192.0.2.1 | POST "/v1/responses"';

describe('oailb node in existing Gin request logs', () => {
  it.each([' oailb_node=unified-96', ' | oailb_node=unified-96'])(
    'keeps the node when consuming method/path segments: %s',
    (suffix) => {
      const parsed = parseLogLine(line + suffix);
      expect(parsed).toMatchObject({
        raw: line + suffix,
        requestId: 'aabb1122',
        statusCode: 200,
        latency: '21ms',
        ip: '192.0.2.1',
        method: 'POST',
        path: '"/v1/responses"',
        oailbNode: 'unified-96',
        message: '',
      });
    }
  );

  it('keeps legacy logs unchanged and rejects full hosts or tokens as node labels', () => {
    expect(parseLogLine(line).oailbNode).toBeUndefined();
    for (const node of [
      'chat.gateway.unified-96.api.openai.com',
      'eyJhbGci.eyJob3N0.signature',
      '-bad',
      'a'.repeat(64),
    ]) {
      const parsed = parseLogLine(`${line} oailb_node=${node}`);
      expect(parsed.oailbNode).toBeUndefined();
      expect(parsed.message).toBe('');
      expect(parsed.method).toBe('POST');
    }
  });

  it('preserves surrounding text in non-pipe log lines', () => {
    expect(parseLogLine('info upstream finished oailb_node=UNIFIED-96 after retry')).toMatchObject({
      oailbNode: 'unified-96',
      message: 'upstream finished  after retry',
    });
  });

  it('does not consume a similarly named query parameter as log metadata', () => {
    const raw = line.replace('/v1/responses', '/v1/responses?oailb_node=client-value');
    expect(parseLogLine(raw)).toMatchObject({
      path: '"/v1/responses?oailb_node=client-value"',
      oailbNode: undefined,
    });
  });
});

const context = '[codex-9143911d-user@example.com-pro-windows.json] [01a0dd74] [01a0dda3]';
const prefix = `[2026-09-26 21:17:12] [8e520ac0] ${context} [info ] [gin_logger.go:114]`;
const models = 'gpt-6-sol/gpt-6-sol';
const suffix = '     172.25.0.1 | POST    "/v1/responses"';

describe('Gin node column and Codex context compatibility', () => {
  it.each([
    ['new node column', `200 | 12.884s | unified-195 | ${models} | 780/780 | ${suffix}`],
    [
      'previous trailing field',
      `200 |       12.884s | ${models} | 780/780 | ${suffix} oailb_node=unified-195`,
    ],
  ])('preserves every existing field with %s', (_name, body) => {
    const raw = `${prefix} ${body}`;
    expect(parseLogLine(raw)).toEqual({
      raw,
      timestamp: '2026-09-26 21:17:12',
      requestId: '8e520ac0',
      source: 'gin_logger.go:114',
      level: 'info',
      statusCode: 200,
      latency: '12.884s',
      oailbNode: 'unified-195',
      ip: '172.25.0.1',
      method: 'POST',
      path: '"/v1/responses"',
      message: `${context} | ${models} | 780/780`,
    });
  });

  it.each([
    `200 | 12.884s | - | ${models} | 780/780 | ${suffix}`,
    `200 |       12.884s | ${models} | 780/780 | ${suffix}`,
  ])('leaves unknown or absent nodes empty and preserves model and turn-state columns', (body) => {
    const parsed = parseLogLine(`${prefix} ${body}`);
    expect(parsed.oailbNode).toBeUndefined();
    expect(parsed.message).toBe(`${context} | ${models} | 780/780`);
    expect(parsed.statusCode).toBe(200);
    expect(parsed.source).toBe('gin_logger.go:114');
    expect(resolveStatusGroup(parsed.statusCode)).toBe('2xx');
  });

  it.each(['unified-195', '-', '200', 'aabbccdd', '12ms'])(
    'parses basic access logs with a node column: %s',
    (node) => {
      const raw = line.replace('21ms |', `21ms | ${node} |`);
      expect(parseLogLine(raw)).toMatchObject({
        requestId: 'aabb1122',
        statusCode: 200,
        latency: '21ms',
        oailbNode: node === '-' ? undefined : node,
        ip: '192.0.2.1',
        path: '"/v1/responses"',
        method: 'POST',
        message: '',
      });
    }
  );

  it.each(['unified-195', '200', 'aabbccdd', '12ms', '-'])(
    'does not confuse node %s with other request metadata',
    (node) => {
      const parsed = parseLogLine(
        `${prefix.replace('[info ]', '[error]')} 502 | 2m3s | ${node} | POST/1.2.3.4 | 780/780 | 2001:db8::1 | POST "/v1/responses" [credits] | upstream unavailable`
      );
      expect(parsed).toMatchObject({
        requestId: '8e520ac0',
        source: 'gin_logger.go:114',
        level: 'error',
        statusCode: 502,
        latency: '2m3s',
        oailbNode: node === '-' ? undefined : node,
        ip: '2001:db8::1',
        method: 'POST',
        path: '"/v1/responses"',
        message: `${context} | POST/1.2.3.4 | 780/780 | [credits] | upstream unavailable`,
      });
      expect(resolveStatusGroup(parsed.statusCode)).toBe('5xx');
    }
  );

  it('does not fabricate a missing response model or inherit a stale trailing node', () => {
    const raw = `${prefix} 200 | 12.884s | - | gpt-6-sol/ | 780/0 | ${suffix} oailb_node=unified-old`;
    const parsed = parseLogLine(raw);
    expect(parsed.oailbNode).toBeUndefined();
    expect(parsed.message).toBe(`${context} | gpt-6-sol/ | 780/0`);
    expect(parsed.raw).toBe(raw);
  });

  it.each([
    'chat.gateway.unified-195.api.openai.com',
    'eyJhbGci.eyJob3N0.signature',
    '780/780',
    models,
  ])('never treats %s as a compact node', (node) => {
    const parsed = parseLogLine(`${prefix} 200 | 12.884s | ${node} | ${suffix}`);
    expect(parsed.oailbNode).toBeUndefined();
    expect(parsed.message).toContain(node);
  });

  it('keeps empty context placeholders without changing the true request ID', () => {
    const raw =
      '[2026-09-26 21:17:12] [--------] [] [] [] [warn ] [gin_logger.go:114] 429 | 0s | - | / | 0/0 | - | POST "/v1/responses"';
    expect(parseLogLine(raw)).toMatchObject({
      requestId: undefined,
      statusCode: 429,
      level: 'warn',
      source: 'gin_logger.go:114',
      latency: '0s',
      oailbNode: undefined,
      ip: undefined,
      message: '[] [] [] | / | 0/0',
    });
  });
});
