import { describe, expect, it } from 'vitest';
import {
  isBasispointsCallbackValid,
  isBasispointsSessionValid,
  OFFICE_CALLBACK,
  OFFICE_CLIENT_ID,
} from './bindingModel';
import type { BasispointsSession } from '@/services/api/basispoints';

export const officeSession = (): BasispointsSession => ({
  status: 'ok',
  flow: 'basispoints',
  callback_mode: 'paste',
  state: 'office-state',
  expires_in: 300,
  url:
    'https://auth.openai.com/api/accounts/authorize?' +
    new URLSearchParams({
      client_id: OFFICE_CLIENT_ID,
      redirect_uri: OFFICE_CALLBACK,
      response_type: 'code',
      state: 'office-state',
      code_challenge_method: 'S256',
      code_challenge: 'a'.repeat(43),
      audience: 'https://api.openai.com/v1',
      scope: 'openid offline_access email profile organization.read',
      platform: 'PC',
    }).toString(),
});

describe('Office PKCE binding contract', () => {
  it('accepts only the Office client and its official redirect, state, scope and challenge', () => {
    const session = officeSession();
    expect(isBasispointsSessionValid(session)).toBe(true);
    for (const [name, value] of [
      ['client_id', 'ordinary-codex-client'],
      ['redirect_uri', 'http://localhost:1455/auth/callback'],
      ['state', 'other'],
      ['code_challenge_method', 'plain'],
      ['code_challenge', 'short'],
      ['audience', 'https://other.example'],
      ['scope', 'openid offline_access'],
    ]) {
      const url = new URL(session.url);
      url.searchParams.set(name, value);
      expect(isBasispointsSessionValid({ ...session, url: url.toString() })).toBe(false);
    }
    expect(
      isBasispointsSessionValid({ ...session, url: session.url + '&state=office-state' })
    ).toBe(false);
    expect(
      isBasispointsSessionValid({
        ...session,
        url: session.url.replace('auth.openai.com', 'other.example'),
      })
    ).toBe(false);
    expect(
      isBasispointsSessionValid({ ...session, flow: 'siwc_bind' } as unknown as BasispointsSession)
    ).toBe(false);
    expect(isBasispointsSessionValid({ ...session, expires_in: -1 })).toBe(false);
    expect(isBasispointsSessionValid({ ...session, expires_in: undefined })).toBe(true);
  });

  it('accepts an intact official callback with one code or error, never the SIWC callback', () => {
    const callback = OFFICE_CALLBACK + '?code=a%2Bb&state=office-state';
    expect(isBasispointsCallbackValid(callback, 'office-state')).toBe(true);
    expect(
      isBasispointsCallbackValid(callback + '&client_id=' + OFFICE_CLIENT_ID, 'office-state')
    ).toBe(true);
    expect(
      isBasispointsCallbackValid(
        OFFICE_CALLBACK + '?error=access_denied&state=office-state',
        'office-state'
      )
    ).toBe(true);
    for (const value of [
      callback + '&state=office-state',
      callback + '&error=denied',
      callback + '#fragment',
      callback.replace('bps.openai.com', 'evil.example'),
      callback.replace('state=office-state', 'state=other'),
      callback + '&client_id=codex',
      callback + '&client_id=' + OFFICE_CLIENT_ID + '&client_id=' + OFFICE_CLIENT_ID,
      'http://127.0.0.1:1455/auth/callback?code=a&state=office-state&client_id=siwc',
      OFFICE_CALLBACK + '?state=office-state',
      OFFICE_CALLBACK + '?code=&state=office-state',
    ]) {
      expect(isBasispointsCallbackValid(value, 'office-state')).toBe(false);
    }
  });
});
