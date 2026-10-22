import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import { resolveSiwcCredential, siwcApi, supportsSiwcBinding } from './siwc';

const file = {
  name: 'same.json',
  id: 'same.json',
  auth_index: 'auth-1',
  type: 'codex',
  siwc_bind_supported: true,
  siwc_bound: true,
  use_siwc: false,
};
afterEach(() => vi.restoreAllMocks());

describe('temporary SIWC official v8 adapter', () => {
  it.each([
    'https://cpa.example/panel',
    'https://manager.example/tools/cpamp/api/instances/default',
  ])('pins every operation to the captured CPA at %s', async (apiBase) => {
    const scope = { apiBase, managementKey: 'saved-key' };
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ files: [file] });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({});
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({});
    const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({});
    const signal = new AbortController().signal;
    expect(await siwcApi.list(scope, signal)).toEqual([file]);
    await siwcApi.start(scope, file);
    const callback = 'http://127.0.0.1:1455/auth/callback?code=a%2Bb&state=s&client_id=issued';
    await siwcApi.callback(scope, callback, signal);
    await siwcApi.status(scope, 's', signal);
    await siwcApi.cancel(scope, 's');
    await siwcApi.patch(scope, file, { use_siwc: false });
    for (const spy of [get, post, patch, remove])
      for (const call of spy.mock.calls) {
        expect(call[call.length - 1]).toMatchObject({
          baseURL: apiBase + '/v8/management',
          headers: { Authorization: 'Bearer saved-key' },
          cpampScopedRequest: true,
        });
      }
    expect(post).toHaveBeenCalledWith(
      '/oauth/callback',
      { provider: 'codex', redirect_url: callback },
      expect.objectContaining({ signal })
    );
    expect(patch).toHaveBeenCalledWith(
      '/credentials/fields',
      { name: 'same.json', use_siwc: false },
      expect.anything()
    );
    expect(JSON.stringify(post.mock.calls)).not.toContain('codex-runtime');
  });

  it('resolves a qualified aggregate credential to its original CPA, not a same-name neighbor', async () => {
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ files: [file] });
    const resolved = await resolveSiwcCredential(
      { apiBase: 'https://manager/tools', managementKey: 'admin' },
      {
        ...file,
        name: '[CPA A] same.json',
        id: `@cpamp/${id}/same.json`,
        auth_index: `@cpamp/${id}/auth-1`,
        instanceId: id,
        instanceName: 'CPA A',
      }
    );
    expect(resolved.scope.apiBase).toBe(`https://manager/tools/api/instances/${id}`);
    expect(resolved.file).toEqual(file);
    expect(get.mock.calls[0][1]).toMatchObject({
      baseURL: `https://manager/tools/api/instances/${id}/v8/management`,
    });
    await expect(
      resolveSiwcCredential(
        { apiBase: 'https://manager/api/instances/default', managementKey: 'admin' },
        { ...file, instanceId: id }
      )
    ).rejects.toThrow('instance changed');
  });

  it('rejects replaced, virtual and unadvertised credentials', async () => {
    const get = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValue({ files: [{ ...file, auth_index: 'replacement' }] });
    await expect(
      resolveSiwcCredential({ apiBase: 'https://cpa', managementKey: 'key' }, file)
    ).rejects.toThrow();
    for (const entry of [
      { ...file, runtime_only: true },
      { ...file, siwc_bind_supported: false },
      { ...file, type: 'claude' },
    ]) {
      expect(supportsSiwcBinding(entry)).toBe(false);
      get.mockResolvedValue({ files: [entry] });
      await expect(
        resolveSiwcCredential({ apiBase: 'https://cpa', managementKey: 'key' }, file)
      ).rejects.toThrow();
    }
  });
});
