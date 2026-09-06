import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('./client', () => ({
  apiClient: {
    get: mocks.get,
    post: mocks.post,
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
});

describe('oauthApi', () => {
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
});
