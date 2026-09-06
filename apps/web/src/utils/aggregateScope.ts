let activeBase = '';
let credentialInstance = '';
export const AGGREGATE_COVERAGE_EVENT = 'cpamp-aggregate-coverage';

export function activateAggregateScope(base: string): void {
  activeBase = base.replace(/\/+$/, '');
  credentialInstance = '';
}

export function aggregateServiceBase(base: string): string {
  const normalized = base.replace(/\/+$/, '');
  return activeBase && normalized === activeBase ? `${normalized}/api/aggregate` : base;
}

export function setAggregateCredentialInstance(id: string): void {
  credentialInstance = id;
}
export function getAggregateCredentialInstance(): string {
  return credentialInstance;
}
