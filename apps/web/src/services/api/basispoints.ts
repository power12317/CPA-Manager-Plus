import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';
import { buildAuthFileIdentityHeaders } from './authFiles';
import type { AuthFileItem } from '@/types';
import { instanceBase, instanceIdFromBase } from '@/utils/instanceScope';
import {
  readAuthFileStatusAuthIndex,
  readAuthFileStatusAccountId,
  readAuthFileStatusCodexMember,
  resolveAuthFileStatusMutationTarget,
} from '@/utils/authFileStatusMutation';

export interface BasispointsSession {
  status: 'ok';
  url: string;
  state: string;
  flow: 'basispoints';
  callback_mode: 'paste';
  expires_in?: number;
}

export interface BasispointsBindingStatus {
  status: 'off' | 'valid' | 'invalid';
  bound: boolean;
  bind_supported: boolean;
  use_basispoints: boolean;
  expires_at?: string | number;
}

export const supportsBasispointsBinding = (file: AuthFileItem): boolean =>
  file.basispoints_bind_supported === true &&
  String(file.type ?? file.provider ?? '').toLowerCase() === 'codex' &&
  ![file.runtimeOnly, file.runtime_only].some((value) => value === true || value === 'true');

export const basispointsCredentialIdentity = (file: AuthFileItem): string =>
  JSON.stringify([
    file.name,
    file.id ?? '',
    readAuthFileStatusAuthIndex(file),
    readAuthFileStatusAccountId(file),
    readAuthFileStatusCodexMember(file),
  ]);

const identity = (file: AuthFileItem) => ({
  name: file.name,
  runtimeId: file.id,
  authIndex: readAuthFileStatusAuthIndex(file),
  provider: 'codex',
  accountId: readAuthFileStatusAccountId(file),
  accountSnapshot: readAuthFileStatusCodexMember(file),
});

const config = (scope: ApiClientRequestScope, signal?: AbortSignal) => {
  if (/\/api\/aggregate(?:\/|$)/.test(scope.apiBase)) throw new Error('Select one CPA');
  return { ...createScopedApiRequestConfig(scope, 'v8'), signal };
};

const mutationConfig = (scope: ApiClientRequestScope, file: AuthFileItem) => {
  const scoped = config(scope);
  return {
    ...scoped,
    headers: {
      ...scoped.headers,
      ...buildAuthFileIdentityHeaders('X-CPAMP-Auth-File-Mutation-Identity', [identity(file)]),
    },
  };
};

export const basispointsApi = {
  list: async (scope: ApiClientRequestScope, signal?: AbortSignal): Promise<AuthFileItem[]> => {
    const result = await apiClient.get<{ files: AuthFileItem[] }>(
      '/credentials',
      config(scope, signal)
    );
    if (!Array.isArray(result?.files)) throw new Error('Invalid credential list');
    return result.files;
  },
  start: (scope: ApiClientRequestScope, file: AuthFileItem) =>
    apiClient.post<BasispointsSession>(
      '/oauth/basispoints/bind',
      { name: file.name },
      mutationConfig(scope, file)
    ),
  bindingStatus: (scope: ApiClientRequestScope, file: AuthFileItem, signal?: AbortSignal) =>
    apiClient.get<BasispointsBindingStatus>('/oauth/basispoints/status', {
      ...config(scope, signal),
      params: { name: file.name, auth_index: readAuthFileStatusAuthIndex(file) },
    }),
  callback: (
    scope: ApiClientRequestScope,
    state: string,
    redirectUrl: string,
    signal?: AbortSignal
  ) =>
    apiClient.post(
      '/oauth/callback',
      { provider: 'basispoints', state, redirect_url: redirectUrl },
      config(scope, signal)
    ),
  status: (scope: ApiClientRequestScope, state: string, signal?: AbortSignal) =>
    apiClient.get<{ status: 'ok' | 'wait' | 'error' }>('/oauth/status', {
      ...config(scope, signal),
      params: { state },
    }),
  cancel: (scope: ApiClientRequestScope, state: string) =>
    apiClient.delete('/oauth/session', { ...config(scope), params: { state } }),
  patch: (scope: ApiClientRequestScope, file: AuthFileItem, useBasispoints: boolean) =>
    apiClient.patch(
      '/credentials/fields',
      { name: file.name, use_basispoints: useBasispoints },
      mutationConfig(scope, file)
    ),
};

export async function resolveBasispointsCredential(
  scope: ApiClientRequestScope,
  file: AuthFileItem,
  signal?: AbortSignal
): Promise<{ scope: ApiClientRequestScope; file: AuthFileItem }> {
  const instanceId = typeof file.instanceId === 'string' ? file.instanceId : '';
  let selectedScope = scope;
  let selectedFile = file;
  if (instanceId) {
    if (!/^(?:default|[a-f0-9]{32})$/.test(instanceId))
      throw new Error('Invalid credential instance');
    const currentInstance = instanceIdFromBase(scope.apiBase);
    if (currentInstance && currentInstance !== instanceId)
      throw new Error('Credential instance changed');
    selectedScope = {
      ...scope,
      apiBase: instanceBase(scope.apiBase.replace(/\/api\/aggregate\/?$/, ''), instanceId),
    };
    const unqualify = (value: unknown) =>
      typeof value === 'string' ? value.replace(new RegExp(`^@cpamp/${instanceId}/`), '') : value;
    const prefix = `[${String(file.instanceName ?? '')}] `;
    selectedFile = {
      ...file,
      name: file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name,
      id: unqualify(file.id) as string | undefined,
      auth_index: unqualify(readAuthFileStatusAuthIndex(file)),
      authIndex: unqualify(readAuthFileStatusAuthIndex(file)) as string | number | null,
    };
  }
  const candidates = await basispointsApi.list(selectedScope, signal);
  const resolved = resolveAuthFileStatusMutationTarget(candidates, identity(selectedFile));
  if (
    resolved.failure ||
    !resolved.target ||
    resolved.scope !== 'credential' ||
    !supportsBasispointsBinding(resolved.target)
  ) {
    throw new Error('Basispoints credential unavailable or changed');
  }
  return { scope: selectedScope, file: resolved.target };
}
