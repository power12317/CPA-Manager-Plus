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
  const url = `${base}/management.html#${route.startsWith('/') ? route : '/'}`;
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
  const preference = window.history.state?.cpampScopePreference;
  rememberInstanceScope(
    target,
    typeof preference === 'string' ? preference : instanceIdFromBase(target)
  );
  switchInstanceScope(target);
}
