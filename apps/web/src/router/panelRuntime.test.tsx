import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionMode } from '@/types/auth';

const mocks = vi.hoisted(() => ({
  auth: {
    isAuthenticated: false,
    apiBase: 'https://cpa.local/panel',
    managementKey: 'remembered-key',
    rememberPassword: true,
    sessionMode: 'external_panel' as AuthSessionMode,
    connectionStatus: 'connected',
    supportsPlugin: false,
    login: vi.fn(),
    restoreSession: vi.fn(),
    logout: vi.fn(),
  },
  getInfo: vi.fn(),
  setUsageServiceConfig: vi.fn(),
  showNotification: vi.fn(),
  navigate: vi.fn(),
  fetchConfig: vi.fn(),
  clearCache: vi.fn(),
  translate: (key: string) => key,
}));

function mockAuthStore(select: (state: typeof mocks.auth) => unknown) {
  return select(mocks.auth);
}
vi.mock('@/stores', () => ({
  useAuthStore: Object.assign(mockAuthStore, { getState: () => mocks.auth }),
  useUsageServiceStore: (select: (state: unknown) => unknown) =>
    select({ setUsageServiceConfig: mocks.setUsageServiceConfig }),
  useConfigStore: (select: (state: unknown) => unknown) =>
    select({
      config: { pluginsEnabled: false },
      fetchConfig: mocks.fetchConfig,
      clearCache: mocks.clearCache,
    }),
  useLanguageStore: (select: (state: unknown) => unknown) => select({ language: 'zh-CN' }),
  useThemeStore: (select: (state: unknown) => unknown) => select({ theme: 'white' }),
  useVisualEffectsStore: (select: (state: unknown) => unknown) => select({ mode: 'reduced' }),
  useNotificationStore: () => ({ showNotification: mocks.showNotification }),
}));
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: Object.assign(mockAuthStore, { getState: () => mocks.auth }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.translate }) }));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/config', search: '', state: null }),
  useNavigate: () => mocks.navigate,
  NavLink: ({ to, title, children }: { to: string; title: string; children: ReactNode }) => (
    <a href={to} title={title}>
      {children}
    </a>
  ),
  Navigate: ({ to, replace }: { to: string; replace: boolean }) => (
    <span data-redirect={to} data-replace={replace} />
  ),
}));
vi.mock('@/services/api/usageService', () => ({
  usageServiceApi: { getInfo: mocks.getInfo },
  isUsageServiceId: (id: string) => id === 'cpa-manager-plus' || id === 'cpa-manager',
  getUsageServiceErrorCode: () => '',
  USAGE_SERVICE_LAST_CPA_BASE_KEY: 'last-cpa',
  LEGACY_USAGE_SERVICE_LAST_CPA_BASE_KEY: 'legacy-last-cpa',
}));
vi.mock('@/services/api', () => ({ pluginsApi: { list: vi.fn() } }));
vi.mock('@/hooks/usePanelFeatureAvailability', () => ({
  usePanelFeatureAvailability: () => ({ requestMonitoringAvailable: false }),
}));
vi.mock('@/hooks/useHeaderRefresh', () => ({ triggerHeaderRefresh: vi.fn() }));
vi.mock('@/components/common/DatabaseMaintenanceContext', () => ({
  DatabaseMaintenanceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/common/DatabaseMaintenanceBanner', () => ({
  DatabaseMaintenanceBanner: () => null,
}));
vi.mock('@/components/common/PageTransition', () => ({ PageTransition: () => null }));
vi.mock('@/router/MainRoutes', () => ({ MainRoutes: () => null }));
vi.mock('@/features/cluster/InstanceBar', () => ({ InstanceBar: () => <div data-scope-picker /> }));
vi.mock('@/features/cluster/Instances', () => ({ Instances: () => <div data-instance-list /> }));
vi.mock('@/features/config/ConfigPage', () => ({
  ConfigPage: ({ managerOnly }: { managerOnly?: boolean }) => (
    <div data-manager-config={managerOnly} />
  ),
}));

