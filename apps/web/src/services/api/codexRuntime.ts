import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';
import type {
  CodexRuntimeCredential,
  CodexRuntimeLogin,
  CodexRuntimeLoginStatus,
  CodexRuntimeState,
  CodexRuntimeWorker,
  CodexRuntimeWorkerInput,
} from '@/types/codexRuntime';
import { isRecord } from '@/utils/helpers';

const path = '/codex-runtime';
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export function normalizeCodexRuntimeState(value: unknown): CodexRuntimeState {
  if (isRecord(value) && value.supported === false) {
    throw Object.assign(new Error('Codex runtime is unsupported'), { status: 404 });
  }
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.workers) ||
    !Array.isArray(value.credentials)
  ) {
    throw new Error('Invalid Codex runtime state');
  }
  const workers: CodexRuntimeWorker[] = value.workers.filter(isRecord).map((worker) => ({
    id: text(worker.id),
    url: text(worker.url),
    auth_file: text(worker.auth_file),
    token_configured: worker.token_configured === true,
    models: Array.isArray(worker.models)
      ? worker.models.filter((v): v is string => typeof v === 'string')
      : [],
    disabled: worker.disabled === true,
  }));
  const credentials: CodexRuntimeCredential[] = value.credentials
    .filter(isRecord)
    .map((credential) => ({
      name: text(credential.name),
      worker_id: text(credential.worker_id),
      enabled: credential.enabled === true,
      owner: text(credential.owner),
      status: text(credential.status),
      account_id: text(credential.account_id) || undefined,
    }));
  // Explicitly project safe management metadata. OAuth tokens never enter page state.
  return { enabled: value.enabled, workers, credentials };
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
    payload: { enabled?: boolean; workers?: CodexRuntimeWorkerInput[] },
    scope: ApiClientRequestScope,
    signal?: AbortSignal
  ) => normalizeCodexRuntimeState(await apiClient.patch(path, payload, config(scope, signal))),

  setCredential: async (
    payload: { name: string; worker_id: string; enabled: boolean },
    scope: ApiClientRequestScope,
    signal?: AbortSignal
  ) =>
    normalizeCodexRuntimeState(
      await apiClient.post(`${path}/credentials`, payload, config(scope, signal))
    ),

  test: (worker_id: string, scope: ApiClientRequestScope, signal?: AbortSignal) =>
    apiClient.post<{ status: string }>(`${path}/test`, { worker_id }, config(scope, signal)),

  startLogin: async (worker_id: string, scope: ApiClientRequestScope, signal?: AbortSignal) => {
    const value = await apiClient.post<CodexRuntimeLogin>(
      `${path}/login/start`,
      { worker_id },
      config(scope, signal)
    );
    if (!value.login_id || !value.url || !/^https?:\/\//i.test(value.url)) {
      throw new Error('Invalid Codex browser OAuth response');
    }
    return { login_id: value.login_id, url: value.url, state: value.state };
  },

  submitCallback: (
    worker_id: string,
    login_id: string,
    redirect_url: string,
    scope: ApiClientRequestScope,
    signal?: AbortSignal
  ) =>
    apiClient.post<CodexRuntimeLoginStatus>(
      `${path}/login/callback`,
      { worker_id, login_id, redirect_url },
      config(scope, signal)
    ),

  loginStatus: (
    worker_id: string,
    login_id: string,
    scope: ApiClientRequestScope,
    signal?: AbortSignal
  ) =>
    apiClient.get<CodexRuntimeLoginStatus>(`${path}/login/status`, {
      ...config(scope, signal),
      params: { worker_id, login_id },
    }),
};
