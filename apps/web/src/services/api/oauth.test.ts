import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./client', () => ({
  apiClient: {
    get: mocks.get,
    post: mocks.post,
    delete: mocks.delete,
  },
  createScopedApiRequestConfig: (scope: { apiBase: string; managementKey: string }) => ({
    baseURL: `${scope.apiBase.replace(/\/+$/, '')}/v0/management`,
    headers: { Authorization: `Bearer ${scope.managementKey}` },
    cpampScopedRequest: true,
  }),
}));

import { oauthApi } from './oauth';

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.delete.mockReset();
});

describe('oauthApi', () => {
  it.each(['devin', 'meta'])('does not apply Codex platform options to %s', async (provider) => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/login', state: 'standard-flow' });
    await oauthApi.startAuth(provider, undefined, { clientSystem: 'windows' });
    expect(mocks.get).toHaveBeenCalledWith(`/${provider}-auth-url`, {
      params: provider === 'devin' ? { is_webui: true } : undefined,
    });
  });
  it('pins a flow started from all instances to its source for polling and callbacks', async () => {
    const root = { apiBase: 'https://manager.example/cpamp', managementKey: 'admin' };
    mocks.get.mockResolvedValueOnce({
      url: 'https://auth.example/authorize?state=flow-scope-test',
      state: '@cpamp/default/flow-scope-test',
    });
    const result = await oauthApi.startAuth('codex', root);
    expect(result.state).toBe('flow-scope-test');
    mocks.get.mockResolvedValueOnce({ status: 'wait' });
    await oauthApi.getAuthStatus(result.state!, {
      apiBase: 'https://another.example',
      managementKey: 'other',
    });
    expect(mocks.get).toHaveBeenLastCalledWith(
      '/get-auth-status',
      expect.objectContaining({
        baseURL: `${root.apiBase}/api/instances/default/v0/management`,
        headers: { Authorization: 'Bearer admin' },
        params: { state: 'flow-scope-test' },
      })
    );
    await oauthApi.submitCallback('codex', 'http://localhost/callback?state=flow-scope-test', root);
    expect(mocks.post).toHaveBeenLastCalledWith(
      '/oauth-callback',
      expect.anything(),
      expect.objectContaining({ baseURL: `${root.apiBase}/api/instances/default/v0/management` })
    );
  });
  it('marks built-in web UI OAuth starts with is_webui', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/codex', state: 'state-1' });

    await oauthApi.startAuth('codex');

    expect(mocks.get).toHaveBeenCalledWith('/codex-auth-url', {
      params: { is_webui: true },
    });
  });

  it('reads the Codex system-scoped OAuth capability', async () => {
    mocks.get.mockResolvedValue({ system_scoped_oauth: true });
    const requestScope = { apiBase: 'http://cpa.local:8317', managementKey: 'key' };

    await oauthApi.getCodexCapabilities(requestScope);

    expect(mocks.get).toHaveBeenCalledWith(
      '/codex-capabilities',
      expect.objectContaining({
        baseURL: `${requestScope.apiBase}/v0/management`,
        headers: { Authorization: 'Bearer key' },
      })
    );
  });

  it('adds client_system for system-scoped Codex OAuth', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/codex', state: 'state-windows' });

    await oauthApi.startAuth('codex', undefined, { clientSystem: 'windows' });

    expect(mocks.get).toHaveBeenCalledWith('/codex-auth-url', {
      params: { is_webui: true, client_system: 'windows' },
    });
  });

  it('passes auth_index when reauthorizing a selected Codex credential', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/codex', state: 'state-target' });

    await oauthApi.startAuth('codex', undefined, { authIndex: 'auth-7' });

    expect(mocks.get).toHaveBeenCalledWith('/codex-auth-url', {
      params: { is_webui: true, auth_index: 'auth-7' },
    });
  });

  it('starts plugin OAuth providers through their dynamic auth-url endpoint', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/plugin', state: 'state-2' });

    await oauthApi.startAuth('sample-provider');

    expect(mocks.get).toHaveBeenCalledWith('/sample-provider-auth-url', {
      params: undefined,
    });
  });

  it('pins auth-link, polling, and callback requests to the captured CPA scope', async () => {
    const requestScope = {
      apiBase: 'http://old-cpa.local:8317',
      managementKey: 'old-cpa-key',
    };
    const scopedConfig = {
      baseURL: 'http://old-cpa.local:8317/v0/management',
      headers: { Authorization: 'Bearer old-cpa-key' },
      cpampScopedRequest: true,
    };
    mocks.get
      .mockResolvedValueOnce({ url: 'https://auth.example/codex', state: 'state-1' })
      .mockResolvedValueOnce({ status: 'wait' });
    mocks.post.mockResolvedValue({ status: 'ok' });

    await oauthApi.startAuth('codex', requestScope);
    await oauthApi.getAuthStatus('state-1', requestScope);
    await oauthApi.submitCallback('codex', 'http://localhost/callback?code=1', requestScope);

    expect(mocks.get).toHaveBeenNthCalledWith(1, '/codex-auth-url', {
      ...scopedConfig,
      params: { is_webui: true },
    });
    expect(mocks.get).toHaveBeenNthCalledWith(2, '/get-auth-status', {
      ...scopedConfig,
      params: { state: 'state-1' },
    });
    expect(mocks.post).toHaveBeenCalledWith(
      '/oauth-callback',
      {
        provider: 'codex',
        redirect_url: 'http://localhost/callback?code=1',
      },
      scopedConfig
    );
  });

  it('starts Devin OAuth with is_webui flag', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/devin', state: 'state-devin-1' });

    await oauthApi.startAuth('devin');

    expect(mocks.get).toHaveBeenCalledWith('/devin-auth-url', {
      params: { is_webui: true },
    });
  });

  it('cancels an active OAuth session using DELETE /oauth-session with captured scope', async () => {
    const requestScope = {
      apiBase: 'http://cpa.example:8317',
      managementKey: 'cpa-key-1',
    };
    const scopedConfig = {
      baseURL: 'http://cpa.example:8317/v0/management',
      headers: { Authorization: 'Bearer cpa-key-1' },
      cpampScopedRequest: true,
    };
    mocks.delete.mockResolvedValue({ status: 'ok', cancelled: true });

    const result = await oauthApi.cancelSession('state-devin-1', requestScope);

    expect(mocks.delete).toHaveBeenCalledWith('/oauth-session', {
      ...scopedConfig,
      params: { state: 'state-devin-1' },
    });
    expect(result).toEqual({ status: 'ok', cancelled: true });
  });

  it.each(['devin', 'meta'])(
    'pins %s cancellation to the CPA that created a qualified OAuth state',
    async (provider) => {
      const aggregateScope = {
        apiBase: 'https://manager.example/cpamp',
        managementKey: 'aggregate-key',
      };
      mocks.get.mockResolvedValueOnce({
        url: 'https://auth.example/devin',
        state: '@cpamp/0123456789abcdef0123456789abcdef/devin-flow',
      });
      mocks.delete.mockResolvedValue({ status: 'ok', cancelled: true });

      const started = await oauthApi.startAuth(provider, aggregateScope);
      await oauthApi.cancelSession(started.state!, {
        apiBase: 'https://another-manager.example/cpamp',
        managementKey: 'other-key',
      });

      expect(mocks.delete).toHaveBeenLastCalledWith(
        '/oauth-session',
        expect.objectContaining({
          baseURL:
            'https://manager.example/cpamp/api/instances/0123456789abcdef0123456789abcdef/v0/management',
          headers: { Authorization: 'Bearer aggregate-key' },
          params: { state: 'devin-flow' },
        })
      );
    }
  );

  it('starts Meta OAuth without is_webui flag and preserves device flow fields', async () => {
    const metaResponse = {
      url: 'https://auth.example/device',
      state: 'state-meta-1',
      user_code: 'ABCD-EFGH',
      flow: 'device',
      expires_in: 600,
    };
    mocks.get.mockResolvedValue(metaResponse);

    const result = await oauthApi.startAuth('meta');

    expect(mocks.get).toHaveBeenCalledWith('/meta-auth-url', {
      params: undefined,
    });
    expect(result).toEqual(metaResponse);
  });
});
