import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiwcBindDialog } from './SiwcBindDialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  callback: vi.fn(),
  status: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('@/services/api/siwc', async (original) => ({
  ...(await original<object>()),
  siwcApi: mocks,
  resolveSiwcCredential: mocks.resolve,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock('@/components/ui/Select', () => ({ Select: () => <select /> }));
const scope = { apiBase: 'https://cpa', managementKey: 'key' };
const file = {
  name: 'codex.json',
  id: 'codex.json',
  type: 'codex',
  auth_index: '1',
  siwc_bind_supported: true,
};
let view: ReactTestRenderer;
const click = async (label: string) => {
  const button = view.root.findAllByType(Button).find((node) => node.props.children === label)!;
  await act(async () => {
    await button.props.onClick();
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([file]);
  mocks.resolve.mockResolvedValue({ scope, file });
  mocks.start.mockResolvedValue({
    status: 'ok',
    flow: 'siwc_bind',
    state: 'session',
    url: 'https://auth.openai.com/authorize?state=session',
    expires_in: 300,
  });
  mocks.status.mockResolvedValue({ status: 'wait' });
  mocks.callback.mockResolvedValue({ status: 'ok' });
  mocks.cancel.mockResolvedValue({ status: 'ok' });
});
afterEach(() => {
  act(() => view?.unmount());
  vi.useRealTimers();
});

describe('SIWC binding dialog', () => {
  it('submits the unchanged issued-client callback and verifies the saved credential before success', async () => {
    await act(async () => {
      view = create(createElement(SiwcBindDialog, { requestScope: scope, onClose: vi.fn() }));
    });
    await click('siwc.start');
    const callback =
      'http://127.0.0.1:1455/auth/callback?code=a%2Bb&state=session&client_id=issued';
    act(() =>
      view.root
        .findAllByType(Input)
        .find((node) => node.props.label === 'siwc.callback')!
        .props.onChange({ target: { value: callback } })
    );
    await click('siwc.submit');
    expect(mocks.callback).toHaveBeenCalledExactlyOnceWith(
      scope,
      callback,
      expect.any(AbortSignal)
    );
    expect(JSON.stringify(view.toJSON())).not.toContain('siwc.success');
    mocks.status.mockResolvedValue({ status: 'ok' });
    mocks.resolve.mockResolvedValue({ scope, file: { ...file, siwc_bound: true, use_siwc: true } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(JSON.stringify(view.toJSON())).toContain('siwc.success');
    act(() => view.unmount());
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('distinguishes authorization success from failed credential verification', async () => {
    await act(async () => {
      view = create(createElement(SiwcBindDialog, { requestScope: scope, onClose: vi.fn() }));
    });
    await click('siwc.start');
    mocks.status.mockResolvedValue({ status: 'ok' });
    mocks.resolve.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(JSON.stringify(view.toJSON())).toContain('siwc.readback_failed');
    expect(JSON.stringify(view.toJSON())).not.toContain('siwc.success');
  });

  it('aborts polling and cancels the original session when the dialog is removed', async () => {
    await act(async () => {
      view = create(createElement(SiwcBindDialog, { requestScope: scope, onClose: vi.fn() }));
    });
    await click('siwc.start');
    const signal = mocks.status.mock.calls[0][2] as AbortSignal;
    act(() => view.unmount());
    expect(signal.aborted).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(scope, 'session');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.status).toHaveBeenCalledTimes(1);
  });
});
