import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BasispointsBindDialog, BasispointsOAuthEntry } from './BasispointsBindDialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { OFFICE_CALLBACK, OFFICE_CLIENT_ID } from './bindingModel';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  callback: vi.fn(),
  status: vi.fn(),
  bindingStatus: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('@/services/api/basispoints', async (original) => ({
  ...(await original<object>()),
  basispointsApi: mocks,
  resolveBasispointsCredential: mocks.resolve,
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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope = { apiBase: 'https://manager/api/instances/default', managementKey: 'synthetic' };
const file = {
  name: 'codex.json',
  id: 'codex.json',
  type: 'codex',
  auth_index: '1',
  basispoints_bind_supported: true,
};
const session = () => ({
  status: 'ok',
  flow: 'basispoints',
  callback_mode: 'paste',
  state: 'office-state',
  expires_in: 300,
  url:
    'https://auth.openai.com/api/accounts/authorize?' +
    new URLSearchParams({
      client_id: OFFICE_CLIENT_ID,
      redirect_uri: OFFICE_CALLBACK,
      response_type: 'code',
      state: 'office-state',
      code_challenge_method: 'S256',
      code_challenge: 'a'.repeat(43),
      audience: 'https://api.openai.com/v1',
      scope: 'openid offline_access email profile organization.read',
    }),
});
let view: ReactTestRenderer | undefined;
const render = async () => {
  await act(async () => {
    view = create(<BasispointsBindDialog requestScope={scope} onClose={vi.fn()} />);
  });
};
const click = async (label: string) => {
  await act(async () => {
    await view!.root
      .findAllByType(Button)
      .find((node) => node.props.children === label)!
      .props.onClick();
  });
};
const text = () => JSON.stringify(view!.toJSON());
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([file]);
  mocks.resolve.mockResolvedValue({ scope, file });
  mocks.start.mockResolvedValue(session());
  mocks.status.mockResolvedValue({ status: 'wait' });
  mocks.bindingStatus.mockResolvedValue({
    status: 'valid',
    bound: true,
    bind_supported: true,
    use_basispoints: true,
  });
  mocks.callback.mockResolvedValue({ status: 'ok' });
  mocks.cancel.mockResolvedValue({ status: 'ok' });
});
afterEach(() => {
  act(() => view?.unmount());
  view = undefined;
  vi.useRealTimers();
});

describe('Basispoints independent Office authorization dialog', () => {
  it('submits the exact official callback, clears its code, and verifies the saved grant before success', async () => {
    await render();
    await click('basispoints.start');
    const callback = OFFICE_CALLBACK + '?code=a%2Bb&state=office-state';
    const input = view!.root
      .findAllByType(Input)
      .find((node) => node.props.label === 'basispoints.callback')!;
    expect(input.props.type).toBe('password');
    act(() => input.props.onChange({ target: { value: callback } }));
    await click('basispoints.submit');
    expect(mocks.callback).toHaveBeenCalledExactlyOnceWith(
      scope,
      'office-state',
      callback,
      expect.any(AbortSignal)
    );
    expect(
      view!.root.findAllByType(Input).find((node) => node.props.label === 'basispoints.callback')!
        .props.value
    ).toBe('');
    expect(text()).not.toContain('basispoints.success');
    mocks.status.mockResolvedValue({ status: 'ok' });
    mocks.resolve.mockResolvedValue({
      scope,
      file: { ...file, basispoints_bound: true, use_siwc: false, use_basispoints: true },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(text()).toContain('basispoints.success');
    expect(text()).not.toContain('a%2Bb');
    act(() => view!.unmount());
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('never declares a saved grant valid merely because the OAuth session is complete', async () => {
    await render();
    await click('basispoints.start');
    mocks.status.mockResolvedValue({ status: 'ok' });
    mocks.bindingStatus.mockResolvedValue({ status: 'invalid', bound: true, bind_supported: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(text()).toContain('basispoints.readback_failed');
    expect(text()).not.toContain('basispoints.success');
    mocks.resolve.mockResolvedValue({
      scope,
      file: { ...file, basispoints_bound: true, use_basispoints: true },
    });
    mocks.bindingStatus.mockResolvedValue({
      status: 'valid',
      bound: true,
      bind_supported: true,
      use_basispoints: true,
    });
    await click('common.retry');
    expect(text()).toContain('basispoints.success');
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('cancels a session returned after close, on its captured CPA only', async () => {
    let complete!: (value: ReturnType<typeof session>) => void;
    mocks.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    await render();
    await click('basispoints.start');
    act(() => view!.unmount());
    await act(async () => {
      complete(session());
    });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(scope, 'office-state');
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('expires and cancels while an in-flight poll is stuck; late completion cannot report success', async () => {
    let complete!: (value: { status: string }) => void;
    mocks.status.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    mocks.start.mockResolvedValue({ ...session(), expires_in: 1 });
    await render();
    await click('basispoints.start');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(text()).toContain('basispoints.expired');
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(scope, 'office-state');
    await act(async () => {
      complete({ status: 'ok' });
    });
    expect(text()).not.toContain('basispoints.success');
    expect(mocks.bindingStatus).not.toHaveBeenCalled();
  });

  it('cancels the original scope when switching CPA and aborts its pending requests', async () => {
    await render();
    await click('basispoints.start');
    const signal = mocks.status.mock.calls[0][2] as AbortSignal;
    const changed = { apiBase: 'https://other-cpa', managementKey: 'other' };
    await act(async () => {
      view!.update(<BasispointsBindDialog requestScope={changed} onClose={vi.fn()} />);
    });
    expect(signal.aborted).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(scope, 'office-state');
  });

  it('rejects a wrong grant flow and permits reopening for fresh reauthorization', async () => {
    mocks.start.mockResolvedValue({ ...session(), flow: 'siwc_bind' });
    await render();
    await click('basispoints.start');
    expect(text()).toContain('basispoints.failed');
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(scope, 'office-state');
    expect(mocks.status).not.toHaveBeenCalled();
    act(() => view!.unmount());
    mocks.start.mockResolvedValue(session());
    await render();
    await click('basispoints.start');
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(text()).toContain('basispoints.callback');
  });

  it('shows a disabled entry on older CPAs, without starting an authorization', async () => {
    mocks.list.mockResolvedValue([{ ...file, basispoints_bind_supported: undefined }]);
    await act(async () => {
      view = create(<BasispointsOAuthEntry requestScope={scope} disabled={false} />);
    });
    const button = view!.root.findByType(Button);
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toBe('basispoints.unsupported');
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
