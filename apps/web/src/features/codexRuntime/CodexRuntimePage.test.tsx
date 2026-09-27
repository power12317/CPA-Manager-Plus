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
    test: vi.fn(),
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
  workers: [
    {
      id: 'one',
      url: 'ws://codex:38317',
      auth_file: 'fixed.json',
      token_configured: true,
      models: ['gpt-5'],
      disabled: false,
    },
  ],
  credentials: [
    {
      name: 'fixed.json',
      worker_id: 'one',
      enabled: true,
      owner: enabled ? 'codex' : 'cpa',
      status: 'ready',
    },
  ],
});
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

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.auth.apiBase = 'https://manager/api/instances/default';
  mocks.auth.managementKey = 'admin';
  mocks.auth.connectionStatus = 'connected';
});
afterEach(() => {
  act(() => view?.unmount());
});

describe('Codex runtime settings', () => {
  it('requires authorization to create a missing credential before editing its preference', async () => {
    await mount({
      ...state(true),
      credentials: [{ ...state(true).credentials[0], enabled: false, status: 'missing' }],
    });
    expect(toggle('codex_runtime.credential_enabled').props.disabled).toBe(true);
    expect(button('codex_runtime.authorize').props.disabled).toBe(false);
    await act(async () => {
      toggle('codex_runtime.credential_enabled').props.onChange(true);
    });
    expect(mocks.api.setCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).toContain('codex_runtime.missing_hint');
  });

  it('saves worker removal as an empty replacement list without changing the master preference', async () => {
    await mount(state());
    await click('common.delete');
    mocks.api.update.mockResolvedValue({ enabled: false, workers: [], credentials: [] });
    await click('codex_runtime.save_workers');
    expect(mocks.api.update.mock.calls[0][0]).toEqual({ workers: [] });
    expect(mocks.api.test).not.toHaveBeenCalled();
  });

  it('disables runtime actions for a disabled worker even when the master is enabled', async () => {
    await mount({ ...state(true), workers: [{ ...state().workers[0], disabled: true }] });
    expect(button('codex_runtime.test').props.disabled).toBe(true);
    expect(button('codex_runtime.authorize').props.disabled).toBe(true);
  });

  it('loads only local CPA state while off and disables all runtime network actions', async () => {
    await mount();
    expect(mocks.api.status).toHaveBeenCalledTimes(1);
    expect(toggle('codex_runtime.enabled').props.checked).toBe(false);
    expect(button('codex_runtime.test').props.disabled).toBe(true);
    expect(button('codex_runtime.authorize').props.disabled).toBe(true);
    // Event guards also reject stale/programmatic invocation of disabled controls.
    await click('codex_runtime.test');
    await click('codex_runtime.authorize');
    await click('common.refresh');
    expect(mocks.api.status).toHaveBeenCalledTimes(2);
    for (const key of ['test', 'startLogin', 'submitCallback', 'loginStatus'] as const)
      expect(mocks.api[key]).not.toHaveBeenCalled();
  });

  it('saves the master switch and keeps credential preferences while disabled', async () => {
    await mount(state(true));
    mocks.api.update.mockResolvedValue(state(false));
    await act(async () => {
      toggle('codex_runtime.enabled').props.onChange(false);
    });
    expect(mocks.api.update).toHaveBeenCalledWith(
      { enabled: false },
      { apiBase: mocks.auth.apiBase, managementKey: 'admin' },
      expect.any(AbortSignal)
    );
    expect(toggle('codex_runtime.credential_enabled').props.checked).toBe(true);
    expect(JSON.stringify(view.toJSON())).toContain('CPA');
    mocks.api.setCredential.mockResolvedValue({
      ...state(),
      credentials: [{ ...state().credentials[0], enabled: false }],
    });
    await act(async () => {
      toggle('codex_runtime.credential_enabled').props.onChange(false);
    });
    expect(mocks.api.setCredential).toHaveBeenCalledWith(
      { name: 'fixed.json', worker_id: 'one', enabled: false },
      expect.anything(),
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

  it('submits full callback URLs through CPA, then clears the callback on completion', async () => {
    await mount(state(true));
    mocks.api.startLogin.mockResolvedValue({
      login_id: 'login-one',
      url: 'https://auth.openai.com/authorize?state=abc',
      state: 'abc',
    });
    await click('codex_runtime.authorize');
    expect(view.root.findByType('a').props.href).toBe(
      'https://auth.openai.com/authorize?state=abc'
    );
    expect(button('codex_runtime.submit_callback').props.disabled).toBe(true);
    const callback = 'http://localhost:1455/auth/callback?code=a%2Bb&state=abc';
    act(() => input('codex_runtime.callback').props.onChange({ target: { value: callback } }));
    mocks.api.submitCallback.mockResolvedValue({ status: 'completed' });
    await click('codex_runtime.submit_callback');
    expect(mocks.api.submitCallback).toHaveBeenCalledWith(
      'one',
      'login-one',
      callback,
      { apiBase: mocks.auth.apiBase, managementKey: 'admin' },
      expect.any(AbortSignal)
    );
    expect(JSON.stringify(view.toJSON())).toContain('codex_runtime.login_completed');
    expect(JSON.stringify(view.toJSON())).not.toContain('code=a%2Bb');
    expect(mocks.api.loginStatus).not.toHaveBeenCalled();
  });

  it('checks a pending official login only on request and drops it when disabled', async () => {
    await mount(state(true));
    mocks.api.startLogin.mockResolvedValue({
      login_id: 'login-one',
      url: 'https://auth.openai.com/authorize?state=abc',
    });
    await click('codex_runtime.authorize');
    mocks.api.loginStatus.mockResolvedValue({ status: 'pending' });
    await click('codex_runtime.check_login');
    expect(mocks.api.loginStatus).toHaveBeenCalledTimes(1);
    mocks.api.update.mockResolvedValue(state(false));
    await act(async () => {
      toggle('codex_runtime.enabled').props.onChange(false);
    });
    expect(view.root.findAllByType('a')).toHaveLength(0);
    expect(button('codex_runtime.authorize').props.disabled).toBe(true);
    expect(mocks.api.loginStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps secrets write-only and saves workers with omitted blank tokens', async () => {
    await mount(state(true));
    expect(input('codex_runtime.token').props.value).toBe('');
    expect(input('codex_runtime.token').props.type).toBe('password');
    act(() => input('codex_runtime.url').props.onChange({ target: { value: 'ws://codex:38318' } }));
    expect(button('codex_runtime.authorize').props.disabled).toBe(true);
    mocks.api.update.mockResolvedValue({
      ...state(true),
      workers: [{ ...state().workers[0], url: 'ws://codex:38318' }],
    });
    await click('codex_runtime.save_workers');
    expect(mocks.api.update.mock.calls[0][0]).toEqual({
      workers: [
        {
          id: 'one',
          url: 'ws://codex:38318',
          auth_file: 'fixed.json',
          models: ['gpt-5'],
          disabled: false,
        },
      ],
    });
    act(() => input('codex_runtime.token').props.onChange({ target: { value: 'replacement' } }));
    await click('codex_runtime.save_workers');
    expect(mocks.api.update.mock.calls[1][0].workers[0].token).toBe('replacement');
    expect(input('codex_runtime.token').props.value).toBe('');
  });

  it('refreshes only CPA local state after a disabled-runtime 409', async () => {
    await mount(state(true));
    mocks.api.test.mockRejectedValue({ status: 409 });
    mocks.api.status.mockResolvedValue(state(false));
    await click('codex_runtime.test');
    expect(mocks.api.test).toHaveBeenCalledTimes(1);
    expect(button('codex_runtime.test').props.disabled).toBe(true);
    expect(JSON.stringify(view.toJSON())).toContain('codex_runtime.state_changed');
    expect(mocks.api.startLogin).not.toHaveBeenCalled();
  });

  it('aborts stale requests and clears transient secrets and OAuth state on instance changes', async () => {
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

  it('does not read or contact runtime services without a management connection', async () => {
    mocks.auth.connectionStatus = 'disconnected';
    await act(async () => {
      view = create(createElement(CodexRuntimePage));
    });
    expect(mocks.api.status).not.toHaveBeenCalled();
    expect(view.root.findAllByType(ToggleSwitch)).toHaveLength(0);
  });
});
