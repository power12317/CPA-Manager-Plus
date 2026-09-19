import type { AuthFileItem } from '@/types';
import { normalizeAccountProvider } from './accountRows';
import { buildAccountOAuthReauthPath } from './accountReauthSession';

export type AccountReauthAction =
  | { kind: 'codex-dialog' }
  | { kind: 'navigate'; oauthProvider: string; path: string; instanceId?: string }
  | { kind: 'unsupported'; provider: string };

const OAUTH_PROVIDER_BY_ACCOUNT_PROVIDER: Record<string, string> = {
  anthropic: 'anthropic',
  antigravity: 'antigravity',
  claude: 'anthropic',
  kimi: 'kimi',
  xai: 'xai',
  devin: 'devin',
};

export const resolveAccountReauthAction = (file: AuthFileItem): AccountReauthAction => {
  const provider = normalizeAccountProvider(file);
  if (provider === 'codex') return { kind: 'codex-dialog' };

  const oauthProvider = OAUTH_PROVIDER_BY_ACCOUNT_PROVIDER[provider];
  if (oauthProvider) {
    const instanceId = String(file.instanceId ?? '').trim() || undefined;
    return {
      kind: 'navigate',
      oauthProvider,
      ...(instanceId ? { instanceId } : {}),
      path: buildAccountOAuthReauthPath(oauthProvider, null, instanceId),
    };
  }

  return { kind: 'unsupported', provider };
};
