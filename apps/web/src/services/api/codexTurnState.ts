import { apiClient } from './client';
import type {
  CodexTurnStateAccount,
  CodexTurnStateStatus,
  CodexTurnStateTicket,
} from '@/types/codexTurnState';
import { isRecord } from '@/utils/helpers';

const asString = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const asNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const asBoolean = (value: unknown) => value === true;
const asStringArray = (value: unknown) =>
  Array.isArray(value) ? value.map((item) => asString(item).trim()).filter(Boolean) : [];

const normalizeTicket = (value: unknown): CodexTurnStateTicket | null => {
  if (!isRecord(value)) return null;
  const model = asString(value.model).trim();
  if (!model) return null;
  return {
    model,
    length: asNumber(value.length),
    ready: asBoolean(value.ready),
    remainingSeconds: asNumber(value.remaining_seconds ?? value.remainingSeconds),
    blocked: asBoolean(value.blocked),
    expiresAt: asString(value.expires_at ?? value.expiresAt).trim() || undefined,
  };
};

const normalizeAccount = (value: unknown): CodexTurnStateAccount | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;
  const tickets = Array.isArray(value.tickets)
    ? value.tickets
        .map(normalizeTicket)
        .filter((ticket): ticket is CodexTurnStateTicket => Boolean(ticket))
    : [];
  return { id, name: asString(value.name).trim() || undefined, tickets };
};

export const normalizeCodexTurnStateStatus = (value: unknown): CodexTurnStateStatus => {
  const source = isRecord(value) ? value : {};
  const accounts = Array.isArray(source.accounts)
    ? source.accounts
        .map(normalizeAccount)
        .filter((account): account is CodexTurnStateAccount => Boolean(account))
    : [];
  return {
    enabled: asBoolean(source.enabled),
    targetLength: asNumber(source.target_length ?? source.targetLength, 292),
    ttlSeconds: asNumber(source.ttl_seconds ?? source.ttlSeconds, 3600),
    refreshBeforeSeconds: asNumber(
      source.refresh_before_seconds ?? source.refreshBeforeSeconds,
      600
    ),
    probeIntervalSeconds: asNumber(source.probe_interval_seconds ?? source.probeIntervalSeconds, 6),
    attemptTimeoutSeconds: asNumber(
      source.attempt_timeout_seconds ?? source.attemptTimeoutSeconds,
      25
    ),
    failClosed: asBoolean(source.fail_closed ?? source.failClosed),
    models: asStringArray(source.models),
    harvestProxyUrl: asString(source.harvest_proxy_url ?? source.harvestProxyUrl).trim(),
    harvestProxyConfigured: asBoolean(
      source.harvest_proxy_configured ?? source.harvestProxyConfigured
    ),
    accounts,
  };
};

export const codexTurnStateApi = {
  async status(): Promise<CodexTurnStateStatus> {
    return normalizeCodexTurnStateStatus(await apiClient.get('/codex-turn-state-ticket'));
  },
  async update(value: {
    enabled: boolean;
    fail_closed: boolean;
    harvest_proxy_url: string;
    models: string[];
    target_length: number;
    ttl_seconds: number;
    refresh_before_seconds: number;
    probe_interval_seconds: number;
    attempt_timeout_seconds: number;
  }): Promise<CodexTurnStateStatus> {
    return normalizeCodexTurnStateStatus(await apiClient.put('/codex-turn-state-ticket', value));
  },
};
