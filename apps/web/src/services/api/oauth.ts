/**
 * OAuth 与设备码登录相关 API
 */

import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';
import { instanceBase } from '@/utils/instanceScope';

export type BuiltInOAuthProvider = 'codex' | 'anthropic' | 'antigravity' | 'kimi' | 'xai';
export type OAuthProvider = BuiltInOAuthProvider | (string & {});

export interface OAuthStartResponse {
  url: string;
  state?: string;
}

export interface OAuthCallbackResponse {
  status: 'ok';
}

const WEBUI_SUPPORTED: string[] = ['codex', 'anthropic', 'antigravity', 'xai'];
const flowScopes = new Map<string, ApiClientRequestScope>();

export const oauthApi = {
  startAuth: async (provider: OAuthProvider, requestScope?: ApiClientRequestScope) => {
    const params: Record<string, string | boolean> = {};
    if (WEBUI_SUPPORTED.includes(provider)) {
      params.is_webui = true;
    }
    const result = await apiClient.get<OAuthStartResponse>(`/${provider}-auth-url`, {
      ...(requestScope ? createScopedApiRequestConfig(requestScope) : {}),
      params: Object.keys(params).length ? params : undefined,
    });
    const qualified = result.state?.match(/^@cpamp\/(default|[a-f0-9]{32})\/(.+)$/);
    if (qualified) {
      const scope = requestScope ?? apiClient.getRequestScope();
      flowScopes.set(qualified[2], {
        ...scope,
        apiBase: instanceBase(scope.apiBase, qualified[1]),
      });
      if (flowScopes.size > 100) flowScopes.delete(flowScopes.keys().next().value!);
      return { ...result, state: qualified[2] };
    }
    return result;
  },

  getAuthStatus: (state: string, requestScope?: ApiClientRequestScope) => {
    requestScope = flowScopes.get(state) ?? requestScope;
    return apiClient.get<{ status: 'ok' | 'wait' | 'error'; error?: string }>(`/get-auth-status`, {
      ...(requestScope ? createScopedApiRequestConfig(requestScope) : {}),
      params: { state },
    });
  },

  submitCallback: (
    provider: OAuthProvider,
    redirectUrl: string,
    requestScope?: ApiClientRequestScope
  ) => {
    try {
      requestScope =
        flowScopes.get(new URL(redirectUrl).searchParams.get('state') || '') ?? requestScope;
    } catch {
      /* Existing API validates malformed callbacks. */
    }
    return apiClient.post<OAuthCallbackResponse>(
      '/oauth-callback',
      {
        provider,
        redirect_url: redirectUrl,
      },
      requestScope ? createScopedApiRequestConfig(requestScope) : undefined
    );
  },
};
