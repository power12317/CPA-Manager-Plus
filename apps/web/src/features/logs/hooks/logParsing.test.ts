import { describe, expect, it } from 'vitest';
import { parseLogLine } from './logParsing';

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
