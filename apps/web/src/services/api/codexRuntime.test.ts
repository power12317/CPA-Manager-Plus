import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import { codexRuntimeApi, normalizeCodexRuntimeState } from './codexRuntime';

afterEach(() => vi.restoreAllMocks());

describe('CPA Codex mode switch API', () => {
  it.each([
    {
      apiBase: 'https://manager.example/cpamp/api/instances/default',
      managementKey: 'cmp_admin_test',
    },
    { apiBase: 'https://cpa.example/panel', managementKey: 'cpa-key' },
  ])('reads and writes only the mode in the selected CPA at $apiBase', async (scope) => {
    const signal = new AbortController().signal;
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ enabled: false });
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ enabled: true });
    const config = expect.objectContaining({
      baseURL: scope.apiBase + '/v0/management',
      headers: { Authorization: 'Bearer ' + scope.managementKey },
      cpampScopedRequest: true,
      signal,
    });
    expect(await codexRuntimeApi.status(scope, signal)).toEqual({ enabled: false });
    expect(get).toHaveBeenCalledExactlyOnceWith('/codex-runtime', config);
    const extraFields = {
      enabled: true,
      credentials: [{ name: 'private-account' }],
      token: 'secret',
    };
    expect(await codexRuntimeApi.update(extraFields, scope, signal)).toEqual({ enabled: true });
    expect(put).toHaveBeenCalledExactlyOnceWith('/codex-runtime', { enabled: true }, config);
  });

  it('ignores all account, authorization and topology data in the response', () => {
    expect(
      normalizeCodexRuntimeState({
        enabled: false,
        credentials: [{ name: 'private-account', access_token: 'secret' }],
        workers: [{ url: 'ws://private' }],
      })
    ).toEqual({ enabled: false });
    expect(() => normalizeCodexRuntimeState({ status: 'ok' })).toThrow();
    expect(() => normalizeCodexRuntimeState({ supported: false })).toThrow();
  });
});