import { LoginPage } from '@/features/login/LoginPage';
import { MainLayout } from '@/components/layout/MainLayout';
import { InstancesPage } from '@/pages/InstancesPage';
import { ManagerConfigPage } from '@/pages/ManagerConfigPage';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', {
    location: {
      protocol: 'https:',
      hostname: 'cpa.local',
      port: '',
      pathname: '/panel/management.html',
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal('document', { documentElement: { style: { removeProperty: vi.fn() } } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  mocks.auth.sessionMode = 'external_panel';
  mocks.auth.apiBase = 'https://cpa.local/panel';
  mocks.auth.managementKey = 'remembered-key';
  mocks.auth.isAuthenticated = false;
  mocks.auth.restoreSession.mockResolvedValue(false);
  mocks.auth.login.mockResolvedValue({});
  mocks.fetchConfig.mockResolvedValue({});
  mocks.getInfo.mockRejectedValue({ status: 404 });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CPA panel and Manager runtime boundaries', () => {
  it('logs into the CPA serving the panel with its management key and preserves the proxy prefix', async () => {
    // A saved connection must not silently redirect this panel to another CPA.
    mocks.auth.apiBase = 'https://old-cpa.local';
    await act(async () => {
      renderer = create(<LoginPage />);
    });
    expect(mocks.auth.restoreSession).toHaveBeenCalledWith({
      expectedMode: 'external_panel',
      expectedPanelBase: 'https://cpa.local/panel',
    });
    const input = renderer.root.findByType(Input);
    expect(input.props.label).toBe('login.cpa_management_key_label');
    expect(input.props.value).toBe('remembered-key');
    await act(async () => input.props.onChange({ target: { value: 'cpa-key' } }));
    await act(async () => renderer.root.findByType(Button).props.onClick());
    expect(mocks.auth.login).toHaveBeenCalledWith({
      apiBase: 'https://cpa.local/panel',
      managementKey: 'cpa-key',
      rememberPassword: true,
      sessionMode: 'external_panel',
      sessionPanelBase: 'https://cpa.local/panel',
    });
    expect(mocks.setUsageServiceConfig).toHaveBeenCalledWith(
      { enabled: false, serviceBase: '' },
      { panelBase: 'https://cpa.local/panel', panelHostMode: 'external_panel' }
    );
  });

  it('keeps the independent Manager login and its administrator credential', async () => {
    mocks.auth.sessionMode = 'manager_embedded';
    mocks.getInfo.mockResolvedValue({ service: 'cpa-manager-plus', configured: true });
    await act(async () => {
      renderer = create(<LoginPage />);
    });
    expect(mocks.auth.restoreSession).toHaveBeenCalledWith({
      expectedMode: 'manager_embedded',
      expectedPanelBase: 'https://cpa.local/panel',
    });
    expect(renderer.root.findByType(Input).props.label).toBe('login.admin_key_label');
    await act(async () => renderer.root.findByType(Button).props.onClick());
    expect(mocks.auth.login).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBase: 'https://cpa.local/panel',
        managementKey: 'remembered-key',
        sessionMode: 'manager_embedded',
      })
    );
  });

  it('restores a remembered CPA session without changing it into Manager mode', async () => {
    vi.useFakeTimers();
    mocks.auth.restoreSession.mockResolvedValue({});
    await act(async () => {
      renderer = create(<LoginPage />);
    });
    expect(mocks.auth.restoreSession).toHaveBeenCalledWith({
      expectedMode: 'external_panel',
      expectedPanelBase: 'https://cpa.local/panel',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
    expect(mocks.auth.login).not.toHaveBeenCalled();
  });

  it('retains a known Manager session when host detection temporarily fails', async () => {
    mocks.auth.sessionMode = 'manager_embedded';
    mocks.auth.apiBase = 'https://cpa.local/panel/api/instances/default';
    mocks.getInfo.mockRejectedValue({ status: 502 });
    await act(async () => {
      renderer = create(<LoginPage />);
    });
    expect(mocks.auth.restoreSession).toHaveBeenCalledWith(
      expect.objectContaining({ expectedMode: 'manager_embedded' })
    );
    expect(renderer.root.findByType(Input).props.label).toBe('login.admin_key_label');
  });

  it('does not revive a stale Manager password after CPA session restoration rejects it', async () => {
    mocks.auth.sessionMode = 'manager_embedded';
    mocks.auth.restoreSession.mockImplementation(async () => {
      mocks.auth.managementKey = '';
      return false;
    });
    await act(async () => {
      renderer = create(<LoginPage />);
    });
    expect(mocks.auth.restoreSession).toHaveBeenCalledWith(
      expect.objectContaining({ expectedMode: 'external_panel' })
    );
    expect(renderer.root.findByType(Input).props.value).toBe('');
  });

  it('shows direct instance configuration without cluster controls in a CPA panel', async () => {
    await act(async () => {
      renderer = create(<MainLayout />);
    });
    const links = renderer.root.findAllByType('a');
    expect(links.find((link) => link.props.href === '/config')?.props.title).toBe(
      'nav.instance_config'
    );
    expect(links.some((link) => ['/instances', '/manager-config'].includes(link.props.href))).toBe(
      false
    );
    expect(renderer.root.findAllByProps({ 'data-scope-picker': true })).toHaveLength(0);
  });

  it('retains instance management, settings, and scope selection in the independent Manager', async () => {
    mocks.auth.sessionMode = 'manager_embedded';
    await act(async () => {
      renderer = create(<MainLayout />);
    });
    const paths = renderer.root.findAllByType('a').map((link) => link.props.href);
    expect(paths).toContain('/instances');
    expect(paths).toContain('/manager-config');
    expect(renderer.root.findAllByProps({ 'data-scope-picker': true })).toHaveLength(1);
  });

  it.each([InstancesPage, ManagerConfigPage])(
    'redirects a bookmarked Manager page before mounting its API consumers',
    async (Page) => {
      await act(async () => {
        renderer = create(<Page />);
      });
      expect(renderer.root.findByProps({ 'data-redirect': '/config' }).props['data-replace']).toBe(
        true
      );
      expect(renderer.root.findAllByProps({ 'data-instance-list': true })).toHaveLength(0);
      expect(renderer.root.findAllByProps({ 'data-manager-config': true })).toHaveLength(0);
    }
  );

  it('keeps Manager pages accessible in Manager mode', async () => {
    mocks.auth.sessionMode = 'manager_embedded';
    await act(async () => {
      renderer = create(
        <>
          <InstancesPage />
          <ManagerConfigPage />
        </>
      );
    });
    expect(renderer.root.findAllByProps({ 'data-instance-list': true })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-manager-config': true })).toHaveLength(1);
  });
});
