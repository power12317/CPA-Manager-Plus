import { describe, expect, it } from 'vitest';
import { normalizeOailbNode } from './oailbNode';
import { collectUsageDetails, collectUsageDetailsWithEndpoint } from './usage';

describe('compact oailb node metadata', () => {
  it.each([
    undefined,
    null,
    '',
    {},
    'a'.repeat(64),
    '-node',
    'node-',
    'a_b',
    'a.b',
    'JWT.payload.signature',
    'node\ninjected',
  ])('rejects invalid labels: %s', (value) => {
    expect(normalizeOailbNode(value)).toBe('');
  });

  it.each(['unified-96', 'x', '9', 'a'.repeat(63)])('preserves a valid label: %s', (value) => {
    expect(normalizeOailbNode(value)).toBe(value);
  });

  it.each(['oailb_node', 'oailbNode'])('carries %s through the CPA Panel usage path', (key) => {
    const payload = {
      apis: {
        'POST /v1/responses': {
          models: {
            'gpt-test': {
              details: [
                {
                  timestamp: '2026-09-26T12:00:00Z',
                  source: 'codex.json',
                  [key]: 'UNIFIED-96',
                  tokens: { total_tokens: 3 },
                },
                {
                  timestamp: '2026-09-26T12:01:00Z',
                  source: 'codex.json',
                  tokens: { total_tokens: 2 },
                },
              ],
            },
          },
        },
      },
    };
    for (const collect of [collectUsageDetails, collectUsageDetailsWithEndpoint]) {
      const rows = collect(payload);
      expect(rows.map((row) => row.oailb_node)).toEqual(['unified-96', undefined]);
    }
  });
});
