import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';
import type {
  CodexRuntimeCredential,
  CodexRuntimeLogin,
  CodexRuntimeLoginStatus,
  CodexRuntimeState,
} from '@/types/codexRuntime';
import { isRecord } from '@/utils/helpers';

const path = '/codex-runtime';
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export function normalizeCodexRuntimeState(value: unknown): CodexRuntimeState {
  if (isRecord(value) && value.supported === false) {
    throw Object.assign(new Error('Codex runtime is unsupported'), { status: 404 });
  }
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.credentials)) {
    throw new Error('Invalid Codex runtime state');
  }
  const credentials: CodexRuntimeCredential[] = value.credentials
    .filter(isRecord)
    .map((credential, index) => ({
      name: text(credential.name),
      label: text(credential.label) || `Codex ${index + 1}`,
      enabled: credential.enabled === true,
      owner: text(credential.owner),
      status: text(credential.status),
      account_id: text(credential.account_id) || undefined,
    }));
  // Explicitly project safe management metadata. OAuth tokens never enter page state.
  return { enabled: value.enabled, credentials };
}

export const isCodexRuntimeUnsupported = (error: unknown) =>
  isRecord(error) && (error.status === 404 || error.status === 405 || error.status === 501);

const config = (scope: ApiClientRequestScope, signal?: AbortSignal) => ({
  ...createScopedApiRequestConfig(scope),
  signal,
});

export const codexRuntimeApi = {
  status: async (scope: ApiClientRequestScope, signal?: AbortSignal) =>
    normalizeCodexRuntimeState(await apiClient.get(path, config(scope, signal))),

  update: async (
    { enabled }: { enabled: boolean },
    scope: ApiClientRequestScope,
    signal?: AbortSignal
  ) => normalizeCodexRuntimeState(await apiClient.patch(path, { enabled }, config(scope, signal))),

  setCredential: async (
    { name, enabled }: { name: string; enabled: boolean },
    scope: ApiClientRequestScope,
    signal?: AbortSignal
  ) =>
    normalizeCodexRuntimeState(
      await apiClient.post(`${path}/credentials`, { name, enabled }, config(scope, signal))
    ),

  startLogin: async (
    { name }: { name?: string },
    scope: ApiClientRequestScope,
    signal?: AbortSignal
  ) => {
    const value = await apiClient.post<CodexRuntimeLogin>(
      `${path}/login/start`,
      name ? { name } : {},
      config(scope, signal)
    );
    if (!value.login_id || !value.url || !/^https?:\/\//i.test(value.url)) {
      throw new Error('Invalid Codex browser OAuth response');
    }
    return { login_id: value.login_id, url: value.url, state: value.state };
  },

  submitCallback: (
    login_id: string,
    redirect_url: string,
    scope: ApiClientRequestScope,
    signal?: AbortSignal
  ) =>
    apiClient.post<CodexRuntimeLoginStatus>(
      `${path}/login/callback`,
      { login_id, redirect_url },
      config(scope, signal)
    ),

  loginStatus: (login_id: string, scope: ApiClientRequestScope, signal?: AbortSignal) =>
    apiClient.get<CodexRuntimeLoginStatus>(`${path}/login/status`, {
      ...config(scope, signal),
      params: { login_id },
    }),
};
