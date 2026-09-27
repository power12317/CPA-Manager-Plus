import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRuntimePage } from './CodexRuntimePage';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { CodexRuntimeState } from '@/types/codexRuntime';

const mocks = vi.hoisted(() => ({
  api: {
    status: vi.fn(),
    update: vi.fn(),
    setCredential: vi.fn(),
    startLogin: vi.fn(),
    submitCallback: vi.fn(),
    loginStatus: vi.fn(),
  },
  auth: {
    apiBase: 'https://manager/api/instances/default',
    managementKey: 'admin',
    connectionStatus: 'connected',
  },
}));
vi.mock('@/stores', () => ({
  useAuthStore: (selector: (state: typeof mocks.auth) => unknown) => selector(mocks.auth),
}));
vi.mock('@/services/api/codexRuntime', async (original) => ({
  ...(await original<object>()),
  codexRuntimeApi: mocks.api,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let view: ReactTestRenderer;
const state = (enabled = false): CodexRuntimeState => ({
  enabled,
  credentials: [
    {
      name: 'team/原有 account.json',
      label: 'Account A',
      enabled: true,
      owner: enabled ? 'codex' : 'cpa',
      status: enabled ? 'codex' : 'cpa',
    },
  ],
});
const scope = () => ({ apiBase: mocks.auth.apiBase, managementKey: mocks.auth.managementKey });
const mount = async (value = state()) => {
  mocks.api.status.mockResolvedValue(value);
  await act(async () => {
    view = create(createElement(CodexRuntimePage));
  });
};
const button = (key: string) =>
  view.root.findAllByType(Button).find((node) => node.props.children === key)!;
const input = (key: string) =>
  view.root.findAllByType(Input).find((node) => node.props.label === key)!;
const toggle = (key: string) =>
  view.root.findAllByType(ToggleSwitch).find((node) => node.props.ariaLabel === key)!;
const click = async (key: string) => {
  await act(async () => {
    button(key).props.onClick();
  });
};
const start = async () => {
  mocks.api.startLogin.mockResolvedValue({
    login_id: 'login-one',
    url: 'https://auth.openai.com/authorize?state=abc',
    state: 'abc',
  });
  await click('codex_runtime.authorize');
};

beforeEach(() => {
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.auth.apiBase = 'https://manager/api/instances/default';
  mocks.auth.managementKey = 'admin';
  mocks.auth.connectionStatus = 'connected';
});
afterEach(() => {
  act(() => view?.unmount());
});

describe('Minimal CPA-only Codex controls', () => {
  it('shows account labels and exposes no worker, secret, path or model configuration', async () => {
    await mount(state(true));
    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).toContain('Account A');
    expect(rendered).not.toContain('team/原有 account.json');
    expect(rendered).not.toMatch(
      /worker|ws:\/\/|codex_runtime.token|codex_runtime.models|codex_runtime.auth_file|codex_runtime.test/
    );
    expect(view.root.findAllByType(Input)).toHaveLength(0);
    expect(view.root.findAllByType('textarea')).toHaveLength(0);
    expect(view.root.findAllByType(ToggleSwitch)).toHaveLength(2);
  });

  it('reads local CPA state while off and blocks both new authorization and reauthorization', async () => {
    await mount();
    expect(button('codex_runtime.authorize').props.disabled).toBe(true);
    expect(button('codex_runtime.reauthorize').props.disabled).toBe(true);
    await click('codex_runtime.authorize');
    await click('codex_runtime.reauthorize');
    await click('common.refresh');
    expect(mocks.api.status).toHaveBeenCalledTimes(2);
    for (const key of ['startLogin', 'submitCallback', 'loginStatus'] as const)
      expect(mocks.api[key]).not.toHaveBeenCalled();
  });

  it('saves only the mode switch and preserves existing credential preferences while off', async () => {
    await mount(state(true));
    mocks.api.update.mockResolvedValue(state(false));
    await act(async () => {
      toggle('codex_runtime.enabled').props.onChange(false);
    });
    expect(mocks.api.update).toHaveBeenCalledWith(
      { enabled: false },
      scope(),
      expect.any(AbortSignal)
    );
    expect(toggle('codex_runtime.credential_enabled').props.checked).toBe(true);
    mocks.api.setCredential.mockResolvedValue({
      ...state(),
      credentials: [{ ...state().credentials[0], enabled: false }],
    });
    await act(async () => {
      toggle('codex_runtime.credential_enabled').props.onChange(false);
    });
    expect(mocks.api.setCredential).toHaveBeenCalledWith(
      { name: 'team/原有 account.json', enabled: false },
      scope(),
      expect.any(AbortSignal)
    );
  });

  it.each([404, 405, 501])('disables unsupported CPA versions on HTTP %s', async (status) => {
    mocks.api.status.mockRejectedValue({ status });
    await act(async () => {
      view = create(createElement(CodexRuntimePage));
    });
    expect(JSON.stringify(view.toJSON())).toContain('codex_runtime.unsupported');
    expect(view.root.findAllByType(ToggleSwitch)).toHaveLength(0);
  });

  it('lets CPA choose new authorization and sends only the selected name for explicit reauthorization', async () => {
    await mount(state(true));
    await start();
    expect(mocks.api.startLogin).toHaveBeenLastCalledWith({}, scope(), expect.any(AbortSignal));
    await click('codex_runtime.reauthorize');
    expect(mocks.api.startLogin).toHaveBeenLastCalledWith(
      { name: 'team/原有 account.json' },
      scope(),
      expect.any(AbortSignal)
    );
    expect(JSON.stringify(view.toJSON())).not.toContain('team/原有 account.json');
  });

  it('shows a CPA authorization error without choosing or overwriting an existing account', async () => {
    await mount(state(true));
    mocks.api.startLogin.mockRejectedValue({
      status: 400,
      message: 'Official authorization could not start',
    });
    await click('codex_runtime.authorize');
    expect(mocks.api.startLogin).toHaveBeenCalledTimes(1);
    expect(mocks.api.startLogin.mock.calls[0][0]).toEqual({});
    expect(JSON.stringify(view.toJSON())).toContain('Official authorization could not start');
    expect(view.root.findAllByType('a')).toHaveLength(0);
    expect(button('codex_runtime.reauthorize').props.disabled).toBe(false);
  });

  it('submits a complete callback using only login_id and clears it after completion', async () => {
    await mount(state(true));
    await start();
    expect(view.root.findByType('a').props.href).toBe(
      'https://auth.openai.com/authorize?state=abc'
    );
    expect(button('codex_runtime.submit_callback').props.disabled).toBe(true);
    const callback = 'http://localhost:1455/auth/callback?code=a%2Bb&state=abc';
    act(() => input('codex_runtime.callback').props.onChange({ target: { value: callback } }));
    mocks.api.submitCallback.mockResolvedValue({ status: 'completed' });
    await click('codex_runtime.submit_callback');
    expect(mocks.api.submitCallback).toHaveBeenCalledWith(
      'login-one',
      callback,
      scope(),
      expect.any(AbortSignal)
    );
    expect(JSON.stringify(view.toJSON())).toContain('codex_runtime.login_completed');
    expect(JSON.stringify(view.toJSON())).not.toContain('code=a%2Bb');
    expect(mocks.api.loginStatus).not.toHaveBeenCalled();
  });

  it('checks pending login only on request, reports errors and clears the flow when disabled', async () => {
    await mount(state(true));
    await start();
    mocks.api.loginStatus.mockResolvedValue({
      status: 'error',
      error: 'Official authorization expired',
    });
    await click('codex_runtime.check_login');
    expect(mocks.api.loginStatus).toHaveBeenCalledWith(
      'login-one',
      scope(),
      expect.any(AbortSignal)
    );
    expect(JSON.stringify(view.toJSON())).toContain('Official authorization expired');
    expect(view.root.findAllByType('a')).toHaveLength(0);
    mocks.api.update.mockResolvedValue(state(false));
    await act(async () => {
      toggle('codex_runtime.enabled').props.onChange(false);
    });
    expect(JSON.stringify(view.toJSON())).not.toContain('Official authorization expired');
    expect(mocks.api.loginStatus).toHaveBeenCalledTimes(1);
  });

  it('refreshes only CPA local state after a disabled-mode 409', async () => {
    await mount(state(true));
    mocks.api.startLogin.mockRejectedValue({ status: 409 });
    mocks.api.status.mockResolvedValue(state(false));
    await click('codex_runtime.authorize');
    expect(mocks.api.startLogin).toHaveBeenCalledTimes(1);
    expect(button('codex_runtime.authorize').props.disabled).toBe(true);
    expect(JSON.stringify(view.toJSON())).toContain('codex_runtime.state_changed');
  });

  it('aborts stale requests and discards OAuth state on instance changes', async () => {
    await mount(state(true));
    let resolveLogin!: (value: unknown) => void;
    mocks.api.startLogin.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogin = resolve;
        })
    );
    await click('codex_runtime.authorize');
    const signal = mocks.api.startLogin.mock.calls[0][2] as AbortSignal;
    mocks.auth.apiBase = 'https://other-cpa';
    mocks.api.status.mockResolvedValue(state(false));
    await act(async () => {
      view.update(createElement(CodexRuntimePage));
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveLogin({ login_id: 'old', url: 'https://old-login' });
    });
    expect(view.root.findAllByType('a')).toHaveLength(0);
    expect(toggle('codex_runtime.enabled').props.checked).toBe(false);
    const latest = mocks.api.status.mock.calls.find(
      (call) => call[0].apiBase === 'https://other-cpa'
    );
    expect(latest).toBeDefined();
    act(() => view.unmount());
    expect(latest![1].aborted).toBe(true);
  });

  it('does not read CPA state without a management connection', async () => {
    mocks.auth.connectionStatus = 'disconnected';
    await act(async () => {
      view = create(createElement(CodexRuntimePage));
    });
    expect(mocks.api.status).not.toHaveBeenCalled();
    expect(view.root.findAllByType(ToggleSwitch)).toHaveLength(0);
  });
});
