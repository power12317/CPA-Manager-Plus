import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { auth } = vi.hoisted(() => ({
  auth: {
    apiBase: 'https://example.com/cpamp',
    sessionMode: 'manager_embedded',
    switchInstanceScope: vi.fn(),
  },
}));
vi.mock('@/stores/useAuthStore', () => ({ useAuthStore: { getState: () => auth } }));
import { navigateInstance, synchronizeInstanceHistory } from './navigation';
import { preferredInstanceScope, rememberInstanceScope } from '@/utils/instanceScope';

let currentURL: URL;
let historyState: Record<string, unknown>;
const dispatchEvent = vi.fn();
const assign = vi.fn();
const updateHistory = vi.fn((state: Record<string, unknown>, _title: string, url: string) => {
  historyState = state;
  currentURL = new URL(url);
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.apiBase = 'https://example.com/cpamp';
  auth.switchInstanceScope.mockImplementation((base: string) => {
    auth.apiBase = base;
  });
  currentURL = new URL(`${auth.apiBase}/management.html#/`);
  historyState = { idx: 0 };
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('window', {
    get location() {
      return {
        href: currentURL.href,
        origin: currentURL.origin,
        pathname: currentURL.pathname,
        hash: currentURL.hash,
        protocol: currentURL.protocol,
        host: currentURL.host,
        hostname: currentURL.hostname,
        port: currentURL.port,
        assign,
      };
    },
    history: {
      get state() {
        return historyState;
      },
      replaceState: updateHistory,
      pushState: updateHistory,
    },
    dispatchEvent,
  });
  vi.stubGlobal(
    'PopStateEvent',
    class extends Event {
      state: unknown;
      constructor(type: string, options: { state: unknown }) {
        super(type);
        this.state = options.state;
      }
    }
  );
});
afterEach(() => vi.unstubAllGlobals());

it('switches scope and preserves nested paths and filters without document navigation', () => {
  navigateInstance('default', '/monitoring?model=gpt');
  expect(currentURL.href).toBe(
    'https://example.com/cpamp/management.html#/monitoring?model=gpt&scope=default'
  );
  expect(assign).not.toHaveBeenCalled();
  expect(auth.switchInstanceScope).toHaveBeenCalledWith(
    'https://example.com/cpamp/api/instances/default'
  );
  expect(dispatchEvent.mock.calls[0][0].type).toBe('popstate');
  expect(preferredInstanceScope(auth.apiBase)).toBe('default');
});

it('retains all-mode preference through automatic single-page navigation and back/forward', () => {
  rememberInstanceScope(auth.apiBase, '');
  navigateInstance('default', '/logs', true);
  expect(historyState.idx).toBe(0);
  expect(preferredInstanceScope(auth.apiBase)).toBe('');
  const automaticState = historyState;
  const automaticURL = currentURL;
  navigateInstance('', '/dashboard', true);
  expect(auth.apiBase).toBe('https://example.com/cpamp');
  historyState = automaticState;
  currentURL = automaticURL;
  synchronizeInstanceHistory();
  expect(auth.apiBase).toBe('https://example.com/cpamp/api/instances/default');
  expect(preferredInstanceScope(auth.apiBase)).toBe('');
  expect(assign).not.toHaveBeenCalled();
});
