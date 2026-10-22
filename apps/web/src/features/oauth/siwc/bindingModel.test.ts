import { describe, expect, it, vi } from 'vitest';
import { createSiwcStart, isSiwcCallbackValid } from './bindingModel';

describe('temporary SIWC callback and lifecycle', () => {
  const url = 'http://127.0.0.1:1455/auth/callback?code=a%2Bb&state=session&client_id=issued';
  it('requires the exact redirect, matching state and issued client_id without rewriting the URL', () => {
    expect(isSiwcCallbackValid(url, 'session')).toBe(true);
    for (const invalid of [
      url.replace('&client_id=issued', ''),
      url + '&state=session',
      url + '#fragment',
      url.replace('127.0.0.1', 'localhost'),
      url.replace('state=session', 'state=other'),
      url.replace('/auth/callback', '/other'),
      url.replace('http:', 'https:'),
    ])
      expect(isSiwcCallbackValid(invalid, 'session')).toBe(false);
    expect(
      isSiwcCallbackValid(
        'http://127.0.0.1:1455/auth/callback?state=session&error=access_denied',
        'session'
      )
    ).toBe(true);
  });

  it('cancels a late start on its captured connection and never delivers it to a closed dialog', async () => {
    let resolve!: (result: { state: string }) => void;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const onResult = vi.fn();
    const onError = vi.fn();
    const attempt = createSiwcStart({
      start: () =>
        new Promise<{ state: string }>((done) => {
          resolve = done;
        }),
      cancel,
      onResult,
      onError,
    });
    const pending = attempt.start();
    attempt.close();
    resolve({ state: 'old-cpa-session' });
    await pending;
    attempt.close();
    expect(cancel).toHaveBeenCalledExactlyOnceWith('old-cpa-session');
    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not cancel a completed session or start twice', async () => {
    const start = vi.fn().mockResolvedValue({ state: 'done' });
    const cancel = vi.fn();
    const attempt = createSiwcStart({ start, cancel, onResult: vi.fn(), onError: vi.fn() });
    await attempt.start();
    await attempt.start();
    attempt.complete();
    attempt.close();
    expect(start).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });
});
