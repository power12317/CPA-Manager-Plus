import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import { codexRuntimeApi, normalizeCodexRuntimeState } from './codexRuntime';

afterEach(() => vi.restoreAllMocks());
const state = { enabled: false, workers: [], credentials: [] };

describe('Codex runtime management API', () => {
  it.each([
    {
      apiBase: 'https://manager.example/cpamp/api/instances/default',
      managementKey: 'cmp_admin_test',
    },
    { apiBase: 'https://cpa.example/panel', managementKey: 'cpa-key' },
  ])('pins every request to the selected CPA in $apiBase', async (scope) => {
    const signal = new AbortController().signal;
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(state);
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue(state);
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue(state);
    const config = expect.objectContaining({
      baseURL: `${scope.apiBase}/v0/management`,
      headers: { Authorization: `Bearer ${scope.managementKey}` },
      cpampScopedRequest: true,
      signal,
    });
    await codexRuntimeApi.status(scope, signal);
    expect(get).toHaveBeenLastCalledWith('/codex-runtime', config);
    await codexRuntimeApi.update({ enabled: false }, scope, signal);
    expect(patch).toHaveBeenLastCalledWith('/codex-runtime', { enabled: false }, config);
    await codexRuntimeApi.update({ workers: [] }, scope, signal);
    expect(patch).toHaveBeenLastCalledWith('/codex-runtime', { workers: [] }, config);
    await codexRuntimeApi.setCredential(
      { name: 'fixed.json', worker_id: 'one', enabled: true },
      scope,
      signal
    );
    expect(post).toHaveBeenLastCalledWith(
      '/codex-runtime/credentials',
      { name: 'fixed.json', worker_id: 'one', enabled: true },
      config
    );
    post.mockResolvedValueOnce({ status: 'ok' });
    await codexRuntimeApi.test('one', scope, signal);
    expect(post).toHaveBeenLastCalledWith('/codex-runtime/test', { worker_id: 'one' }, config);
    post.mockResolvedValueOnce({
      login_id: 'login-1',
      url: 'https://auth.openai.com/authorize?state=one',
      state: 'one',
    });
    await codexRuntimeApi.startLogin('one', scope, signal);
    expect(post).toHaveBeenLastCalledWith(
      '/codex-runtime/login/start',
      { worker_id: 'one' },
      config
    );
    const redirect = 'http://localhost:1455/auth/callback?code=a%2Bb&state=one';
    post.mockResolvedValueOnce({ status: 'completed' });
    await codexRuntimeApi.submitCallback('one', 'login-1', redirect, scope, signal);
    expect(post).toHaveBeenLastCalledWith(
      '/codex-runtime/login/callback',
      { worker_id: 'one', login_id: 'login-1', redirect_url: redirect },
      config
    );
    get.mockResolvedValueOnce({ status: 'pending' });
    await codexRuntimeApi.loginStatus('one', 'login-1', scope, signal);
    expect(get).toHaveBeenLastCalledWith('/codex-runtime/login/status', config);
    expect(get.mock.calls[get.mock.calls.length - 1]?.[1]?.params).toEqual({
      worker_id: 'one',
      login_id: 'login-1',
    });
  });

  it('only accepts runtime state and excludes secrets from normalized metadata', () => {
    expect(() => normalizeCodexRuntimeState({ status: 'ok' })).toThrow();
    expect(() => normalizeCodexRuntimeState({ supported: false })).toThrow();
    const result = normalizeCodexRuntimeState({
      enabled: false,
      workers: [{ id: 'one', token: 'hidden', token_configured: true }],
      credentials: [
        { name: 'fixed.json', access_token: 'hidden', refresh_token: 'hidden', owner: 'cpa' },
      ],
    });
    expect(result.workers[0].token_configured).toBe(true);
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('does not accept device-code-only authorization in place of a browser URL', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({ user_code: 'ABCD', login_id: 'one' });
    await expect(
      codexRuntimeApi.startLogin('one', { apiBase: 'http://cpa', managementKey: 'key' })
    ).rejects.toThrow();
  });
});
