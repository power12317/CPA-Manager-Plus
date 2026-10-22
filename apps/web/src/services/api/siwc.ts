// Temporary SIWC leaf adapter. Replace with direct upstream's implementation
// when it includes the complete binding flow; see docs/siwc-integration.md.
import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';
import { buildAuthFileIdentityHeaders, type AuthFileFieldsPatch } from './authFiles';
import type { AuthFileItem } from '@/types';
import { instanceBase, instanceIdFromBase } from '@/utils/instanceScope';
import {
  readAuthFileStatusAuthIndex,
  readAuthFileStatusAccountId,
  readAuthFileStatusCodexMember,
  resolveAuthFileStatusMutationTarget,
} from '@/utils/authFileStatusMutation';

export interface SiwcSession {
  status: 'ok';
  url: string;
  state: string;
  flow: 'siwc_bind';
  expires_in: number;
}

export const supportsSiwcBinding = (file: AuthFileItem): boolean =>
  file.siwc_bind_supported === true &&
  String(file.type ?? file.provider ?? '').toLowerCase() === 'codex' &&
  ![file.runtimeOnly, file.runtime_only].some((value) => value === true || value === 'true');

export const siwcCredentialIdentity = (file: AuthFileItem): string =>
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

const config = (scope: ApiClientRequestScope, signal?: AbortSignal) => ({
  ...createScopedApiRequestConfig(scope, 'v8'),
  signal,
});

const mutationConfig = (scope: ApiClientRequestScope, file: AuthFileItem, signal?: AbortSignal) => {
  const scoped = config(scope, signal);
  return {
    ...scoped,
    headers: {
      ...scoped.headers,
      ...buildAuthFileIdentityHeaders('X-CPAMP-Auth-File-Mutation-Identity', [identity(file)]),
    },
  };
};

export const siwcApi = {
  list: async (scope: ApiClientRequestScope, signal?: AbortSignal): Promise<AuthFileItem[]> => {
    const response = await apiClient.get<{ files: AuthFileItem[] }>(
      '/credentials',
      config(scope, signal)
    );
    if (!Array.isArray(response?.files)) throw new Error('Invalid credential list');
    return response.files;
  },
  start: (scope: ApiClientRequestScope, file: AuthFileItem) =>
    apiClient.post<SiwcSession>(
      '/oauth/siwc/bind',
      { name: file.name },
      mutationConfig(scope, file)
    ),
  callback: (scope: ApiClientRequestScope, redirectUrl: string, signal?: AbortSignal) =>
    apiClient.post(
      '/oauth/callback',
      { provider: 'codex', redirect_url: redirectUrl },
      config(scope, signal)
    ),
  status: (scope: ApiClientRequestScope, state: string, signal?: AbortSignal) =>
    apiClient.get<{ status: 'ok' | 'wait' | 'error'; error?: string }>('/oauth/status', {
      ...config(scope, signal),
      params: { state },
    }),
  cancel: (scope: ApiClientRequestScope, state: string) =>
    apiClient.delete('/oauth/session', { ...config(scope), params: { state } }),
  patch: (scope: ApiClientRequestScope, file: AuthFileItem, fields: AuthFileFieldsPatch) =>
    apiClient.patch(
      '/credentials/fields',
      { ...fields, name: file.name },
      mutationConfig(scope, file)
    ),
};

// Aggregate records carry a server-issued instance identity. Resolve to that
// single CPA before using v8; neither binding nor credential discovery broadcasts.
export async function resolveSiwcCredential(
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
  const candidates = await siwcApi.list(selectedScope, signal);
  const resolved = resolveAuthFileStatusMutationTarget(candidates, identity(selectedFile));
  if (
    resolved.failure ||
    !resolved.target ||
    resolved.scope !== 'credential' ||
    !supportsSiwcBinding(resolved.target)
  ) {
    throw new Error('SIWC credential is unavailable or changed');
  }
  return { scope: selectedScope, file: resolved.target };
}
