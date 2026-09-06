import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  instanceBase,
  instanceIdFromBase,
  managerRootBase,
  preferredInstanceScope,
  rememberInstanceScope,
} from './instanceScope';

describe('instance URL scope', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('keeps explicit view preferences per control panel, including the all-instances scope', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    rememberInstanceScope('https://example.com/cpamc1', '');
    expect(preferredInstanceScope('https://example.com/cpamc1/api/instances/default')).toBe('');
    expect(preferredInstanceScope('https://example.com/cpamc2')).toBeNull();
    rememberInstanceScope('https://example.com/cpamc1/api/instances/default', 'default');
    expect(preferredInstanceScope('https://example.com/cpamc1')).toBe('default');
  });
  it('keeps nested deployment prefixes while moving between instances', () => {
    const root = 'https://example.com/services/cpamc1';
    const a = instanceBase(root, 'default');
    const b = instanceBase(a, '0123456789abcdef0123456789abcdef');
    expect(managerRootBase(a)).toBe(root);
    expect(managerRootBase(b)).toBe(root);
    expect(instanceIdFromBase(a)).toBe('default');
    expect(b).toBe(`${root}/api/instances/0123456789abcdef0123456789abcdef`);
    expect(instanceIdFromBase(root)).toBe('');
  });
});
