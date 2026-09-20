import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexTurnStateApi, normalizeCodexTurnStateStatus } from './codexTurnState';
import { apiClient } from './client';

afterEach(() => vi.restoreAllMocks());

describe('codex turn-state ticket API normalization', () => {
  it('保存仅返回 status:ok，不作为完整配置归一化', async () => {
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ status: 'ok' });
    const payload = {
      enabled: true,
      fail_closed: false,
      harvest_proxy_url: '',
      models: ['astra'],
      target_length: 292,
      ttl_seconds: 2700,
      refresh_before_seconds: 600,
      probe_interval_seconds: 6,
      attempt_timeout_seconds: 25,
    };
    expect(await codexTurnStateApi.update(payload)).toBeUndefined();
    expect(put).toHaveBeenCalledWith('/codex-turn-state-ticket', payload);
  });

  it('拒绝将非配置响应当作默认策略，保留实例 URL 和认证范围', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ status: 'ok' });
    const scope = { apiBase: 'https://manager/api/instances/a', managementKey: 'admin' };
    await expect(codexTurnStateApi.status(scope)).rejects.toThrow();
    expect(get).toHaveBeenCalledWith(
      '/codex-turn-state-ticket',
      expect.objectContaining({
        baseURL: 'https://manager/api/instances/a/v0/management',
        cpampScopedRequest: true,
        headers: { Authorization: 'Bearer admin' },
      })
    );
  });
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

    expect(result).toMatchObject({
      enabled: true,
      targetLength: 292,
      failClosed: true,
      probeIntervalSeconds: 60,
    });
    expect(result.accounts[0].tickets[0]).toMatchObject({
      model: 'gpt-6-astra',
      ready: true,
      remainingSeconds: 120,
    });
  });
});
