// Instance scope is reflected in the URL with the History API. Switching keeps
// the document and shell mounted; each tab owns its request and cache scope.
export const managerRootBase = (base: string): string =>
  base.replace(/\/api\/instances\/(?:default|[a-f0-9]{32})\/?$/, '').replace(/\/+$/, '');

export const instanceIdFromBase = (base: string): string =>
  base.match(/\/api\/instances\/(default|[a-f0-9]{32})\/?$/)?.[1] || '';

export const instanceBase = (base: string, id: string): string =>
  `${managerRootBase(base)}/api/instances/${encodeURIComponent(id)}`;

const transferKey = 'cpamp-instance-navigation';
const scopeKey = (base: string) => `cpamp-view-scope:${managerRootBase(base)}`;

export function preferredInstanceScope(base: string): string | null {
  try {
    return sessionStorage.getItem(scopeKey(base));
  } catch {
    return null;
  }
}

export function rememberInstanceScope(base: string, id: string): void {
  try {
    sessionStorage.setItem(scopeKey(base), id);
  } catch {
    /* Optional tab preference. */
  }
}

export function saveInstanceNavigation(base: string, managementKey: string): void {
  try {
    sessionStorage.setItem(
      transferKey,
      JSON.stringify({ base, managementKey, expires: Date.now() + 60_000 })
    );
  } catch {
    /* Navigation still works; restricted storage requires a fresh login. */
  }
}

export function takeInstanceNavigation(base: string): string {
  try {
    const raw = sessionStorage.getItem(transferKey);
    if (!raw) return '';
    sessionStorage.removeItem(transferKey);
    const saved = JSON.parse(raw);
    return saved.base === base &&
      saved.expires > Date.now() &&
      typeof saved.managementKey === 'string'
      ? saved.managementKey
      : '';
  } catch {
    return '';
  }
}

export function clearInstanceNavigation(): void {
  try {
    sessionStorage.removeItem(transferKey);
  } catch {
    /* Storage may be unavailable. */
  }
}
