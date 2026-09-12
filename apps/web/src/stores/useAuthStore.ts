/**
 * 认证状态管理
 * 从原项目 src/modules/login.js 和 src/core/connection.js 迁移
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  AuthSessionMode,
  AuthState,
  LoginCredentials,
  LoginResult,
  RestoreSessionResult,
  ConnectionStatus,
} from '@/types';
import { STORAGE_KEY_AUTH } from '@/utils/constants';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { apiClient } from '@/services/api/client';
import { usageServiceApi } from '@/services/api/usageService';
import { useConfigStore } from './useConfigStore';
import { useModelsStore } from './useModelsStore';
import { useQuotaStore } from './useQuotaStore';
import { useUsageServiceStore } from './useUsageServiceStore';
import { useUsageHeaderSnapshotStore } from './useUsageHeaderSnapshotStore';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';
import { sha256Hex } from '@/utils/apiKeyHash';
import { activateAggregateScope } from '@/utils/aggregateScope';
import {
  clearInstanceNavigation,
  managerRootBase,
  takeInstanceNavigation,
} from '@/utils/instanceScope';

interface AuthStoreState extends AuthState {
  sessionMode: AuthSessionMode | '';
  sessionPanelBase: string;
  connectionStatus: ConnectionStatus;
  connectionError: string | null;

  // 操作
  login: (credentials: LoginCredentials) => Promise<LoginResult>;
  switchInstanceScope: (base: string) => void;
  logout: () => void;
  checkAuth: () => Promise<boolean>;
  restoreSession: (options?: RestoreSessionOptions) => Promise<RestoreSessionResult>;
  updateServerVersion: (
    version: string | null,
    buildDate?: string | null,
    commit?: string | null
  ) => void;
  updateServerPluginSupport: (supportsPlugin: boolean) => void;
  updateConnectionStatus: (status: ConnectionStatus, error?: string | null) => void;
}

interface RestoreSessionOptions {
  expectedMode?: AuthSessionMode;
  expectedPanelBase?: string;
}

let restoreSessionPromise: Promise<RestoreSessionResult> | null = null;
let resolveAuthHydration!: () => void;
const authHydrationPromise = new Promise<void>((resolve) => {
  resolveAuthHydration = resolve;
});
const MANAGER_SESSION_KEY = 'cpamp-manager-session-key';

const readManagerSessionKey = (): string => {
  try {
    return sessionStorage.getItem(MANAGER_SESSION_KEY) || '';
  } catch {
    return '';
  }
};

const writeManagerSessionKey = (value: string): void => {
  try {
    if (value) sessionStorage.setItem(MANAGER_SESSION_KEY, value);
    else sessionStorage.removeItem(MANAGER_SESSION_KEY);
  } catch {
    /* Optional tab-scoped persistence. */
  }
};

const sessionMatchesExpectedRuntime = ({
  expectedMode,
  expectedPanelBase,
  resolvedBase,
  sessionMode,
}: {
  expectedMode?: AuthSessionMode;
  expectedPanelBase?: string;
  resolvedBase: string;
  sessionMode: AuthSessionMode | '';
}) => {
  const normalizedExpectedPanelBase = normalizeApiBase(expectedPanelBase || '');
  if (!expectedMode) return true;
  if (sessionMode && sessionMode !== expectedMode) return false;
  if (expectedMode === 'manager_embedded' && normalizedExpectedPanelBase) {
    return resolvedBase === normalizedExpectedPanelBase;
  }
  if (expectedMode === 'external_panel' && normalizedExpectedPanelBase) {
    return resolvedBase === normalizedExpectedPanelBase;
  }
  return true;
};

