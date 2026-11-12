import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import {
  basispointsApi,
  resolveBasispointsCredential,
  supportsBasispointsBinding,
} from './basispoints';

const file = {
  name: 'same.json',
  id: 'same.json',
  auth_index: 'auth-1',
  type: 'codex',
  basispoints_bind_supported: true,
};
afterEach(() => vi.restoreAllMocks());

describe('independent Office OAuth adapter', () => {
  it.each(['https://cpa.example/panel', 'https://manager/tools/api/instances/default'])(
    'captures one CPA at %s for every operation and never sends SIWC/Codex tokens',
    async (apiBase) => {
      const scope = { apiBase, managementKey: 'synthetic-key' };
      const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ files: [file] });
      const post = vi.spyOn(apiClient, 'post').mockResolvedValue({});
      const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({});
      const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({});
      const signal = new AbortController().signal;
      await basispointsApi.list(scope, signal);
      await basispointsApi.start(scope, file);
      await basispointsApi.bindingStatus(scope, file, signal);
      const redirect = 'https://bps.openai.com/official?state=s&code=a%2Bb';
      await basispointsApi.callback(scope, 's', redirect, signal);
      await basispointsApi.status(scope, 's', signal);
      await basispointsApi.cancel(scope, 's');
      await basispointsApi.patch(scope, file, true);
      for (const spy of [get, post, patch, remove])
        for (const call of spy.mock.calls) {
          expect(call[call.length - 1]).toMatchObject({
            baseURL: apiBase + '/v8/management',
            headers: { Authorization: 'Bearer synthetic-key' },
            cpampScopedRequest: true,
          });
        }
      expect(post).toHaveBeenCalledWith(
        '/oauth/basispoints/bind',
        { name: file.name },
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-CPAMP-Auth-File-Mutation-Identity': expect.any(String),
          }),
        })
      );
      expect(post).toHaveBeenCalledWith(
        '/oauth/callback',
        { provider: 'basispoints', state: 's', redirect_url: redirect },
        expect.objectContaining({ signal })
      );
      expect(patch).toHaveBeenCalledWith(
        '/credentials/fields',
        { name: file.name, use_basispoints: true },
        expect.anything()
      );
      expect(JSON.stringify([...post.mock.calls, ...patch.mock.calls])).not.toMatch(
        /use_siwc|access_token|refresh_token|code_verifier|siwc\/bind/
      );
    }
  );

  it('resolves qualified records to their exact instance and rejects switching or replacement', async () => {
    const id = 'a'.repeat(32);
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ files: [file] });
    const resolved = await resolveBasispointsCredential(
      { apiBase: 'https://manager/api/aggregate', managementKey: 'k' },
      {
        ...file,
        instanceId: id,
        instanceName: 'CPA A',
        name: '[CPA A] same.json',
        id: `@cpamp/${id}/same.json`,
        auth_index: `@cpamp/${id}/auth-1`,
      }
    );
    expect(resolved.scope.apiBase).toBe(`https://manager/api/instances/${id}`);
    expect(resolved.file.name).toBe('same.json');
    await expect(
      resolveBasispointsCredential(
        { apiBase: 'https://manager/api/instances/default', managementKey: 'k' },
        { ...file, instanceId: id }
      )
    ).rejects.toThrow('instance changed');
    get.mockResolvedValue({ files: [{ ...file, auth_index: 'replacement' }] });
    await expect(
      resolveBasispointsCredential({ apiBase: 'https://cpa', managementKey: 'k' }, file)
    ).rejects.toThrow();
    expect(() =>
      basispointsApi.start({ apiBase: 'https://manager/api/aggregate', managementKey: 'k' }, file)
    ).toThrow('Select one CPA');
  });

  it('disables older CPAs, runtime entries and non-Codex records', () => {
    for (const entry of [
      { ...file, basispoints_bind_supported: undefined },
      { ...file, basispoints_bind_supported: false },
      { ...file, runtime_only: true },
      { ...file, type: 'claude' },
    ])
      expect(supportsBasispointsBinding(entry)).toBe(false);
    expect(supportsBasispointsBinding(file)).toBe(true);
  });
});
