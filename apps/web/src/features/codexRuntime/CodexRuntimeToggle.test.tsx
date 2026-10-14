import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRuntimeToggle } from './CodexRuntimeToggle';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

const mocks = vi.hoisted(() => ({
  api: { status: vi.fn() },
  auth: {
    apiBase: 'https://manager/api/instances/default',
    managementKey: 'admin',
    connectionStatus: 'connected',
    sessionMode: 'manager_embedded',
  },
  showNotification: vi.fn(),
  translate: (key: string) => key,
  onLoaded: vi.fn(),
  onDraftChange: vi.fn(),
}));

vi.mock('@/stores', () => ({
  useAuthStore: (selector: (state: typeof mocks.auth) => unknown) => selector(mocks.auth),
  useNotificationStore: (
    selector: (state: { showNotification: typeof mocks.showNotification }) => unknown
  ) => selector({ showNotification: mocks.showNotification }),
}));
vi.mock('@/services/api/codexRuntime', async (original) => ({
  ...(await original<object>()),
  codexRuntimeApi: mocks.api,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.translate }) }));

let view: ReactTestRenderer;
const element = (disabled = false) =>
  createElement(CodexRuntimeToggle, {
    disabled,
    onLoaded: mocks.onLoaded,
    onDraftChange: mocks.onDraftChange,
  });
const mount = async (disabled = false) => {
  await act(async () => {
    view = create(element(disabled));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};
const toggle = () => view.root.findByType(ToggleSwitch);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.status.mockReset().mockResolvedValue({ enabled: false });
  mocks.auth.apiBase = 'https://manager/api/instances/default';
  mocks.auth.managementKey = 'admin';
  mocks.auth.connectionStatus = 'connected';
  mocks.auth.sessionMode = 'manager_embedded';
});
afterEach(() => act(() => view?.unmount()));

describe('Single CPA Codex mode toggle', () => {
  it.each([false, true])(
    'renders one draft switch without authorization UI when enabled=%s',
    async (enabled) => {
      mocks.api.status.mockResolvedValue({ enabled });
      await mount();
      expect(view.root.findAllByType(ToggleSwitch)).toHaveLength(1);
      expect(toggle().props.checked).toBe(enabled);
      expect(view.root.findAllByType('button')).toHaveLength(0);
      expect(view.root.findAllByType('a')).toHaveLength(0);
      expect(view.root.findAllByType('details')).toHaveLength(0);
      expect(JSON.stringify(view.toJSON())).not.toMatch(
        /callback|reauthorize|credentials|login_id/
      );
      expect(mocks.onLoaded).toHaveBeenCalledWith(enabled);
    }
  );

  it('changes only the local draft and does not update CPA on switch click', async () => {
    await mount();
    await act(async () => toggle().props.onChange(true));
    expect(toggle().props.checked).toBe(true);
    expect(mocks.onDraftChange).toHaveBeenCalledWith(true);
    expect(mocks.api.status).toHaveBeenCalledTimes(1);
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
    expect(mocks.api.status).toHaveBeenCalledWith(
      { apiBase: 'https://single-cpa', managementKey: 'admin' },
      expect.any(AbortSignal)
    );
  });

  it('disables the draft switch while the parent is saving', async () => {
    await mount(true);
    expect(toggle().props.disabled).toBe(true);
    await act(async () => toggle().props.onChange(true));
    expect(mocks.onDraftChange).not.toHaveBeenCalled();
  });

  it('aborts stale reads when switching instances', async () => {
    let resolveStatus!: (value: { enabled: boolean }) => void;
    mocks.api.status.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      })
    );
    await mount();
    const signal = mocks.api.status.mock.calls[0][1] as AbortSignal;
    mocks.auth.apiBase = 'https://manager/api/instances/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    mocks.api.status.mockResolvedValue({ enabled: true });
    await act(async () => view.update(element()));
    expect(signal.aborted).toBe(true);
    await act(async () => resolveStatus({ enabled: true }));
    expect(mocks.onDraftChange).not.toHaveBeenCalled();
  });
});
