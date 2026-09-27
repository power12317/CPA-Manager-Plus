import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRuntimeToggle } from './CodexRuntimeToggle';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

const mocks = vi.hoisted(() => ({
  api: { status: vi.fn(), update: vi.fn() },
  auth: {
    apiBase: 'https://manager/api/instances/default',
    managementKey: 'admin',
    connectionStatus: 'connected',
    sessionMode: 'manager_embedded',
  },
  showNotification: vi.fn(),
  translate: (key: string) => key,
  onOperationStart: vi.fn(() => true),
  onOperationEnd: vi.fn(async () => {}),
}));
vi.mock('@/stores', () => ({
  useAuthStore: (selector: (state: typeof mocks.auth) => unknown) => selector(mocks.auth),
  useNotificationStore: (selector: (state: typeof mocks) => unknown) => selector(mocks),
}));
vi.mock('@/services/api/codexRuntime', async (original) => ({
  ...(await original<object>()),
  codexRuntimeApi: mocks.api,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.translate }) }));

let view: ReactTestRenderer;
const scope = () => ({ apiBase: mocks.auth.apiBase, managementKey: mocks.auth.managementKey });
const element = (disabled = false) =>
  createElement(CodexRuntimeToggle, {
    disabled,
    onOperationStart: mocks.onOperationStart,
    onOperationEnd: mocks.onOperationEnd,
  });
const mount = async (disabled = false) => {
  await act(async () => {
    view = create(element(disabled));
  });
};
const toggle = () => view.root.findByType(ToggleSwitch);
const change = async (value: boolean) => {
  await act(async () => {
    toggle().props.onChange(value);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.status.mockReset().mockResolvedValue({ enabled: false });
  mocks.api.update.mockReset().mockResolvedValue({ enabled: true });
  mocks.auth.apiBase = 'https://manager/api/instances/default';
  mocks.auth.managementKey = 'admin';
  mocks.auth.connectionStatus = 'connected';
  mocks.auth.sessionMode = 'manager_embedded';
  mocks.onOperationStart.mockReturnValue(true);
});
afterEach(() => act(() => view?.unmount()));

describe('Single CPA Codex mode toggle', () => {
  it.each([false, true])(
    'renders just one setting with no authorization UI when enabled=%s',
    async (enabled) => {
      mocks.api.status.mockResolvedValue({ enabled });
      await mount();
      expect(view.root.findAllByType(ToggleSwitch)).toHaveLength(1);
      expect(toggle().props.checked).toBe(enabled);
      for (const tag of ['button', 'a', 'details', 'textarea', 'h1'] as const) {
        expect(view.root.findAllByType(tag)).toHaveLength(0);
      }
      expect(view.root.findAllByType('input').map((node) => node.props.type)).toEqual(['checkbox']);
      expect(JSON.stringify(view.toJSON())).not.toMatch(
        /callback|reauthorize|credentials|login_id/
      );
    }
  );

  it('saves only the current instance mode through the parent snapshot guard', async () => {
    await mount();
    await change(true);
    expect(mocks.api.update).toHaveBeenCalledExactlyOnceWith(
      { enabled: true },
      scope(),
      expect.any(AbortSignal)
    );
    expect(mocks.onOperationStart).toHaveBeenCalledWith(true);
    expect(mocks.onOperationEnd).toHaveBeenCalledWith(true);
    expect(toggle().props.checked).toBe(true);
  });

  it.each([404, 405, 501])('renders nothing for an unsupported CPA (%s)', async (status) => {
    mocks.api.status.mockRejectedValue({ status });
    await mount();
    expect(view.toJSON()).toBeNull();
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });

  it('never probes an aggregate Manager scope or disconnected CPA', async () => {
    mocks.auth.apiBase = 'https://manager';
    await mount();
    expect(mocks.api.status).not.toHaveBeenCalled();
    expect(view.toJSON()).toBeNull();
    mocks.auth.apiBase = 'https://manager/api/instances/default';
    mocks.auth.connectionStatus = 'disconnected';
    await act(async () => view.update(element()));
    expect(mocks.api.status).not.toHaveBeenCalled();
  });

  it('supports a direct CPA panel', async () => {
    mocks.auth.sessionMode = 'external_panel';
    mocks.auth.apiBase = 'https://single-cpa';
    await mount();
    expect(mocks.api.status).toHaveBeenCalledWith(scope(), expect.any(AbortSignal));
    await change(true);
    expect(mocks.api.update).toHaveBeenCalledWith(
      { enabled: true },
      scope(),
      expect.any(AbortSignal)
    );
  });

  it('blocks changes during parent saves and honors synchronous operation guards', async () => {
    await mount(true);
    expect(toggle().props.disabled).toBe(true);
    await change(true);
    expect(mocks.api.update).not.toHaveBeenCalled();
    await act(async () => view.update(element()));
    mocks.onOperationStart.mockReturnValue(false);
    await change(true);
    expect(mocks.api.update).not.toHaveBeenCalled();
    expect(mocks.onOperationEnd).not.toHaveBeenCalled();
  });

  it('reconciles an uncertain write and still refreshes the parent YAML snapshot', async () => {
    await mount();
    mocks.api.update.mockRejectedValue(new Error('lost response'));
    mocks.api.status.mockResolvedValue({ enabled: true });
    await change(true);
    expect(toggle().props.checked).toBe(true);
    expect(mocks.showNotification).toHaveBeenCalledWith('codex_runtime.action_failed', 'error');
    expect(mocks.onOperationEnd).toHaveBeenCalledWith(true);
  });

  it('discards a stale mutation response when switching instances', async () => {
    await mount();
    let resolveUpdate!: (value: { enabled: boolean }) => void;
    mocks.api.update.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      })
    );
    await change(true);
    const signal = mocks.api.update.mock.calls[0][2] as AbortSignal;
    mocks.auth.apiBase = 'https://manager/api/instances/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await act(async () => view.update(element()));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveUpdate({ enabled: true });
    });
    expect(toggle().props.checked).toBe(false);
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });
});