export const useAuthStore = create<AuthStoreState>()(
  persist(
    (set, get) => ({
      // 初始状态
      isAuthenticated: false,
      apiBase: '',
      managementKey: '',
      rememberPassword: false,
      serverVersion: null,
      serverCommit: null,
      serverBuildDate: null,
      supportsPlugin: false,
      sessionMode: '',
      sessionPanelBase: '',
      connectionStatus: 'disconnected',
      connectionError: null,

      // 恢复会话并自动登录
      restoreSession: (options) => {
        if (restoreSessionPromise) return restoreSessionPromise;

        restoreSessionPromise = (async () => {
          await authHydrationPromise;
          obfuscatedStorage.migratePlaintextKeys(['apiBase', 'apiUrl', 'managementKey']);

          const wasLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
          const legacyBase =
            obfuscatedStorage.getItem<string>('apiBase') ||
            obfuscatedStorage.getItem<string>('apiUrl', { encrypt: true });
          const legacyKey = obfuscatedStorage.getItem<string>('managementKey');
          const tabSessionKey = readManagerSessionKey();

          const { apiBase, managementKey, rememberPassword, sessionMode } = get();
          let resolvedBase = normalizeApiBase(apiBase || legacyBase || detectApiBaseFromLocation());
          const expectedBase = normalizeApiBase(options?.expectedPanelBase || '');
          const navigationKey = expectedBase ? takeInstanceNavigation(expectedBase) : '';
          if (
            options?.expectedMode === 'manager_embedded' &&
            expectedBase &&
            (navigationKey ||
              (sessionMode === 'manager_embedded' &&
                managerRootBase(resolvedBase) === managerRootBase(expectedBase)))
          ) {
            resolvedBase = expectedBase;
          }
          const resolvedKey = navigationKey || managementKey || legacyKey || tabSessionKey || '';
          const resolvedRememberPassword =
            rememberPassword || Boolean(managementKey) || Boolean(legacyKey);

          if (
            !sessionMatchesExpectedRuntime({
              expectedMode: options?.expectedMode,
              expectedPanelBase: options?.expectedPanelBase,
              resolvedBase,
              sessionMode,
            })
          ) {
            const fallbackBase = normalizeApiBase(
              options?.expectedPanelBase || detectApiBaseFromLocation()
            );
            set({
              apiBase: fallbackBase,
              managementKey: '',
              rememberPassword: false,
              sessionMode: options?.expectedMode ?? '',
              sessionPanelBase: normalizeApiBase(options?.expectedPanelBase || ''),
            });
            apiClient.setConfig({ apiBase: fallbackBase, managementKey: '' });
            writeManagerSessionKey('');
            localStorage.removeItem('isLoggedIn');
            return false;
          }

          set({
            apiBase: resolvedBase,
            managementKey: resolvedKey,
            rememberPassword: resolvedRememberPassword,
            sessionMode: options?.expectedMode ?? sessionMode,
            sessionPanelBase: normalizeApiBase(
              options?.expectedPanelBase || get().sessionPanelBase
            ),
          });
          apiClient.setConfig({ apiBase: resolvedBase, managementKey: resolvedKey });

          if ((wasLoggedIn || navigationKey || tabSessionKey) && resolvedBase && resolvedKey) {
            try {
              const restoredSessionMode = options?.expectedMode ?? (sessionMode || undefined);
              const result = await get().login({
                apiBase: resolvedBase,
                managementKey: resolvedKey,
                rememberPassword: resolvedRememberPassword,
                sessionMode: restoredSessionMode,
                sessionPanelBase: options?.expectedPanelBase || get().sessionPanelBase,
              });
              return result.recoveryMode ? result : {};
            } catch (error) {
              console.warn('Auto login failed:', error);
              return false;
            }
          }

          return false;
        })();

        return restoreSessionPromise;
      },

      // 登录
      login: async (credentials) => {
        const apiBase = normalizeApiBase(credentials.apiBase);
        const managementKey = credentials.managementKey.trim();
        const rememberPassword = credentials.rememberPassword ?? get().rememberPassword ?? false;
        const sessionMode = credentials.sessionMode ?? get().sessionMode;
        activateAggregateScope(sessionMode === 'manager_embedded' ? managerRootBase(apiBase) : '');
        const sessionPanelBase = normalizeApiBase(
          credentials.sessionPanelBase || get().sessionPanelBase
        );
        const quotaCacheScope = sha256Hex(`${apiBase}\u0000${managementKey}`);

        const markAuthenticated = (result: LoginResult = {}) => {
          useQuotaStore.getState().activateQuotaCacheScope(quotaCacheScope);
          apiClient.setConfig({ apiBase, managementKey });
          if (sessionMode === 'manager_embedded') writeManagerSessionKey(managementKey);
          set({
            isAuthenticated: true,
            apiBase,
            managementKey,
            rememberPassword,
            sessionMode,
            sessionPanelBase,
            connectionStatus: 'connected',
            connectionError: null,
          });
          if (sessionMode === 'manager_embedded' || rememberPassword) {
            localStorage.setItem('isLoggedIn', 'true');
          } else {
            localStorage.removeItem('isLoggedIn');
          }
          return result;
        };

        try {
          set({
            connectionStatus: 'connecting',
            supportsPlugin: false,
            serverVersion: null,
            serverCommit: null,
            serverBuildDate: null,
          });
          useModelsStore.getState().clearCache();

          // 配置 API 客户端
          apiClient.setConfig({
            apiBase,
            managementKey,
          });

          // 测试连接 - 获取配置
          try {
            await useConfigStore.getState().fetchConfig(undefined, true);
          } catch (error) {
            if (sessionMode !== 'manager_embedded') {
              throw error;
            }
            await usageServiceApi.getManagerConfig(apiBase, managementKey);
            useConfigStore.getState().clearCache();
            useUsageServiceStore.getState().setUsageServiceConfig(
              {
                enabled: true,
                serviceBase: apiBase,
              },
              {
                panelBase: sessionPanelBase || apiBase,
                panelHostMode: 'manager_embedded',
              }
            );
            return markAuthenticated({ recoveryMode: 'manager_config' });
          }

          // 登录成功
          return markAuthenticated();
        } catch (error: unknown) {
          const message =
            error instanceof Error
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Connection failed';
          set({
            connectionStatus: 'error',
            connectionError: message || 'Connection failed',
            supportsPlugin: false,
          });
          throw error;
        }
      },

      // Switching a Manager scope keeps the authenticated shell mounted. Request
      // generations and scoped caches isolate data without reloading the document.
      switchInstanceScope: (base) => {
        const state = get();
        const apiBase = normalizeApiBase(base);
        if (
          state.sessionMode !== 'manager_embedded' ||
          !state.isAuthenticated ||
          apiBase === state.apiBase ||
          managerRootBase(apiBase) !== managerRootBase(state.apiBase)
        )
          return;
        activateAggregateScope(managerRootBase(apiBase));
        apiClient.setConfig({ apiBase, managementKey: state.managementKey });
        useConfigStore.getState().clearCache();
        useModelsStore.getState().clearCache();
        useQuotaStore
          .getState()
          .activateQuotaCacheScope(sha256Hex(`${apiBase}\u0000${state.managementKey}`));
        useUsageHeaderSnapshotStore.getState().activateScope('');
        useUsageServiceStore
          .getState()
          .setUsageServiceConfig(
            { enabled: true, serviceBase: apiBase },
            { panelBase: apiBase, panelHostMode: 'manager_embedded' }
          );
        set({
          apiBase,
          sessionPanelBase: apiBase,
          serverVersion: null,
          serverBuildDate: null,
          serverCommit: null,
          supportsPlugin: false,
          connectionError: null,
          connectionStatus: 'connected',
        });
      },

      // 登出
      logout: () => {
        activateAggregateScope('');
        clearInstanceNavigation();
        writeManagerSessionKey('');
        restoreSessionPromise = null;
        useConfigStore.getState().clearCache();
        useModelsStore.getState().clearCache();
        useQuotaStore.getState().clearQuotaCache();
        useUsageServiceStore.getState().clearUsageServiceConfig();
        apiClient.setConfig({ apiBase: '', managementKey: '' });
        set({
          isAuthenticated: false,
          apiBase: '',
          managementKey: '',
          serverVersion: null,
          serverCommit: null,
          serverBuildDate: null,
          supportsPlugin: false,
          sessionMode: '',
          sessionPanelBase: '',
          connectionStatus: 'disconnected',
          connectionError: null,
        });
        localStorage.removeItem('isLoggedIn');
      },

      // 检查认证状态
      checkAuth: async () => {
        const { managementKey, apiBase } = get();

        if (!managementKey || !apiBase) {
          return false;
        }

        try {
          // 重新配置客户端
          apiClient.setConfig({ apiBase, managementKey });
          set({
            supportsPlugin: false,
            serverVersion: null,
            serverCommit: null,
            serverBuildDate: null,
          });

          // 验证连接
          await useConfigStore.getState().fetchConfig();

          set({
            isAuthenticated: true,
            connectionStatus: 'connected',
          });

          return true;
        } catch {
          set({
            isAuthenticated: false,
            connectionStatus: 'error',
            supportsPlugin: false,
          });
          return false;
        }
      },

      // 更新服务器版本
      updateServerVersion: (version, buildDate, commit) => {
        set({
          serverVersion: version || null,
          serverCommit: commit || null,
          serverBuildDate: buildDate || null,
        });
      },

      updateServerPluginSupport: (supportsPlugin) => {
        set({ supportsPlugin });
      },

      // 更新连接状态
      updateConnectionStatus: (status, error = null) => {
        set({
          connectionStatus: status,
          connectionError: error,
        });
      },
    }),
    {
      name: STORAGE_KEY_AUTH,
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          const data = obfuscatedStorage.getItem<AuthStoreState>(name);
          return data ? JSON.stringify(data) : null;
        },
        setItem: (name, value) => {
          obfuscatedStorage.setItem(name, JSON.parse(value));
        },
        removeItem: (name) => {
          obfuscatedStorage.removeItem(name);
        },
      })),
      partialize: (state) => ({
        apiBase: state.apiBase,
        ...(state.sessionMode === 'manager_embedded' || state.rememberPassword
          ? { managementKey: state.managementKey }
          : {}),
        rememberPassword: state.rememberPassword,
        serverVersion: state.serverVersion,
        serverBuildDate: state.serverBuildDate,
        sessionMode: state.sessionMode,
        sessionPanelBase: state.sessionPanelBase,
      }),
      onRehydrateStorage: () => {
        resolveAuthHydration();
      },
    }
  )
);

// 监听全局未授权事件
if (typeof window !== 'undefined') {
  window.addEventListener('unauthorized', () => {
    useAuthStore.getState().logout();
  });

  window.addEventListener('server-version-update', ((e: CustomEvent) => {
    const detail = e.detail || {};
    useAuthStore
      .getState()
      .updateServerVersion(detail.version || null, detail.buildDate || null, detail.commit || null);
  }) as EventListener);

  window.addEventListener('server-plugin-support-update', ((e: CustomEvent) => {
    useAuthStore.getState().updateServerPluginSupport(e.detail?.supportsPlugin === true);
  }) as EventListener);
}
