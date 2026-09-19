import { useAuthStore } from '@/stores/useAuthStore';
import { detectApiBaseFromLocation } from '@/utils/connection';
import {
  instanceBase,
  instanceIdFromBase,
  managerRootBase,
  preferredInstanceScope,
  rememberInstanceScope,
} from '@/utils/instanceScope';

export function navigateInstance(id: string, route: string, automatic = false): void {
  const { apiBase, switchInstanceScope } = useAuthStore.getState();
  const previousPreference = preferredInstanceScope(apiBase) ?? instanceIdFromBase(apiBase);
  // Keep enough state on both entries for back/forward to restore the selected
  // range, including an automatic single-instance page entered from all mode.
  window.history.replaceState(
    { ...window.history.state, cpampScopePreference: previousPreference },
    '',
    window.location.href
  );
  if (!automatic) rememberInstanceScope(apiBase, id);
  else if (preferredInstanceScope(apiBase) === null)
    rememberInstanceScope(apiBase, instanceIdFromBase(apiBase));
  const base = id ? instanceBase(apiBase, id) : managerRootBase(apiBase);
  const root = `${managerRootBase(apiBase)}/management.html`;
  const [pathname, query = ''] = (route.startsWith('/') ? route : '/').split('?');
  const params = new URLSearchParams(query);
  if (id) params.set('scope', id);
  else params.delete('scope');
  const url = `${root}#${pathname}${params.toString() ? `?${params.toString()}` : ''}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const target = new URL(url, window.location.href);
  const targetUrl = `${target.pathname}${target.search}${target.hash}`;
  if (currentUrl === targetUrl) {
    // Automatic redirects can run again while the shell settles after a
    // scope change. Do not create another history entry or dispatch another
    // popstate when the requested location is already active.
    switchInstanceScope(base);
    return;
  }
  const state = {
    ...window.history.state,
    cpampScopePreference: preferredInstanceScope(apiBase),
    key: crypto.randomUUID(),
    idx: (window.history.state?.idx ?? 0) + (automatic ? 0 : 1),
  };
  if (automatic) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
  switchInstanceScope(base);
  // HashRouter observes popstate; pushState itself intentionally emits no event.
  window.dispatchEvent(new PopStateEvent('popstate', { state }));
}

export function synchronizeInstanceHistory(): void {
  const { apiBase, sessionMode, switchInstanceScope } = useAuthStore.getState();
  if (sessionMode !== 'manager_embedded') return;
  const target = detectApiBaseFromLocation();
  if (managerRootBase(target) !== managerRootBase(apiBase)) return;
  const hash = window.location.hash || '';
  const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const scopeFromUrl = new URLSearchParams(hashQuery).get('scope') || '';
  const scopedTarget = scopeFromUrl
    ? instanceBase(managerRootBase(apiBase), scopeFromUrl)
    : managerRootBase(apiBase);
  const preference = window.history.state?.cpampScopePreference;
  rememberInstanceScope(scopedTarget, typeof preference === 'string' ? preference : scopeFromUrl);
  switchInstanceScope(scopedTarget);
}
