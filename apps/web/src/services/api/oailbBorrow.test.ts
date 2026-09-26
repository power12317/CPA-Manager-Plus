import axios, { type AxiosInstance } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { oailbBorrowApi, oailbBorrowErrorCode } from './oailbBorrow';

afterEach(() => vi.restoreAllMocks());

describe('oailbBorrowApi', () => {
  it('captures the target under the Manager prefix without sending source addresses or passwords from the browser', async () => {
    const get = vi.fn().mockResolvedValue({ data: { credentials: [] } });
    const put = vi.fn().mockResolvedValue({ data: { supported: true } });
    const create = vi
      .spyOn(axios, 'create')
      .mockReturnValue({ get, put } as unknown as AxiosInstance);
    const scope = {
      apiBase: 'https://manager.example/prefix/api/instances/default',
      managementKey: 'admin-key',
    };
    const api = oailbBorrowApi(scope, 'default');
    scope.apiBase = 'https://another.example';
    scope.managementKey = 'another-key';
    const signal = new AbortController().signal;
    await api.credentials('source-id', signal);
    await api.save({ sourceInstanceId: 'source-id', sourceAuthId: 'stable-id' }, signal);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://manager.example/prefix/api/instances/default/oailb-borrow',
        headers: { Authorization: 'Bearer admin-key' },
      })
    );
    expect(get).toHaveBeenCalledWith('/credentials', { params: { source: 'source-id' }, signal });
    expect(put).toHaveBeenCalledWith(
      '',
      { sourceInstanceId: 'source-id', sourceAuthId: 'stable-id' },
      { signal }
    );
  });

  it('only exposes known error codes and never displays upstream error text', () => {
    const error = {
      isAxiosError: true,
      response: { data: { code: 'private-secret', error: 'cookie-secret' } },
    };
    expect(oailbBorrowErrorCode(error)).toBe('oailb_borrow_unavailable');
    error.response.data.code = 'oailb_borrow_source_unsupported';
    expect(oailbBorrowErrorCode(error)).toBe('oailb_borrow_source_unsupported');
  });
});
