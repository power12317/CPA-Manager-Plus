import { isUsageServiceId, type UsageServiceInfo } from '@/services/api/usageService';
import type { AuthSessionMode } from '@/types/auth';
import { managerRootBase } from '@/utils/instanceScope';

// A missing Manager endpoint identifies a CPA-hosted panel. A transient
// failure must not turn an established Manager session into a CPA session
// and erase its credentials during restoration.
export function resolveLoginProbeFailureMode(
  error: unknown,
  panelBase: string,
  session: { sessionMode: AuthSessionMode | ''; apiBase: string }
): AuthSessionMode {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  return status !== 404 &&
    session.sessionMode === 'manager_embedded' &&
    managerRootBase(session.apiBase) === managerRootBase(panelBase)
    ? 'manager_embedded'
    : 'external_panel';
}

export const resolveUsageServiceLoginMode = (info?: UsageServiceInfo | null) => {
  const hostedByUsageService = isUsageServiceId(info?.service);
  const projectInitialized = info?.projectInitialized ?? info?.configured;
  return {
    hostedByUsageService,
    usageServiceNeedsSetup:
      hostedByUsageService && (info?.setupRequired === true || projectInitialized !== true),
  };
};
