import axios from 'axios';
import type { ApiClientRequestScope } from './client';
import { instanceBase } from '@/utils/instanceScope';

export interface OailbBorrowSelection {
  sourceInstanceId: string;
  sourceAuthId: string;
}

export interface OailbBorrowStatus {
  supported: boolean;
  configured: boolean;
  sourceInstanceId?: string;
  sourceAuthId?: string;
  sourceAuthFile?: string;
}

export interface OailbBorrowCredential {
  id: string;
  name: string;
}

export function oailbBorrowApi(scope: ApiClientRequestScope, targetId: string) {
  // Capture the destination and administrator credential together. Changing
  // the global API client must never redirect an in-flight settings write.
  const client = axios.create({
    baseURL: `${instanceBase(scope.apiBase, targetId)}/oailb-borrow`,
    headers: { Authorization: `Bearer ${scope.managementKey}` },
    timeout: 60_000,
  });
  return {
    get: async (signal: AbortSignal) => (await client.get<OailbBorrowStatus>('', { signal })).data,
    credentials: async (sourceId: string, signal: AbortSignal) =>
      (
        await client.get<{ credentials: OailbBorrowCredential[] }>('/credentials', {
          params: { source: sourceId },
          signal,
        })
      ).data.credentials,
    save: async (selection: OailbBorrowSelection, signal: AbortSignal) =>
      (await client.put<OailbBorrowStatus>('', selection, { signal })).data,
  };
}

const errorCodes = new Set([
  'oailb_borrow_unsupported',
  'oailb_borrow_source_unsupported',
  'oailb_borrow_selection',
  'oailb_borrow_credential',
  'oailb_borrow_unavailable',
  'oailb_borrow_source_unavailable',
  'oailb_borrow_target_unavailable',
]);

export function oailbBorrowErrorCode(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const code = error.response?.data?.code;
    if (typeof code === 'string' && errorCodes.has(code)) return code;
  }
  return 'oailb_borrow_unavailable';
}
