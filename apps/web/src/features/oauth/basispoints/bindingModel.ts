import type { BasispointsSession } from '@/services/api/basispoints';

export const OFFICE_CLIENT_ID = 'app_fnr0pYvVwwFDocDumLG3H2Bp';
export const OFFICE_CALLBACK =
  'https://bps.openai.com/basispoints/extension/360590d7-f8f9-4d88-bf75-0edfe0a4b9f3/auth/callback';

export function isBasispointsSessionValid(session: BasispointsSession): boolean {
  try {
    const url = new URL(session.url);
    const params = url.searchParams;
    const unique = [
      'client_id',
      'redirect_uri',
      'state',
      'response_type',
      'code_challenge_method',
      'code_challenge',
      'audience',
      'scope',
    ];
    return (
      session.status === 'ok' &&
      session.flow === 'basispoints' &&
      session.callback_mode === 'paste' &&
      typeof session.state === 'string' &&
      Boolean(session.state) &&
      !url.hash &&
      url.origin === 'https://auth.openai.com' &&
      url.pathname === '/api/accounts/authorize' &&
      !url.username &&
      !url.password &&
      unique.every((key) => params.getAll(key).length === 1) &&
      params.get('state') === session.state &&
      params.get('client_id') === OFFICE_CLIENT_ID &&
      params.get('redirect_uri') === OFFICE_CALLBACK &&
      params.get('response_type') === 'code' &&
      params.get('code_challenge_method') === 'S256' &&
      /^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '') &&
      params.get('audience') === 'https://api.openai.com/v1' &&
      ['openid', 'offline_access', 'email', 'profile', 'organization.read'].every((scope) =>
        (params.get('scope') ?? '').split(/\s+/).includes(scope)
      ) &&
      (session.expires_in === undefined ||
        (Number.isFinite(session.expires_in) && session.expires_in > 0))
    );
  } catch {
    return false;
  }
}

export function isBasispointsCallbackValid(value: string, state: string): boolean {
  try {
    const raw = value.trim();
    const url = new URL(raw);
    const params = url.searchParams;
    return Boolean(
      state &&
      raw.split('?')[0] === OFFICE_CALLBACK &&
      !url.hash &&
      ['state', 'code', 'error', 'client_id'].every((key) => params.getAll(key).length <= 1) &&
      (!params.has('client_id') || params.get('client_id') === OFFICE_CLIENT_ID) &&
      params.get('state') === state &&
      Boolean(params.get('code')?.trim()) !== Boolean(params.get('error')?.trim())
    );
  } catch {
    return false;
  }
}
