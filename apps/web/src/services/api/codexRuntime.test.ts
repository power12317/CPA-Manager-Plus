import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import { codexRuntimeApi, normalizeCodexRuntimeState } from './codexRuntime';

afterEach(() => vi.restoreAllMocks());
const state = { enabled: false, credentials: [] };

describe('CPA-only Codex mode API', () => {
  it.each([
    {
      apiBase: 'https://manager.example/cpamp/api/instances/default',
      managementKey: 'cmp_admin_test',
    },
    { apiBase: 'https://cpa.example/panel', managementKey: 'cpa-key' },
  ])('pins the minimal contract to the selected CPA in $apiBase', async (scope) => {
    const signal = new AbortController().signal;
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(state);
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue(state);
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue(state);
    const config = expect.objectContaining({
      baseURL: scope.apiBase + '/v0/management',
      headers: { Authorization: 'Bearer ' + scope.managementKey },
      cpampScopedRequest: true,
      signal,
    });
    await codexRuntimeApi.status(scope, signal);
    expect(get).toHaveBeenLastCalledWith('/codex-runtime', config);
    const obsoleteConfig = { enabled: true, workers: [{ url: 'ws://internal', token: 'secret' }] };
    await codexRuntimeApi.update(obsoleteConfig, scope, signal);
    expect(patch).toHaveBeenLastCalledWith('/codex-runtime', { enabled: true }, config);
    const credential = {
      name: 'team/original account.json',
      enabled: true,
      worker_id: 'old-internal-id',
    };
    await codexRuntimeApi.setCredential(credential, scope, signal);
    expect(post).toHaveBeenLastCalledWith(
      '/codex-runtime/credentials',
      { name: 'team/original account.json', enabled: true },
      config
    );

    post.mockResolvedValue({
      login_id: 'login-1',
      url: 'https://auth.openai.com/authorize?state=one',
      state: 'one',
    });
    await codexRuntimeApi.startLogin({}, scope, signal);
    expect(post).toHaveBeenLastCalledWith('/codex-runtime/login/start', {}, config);
    await codexRuntimeApi.startLogin({ name: 'team/original account.json' }, scope, signal);
    expect(post).toHaveBeenLastCalledWith(
      '/codex-runtime/login/start',
      { name: 'team/original account.json' },
      config
    );
    const redirect = 'http://localhost:1455/auth/callback?code=a%2Bb&state=one';
    post.mockResolvedValueOnce({ status: 'completed' });
    await codexRuntimeApi.submitCallback('login-1', redirect, scope, signal);
    expect(post).toHaveBeenLastCalledWith(
      '/codex-runtime/login/callback',
      { login_id: 'login-1', redirect_url: redirect },
      config
    );
    get.mockResolvedValueOnce({ status: 'pending' });
    await codexRuntimeApi.loginStatus('login-1', scope, signal);
    expect(get).toHaveBeenLastCalledWith('/codex-runtime/login/status', config);
    expect(get.mock.calls[get.mock.calls.length - 1]?.[1]?.params).toEqual({ login_id: 'login-1' });
  });

  it('accepts the minimal state without topology and never retains legacy secrets or configuration', () => {
    expect(() => normalizeCodexRuntimeState({ status: 'ok' })).toThrow();
    expect(() => normalizeCodexRuntimeState({ supported: false })).toThrow();
    expect(normalizeCodexRuntimeState(state)).toEqual(state);
    const result = normalizeCodexRuntimeState({
      enabled: false,
      workers: [{ id: 'internal', token: 'hidden', url: 'ws://internal' }],
      credentials: [
        {
          name: 'team/original account.json',
          label: 'Account A',
          enabled: true,
          owner: 'cpa',
          status: 'cpa',
          worker_id: 'internal',
          access_token: 'hidden',
          refresh_token: 'hidden',
        },
      ],
    });
    expect(result).toEqual({
      enabled: false,
      credentials: [
        {
          name: 'team/original account.json',
          label: 'Account A',
          enabled: true,
          owner: 'cpa',
          status: 'cpa',
          account_id: undefined,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/hidden|worker|ws:\/\//);
    expect(
      normalizeCodexRuntimeState({
        enabled: false,
        credentials: [{ name: 'team/original account.json' }],
      }).credentials[0].label
    ).toBe('Codex 1');
  });

  it('does not accept device-code-only authorization instead of an official browser URL', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({ user_code: 'ABCD', login_id: 'one' });
    await expect(
      codexRuntimeApi.startLogin({}, { apiBase: 'http://cpa', managementKey: 'key' })
    ).rejects.toThrow();
  });
});
