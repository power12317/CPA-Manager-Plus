import { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './client';
import { configFileApi } from './configFile';

afterEach(() => vi.restoreAllMocks());

describe('configFileApi instance scope', () => {
  it.each([
    'http://cpa.local:8317',
    'https://manager.local/prefix/api/instances/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://manager.local/prefix/api/instances/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ])('reads and saves the same raw YAML using the explicit CPA scope: %s', async (apiBase) => {
    const yaml = 'codex:\n  device-convergence: false\n  identity-confuse: true\n';
    const scope = { apiBase, managementKey: 'test-key' };
    const get = vi.spyOn(apiClient, 'getRaw').mockResolvedValue({
      data: yaml,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: new AxiosHeaders() },
    } as AxiosResponse);
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue(undefined);
    expect(await configFileApi.fetchConfigYaml(scope)).toBe(yaml);
    await configFileApi.saveConfigYaml(yaml, scope);
    const expected = {
      baseURL: `${apiBase}/v0/management`,
      cpampScopedRequest: true,
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    };
    expect(get).toHaveBeenCalledWith('/config.yaml', expect.objectContaining(expected));
    expect(put).toHaveBeenCalledWith('/config.yaml', yaml, expect.objectContaining(expected));
    expect(put.mock.calls[0][2]?.headers).toEqual(
      expect.objectContaining({ 'Content-Type': 'application/yaml' })
    );
  });
});
