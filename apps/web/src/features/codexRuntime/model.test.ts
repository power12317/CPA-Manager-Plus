import { describe, expect, it } from 'vitest';
import { isCallbackURL } from './model';

describe('Codex official OAuth callback', () => {
  it('requires a full callback with state and code or an official OAuth error', () => {
    expect(isCallbackURL('http://localhost:1455/auth/callback?code=abc&state=one')).toBe(true);
    expect(isCallbackURL('http://localhost:1455/auth/callback?error=access_denied&state=one')).toBe(
      true
    );
    expect(isCallbackURL('abc')).toBe(false);
    expect(isCallbackURL('http://localhost:1455/auth/callback?code=abc')).toBe(false);
  });
});
