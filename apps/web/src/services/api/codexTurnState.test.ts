import { describe, expect, it } from 'vitest';
import { normalizeCodexTurnStateStatus } from './codexTurnState';

describe('codex turn-state ticket API normalization', () => {
  it('normalizes policy and redacted account ticket readiness', () => {
    const result = normalizeCodexTurnStateStatus({
      enabled: true,
      target_length: 292,
      ttl_seconds: 3600,
      fail_closed: true,
      models: ['gpt-6-astra'],
      harvest_proxy_url: 'socks5://user:***@proxy.example:1080',
      harvest_proxy_configured: true,
      accounts: [
        {
          id: 'codex-a.json',
          tickets: [{ model: 'gpt-6-astra', ready: true, length: 292, remaining_seconds: 120 }],
        },
      ],
    });

    expect(result).toMatchObject({ enabled: true, targetLength: 292, failClosed: true });
    expect(result.accounts[0].tickets[0]).toMatchObject({
      model: 'gpt-6-astra',
      ready: true,
      remainingSeconds: 120,
    });
  });
});
