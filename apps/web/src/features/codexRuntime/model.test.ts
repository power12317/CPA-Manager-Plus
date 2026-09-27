import { describe, expect, it } from 'vitest';
import { isCallbackURL, validateWorkers, workerDraft, workerPayload } from './model';

const draft = () =>
  workerDraft({
    id: 'worker-1',
    url: 'ws://codex:38317',
    auth_file: 'codex-1.json',
    models: ['gpt-5'],
    token_configured: true,
    disabled: false,
  });

describe('Codex runtime configuration', () => {
  it('preserves saved secrets by omitting blank tokens, writes replacements and retains disabled workers', () => {
    const worker = draft();
    expect(worker.token).toBe('');
    expect(workerPayload([worker])[0]).not.toHaveProperty('token');
    expect(
      workerPayload([
        { ...worker, token: '  new-secret  ', models: 'gpt-5, gpt-5\ngpt-6', disabled: true },
      ])[0]
    ).toEqual({
      id: 'worker-1',
      url: 'ws://codex:38317',
      auth_file: 'codex-1.json',
      models: ['gpt-5', 'gpt-6'],
      disabled: true,
      token: 'new-secret',
    });
    expect(workerPayload([])).toEqual([]);
  });

  it('validates stable, unique filenames and WebSocket addresses before full worker replacement', () => {
    expect(validateWorkers([draft()])).toBeUndefined();
    expect(validateWorkers([draft(), draft()])).toBe('duplicate_worker');
    expect(validateWorkers([{ ...draft(), authFile: '../auth.json' }])).toBe('invalid_file');
    expect(validateWorkers([{ ...draft(), url: 'https://codex:38317' }])).toBe('invalid_url');
    expect(validateWorkers([{ ...draft(), url: 'ws://secret@codex:38317' }])).toBe('invalid_url');
    expect(validateWorkers([{ ...draft(), id: '' }])).toBe('required_fields');
  });

  it('requires a full callback with state and code or an official OAuth error', () => {
    expect(isCallbackURL('http://localhost:1455/auth/callback?code=abc&state=one')).toBe(true);
    expect(isCallbackURL('http://localhost:1455/auth/callback?error=access_denied&state=one')).toBe(
      true
    );
    expect(isCallbackURL('abc')).toBe(false);
    expect(isCallbackURL('http://localhost:1455/auth/callback?code=abc')).toBe(false);
  });
});
