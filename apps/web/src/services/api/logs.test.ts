import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    get: vi.fn(),
    delete: vi.fn(),
    getRaw: vi.fn(),
  },
}));

vi.mock('./client', () => ({
  apiClient: {
    get: mocks.get,
    delete: mocks.delete,
    getRaw: mocks.getRaw,
  },
}));

import { logsApi, normalizeLogsResponse } from './logs';

beforeEach(() => {
  mocks.get.mockReset();
  mocks.delete.mockReset();
  mocks.getRaw.mockReset();
});

describe('logs API', () => {
  it('preserves raw CPA runtime logs and uses the same request ID for request and error downloads', async () => {
    const line = '[2026-09-27 12:00:00] [aabb1122] [info ] CodexRuntimeExecutor upstream response';
    mocks.get.mockResolvedValue({ lines: [line], 'line-count': 1 });
    expect((await logsApi.fetchLogs()).lines).toEqual([line]);
    const response = { data: 'upstream request, response and error body' };
    mocks.getRaw.mockResolvedValue(response);
    expect(await logsApi.downloadRequestLogById('aabb1122')).toBe(response);
    expect(mocks.getRaw).toHaveBeenLastCalledWith('/request-log-by-id/aabb1122', {
      responseType: 'blob',
      timeout: expect.any(Number),
    });
    expect(await logsApi.downloadErrorLog('request-error-aabb1122.log')).toBe(response);
    expect(mocks.getRaw).toHaveBeenLastCalledWith(
      '/request-error-logs/request-error-aabb1122.log',
      { responseType: 'blob', timeout: expect.any(Number) }
    );
  });

  it('normalizes legacy timestamp-based log responses', () => {
    expect(
      normalizeLogsResponse({
        lines: ['a', 'b'],
        'line-count': 2,
        'latest-timestamp': 123,
      })
    ).toEqual({
      lines: ['a', 'b'],
      'line-count': 2,
      'latest-timestamp': 123,
      latestAfter: 123,
      nextCursor: undefined,
      cursorReset: false,
    });
  });

  it('normalizes cursor-based log responses', () => {
    expect(
      normalizeLogsResponse({
        lines: ['next'],
        lineCount: '1',
        latestAfter: '456',
        'next-cursor': 'cursor-2',
        'cursor-reset': 'true',
      })
    ).toEqual({
      lines: ['next'],
      'line-count': 1,
      'latest-timestamp': 0,
      latestAfter: 456,
      nextCursor: 'cursor-2',
      cursorReset: true,
    });
  });

  it('passes cursor, after, and limit query params when fetching logs', async () => {
    mocks.get.mockResolvedValue({ lines: [] });

    await logsApi.fetchLogs({ cursor: 'cursor-1', after: 123, limit: 100 });

    expect(mocks.get).toHaveBeenCalledWith('/logs', {
      params: { cursor: 'cursor-1', after: 123, limit: 100 },
      timeout: expect.any(Number),
    });
  });
});
