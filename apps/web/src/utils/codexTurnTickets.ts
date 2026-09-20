import type { AuthFileCodexTurnTicket } from '@/types/authFile';
import { isRecord } from './helpers';

export type CodexTurnTicketTargetLength = 292 | 332;

const normalizePlanValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase().replace(/[-\s]/g, '_') : '';

/** Resolves the ticket target from the account's Codex plan attribute. */
export function resolveCodexTurnTicketTargetLength(
  planType?: unknown,
  canonicalPlanType?: unknown
): CodexTurnTicketTargetLength | null {
  const values = [planType, canonicalPlanType].map(normalizePlanValue).filter(Boolean);
  if (
    values.some(
      (value) => value === 'team' || value === 'business' || value.startsWith('business_')
    )
  ) {
    return 332;
  }
  if (
    values.some(
      (value) =>
        value === 'free' ||
        value === 'plus' ||
        value === 'pro' ||
        value.startsWith('pro_') ||
        value.startsWith('prolite')
    )
  ) {
    return 292;
  }
  return null;
}

// 仅保留公开状态字段，丢弃意外返回的门票原文。
export function normalizeAuthFileTickets(
  value: unknown,
  observedAtMs = Date.now()
): AuthFileCodexTurnTicket[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.model !== 'string' || !item.model.trim()) return [];
    const model = item.model.trim();
    if (seen.has(model)) return [];
    seen.add(model);
    const remaining = Number(item.remaining_seconds);
    return [
      {
        model,
        ready: item.ready === true,
        blocked: item.blocked === true,
        remaining_seconds: Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
        expires_at: typeof item.expires_at === 'string' ? item.expires_at : undefined,
        length: typeof item.length === 'number' ? item.length : undefined,
        observedAtMs,
      },
    ];
  });
}

export function ticketRemainingSeconds(ticket: AuthFileCodexTurnTicket, nowMs: number): number {
  const remaining = Number(ticket.remaining_seconds);
  const elapsed =
    ticket.observedAtMs === undefined ? 0 : Math.max(0, (nowMs - ticket.observedAtMs) / 1000);
  const fromSnapshot = Number.isFinite(remaining) ? Math.max(0, remaining - elapsed) : 0;
  const expiry = Date.parse(ticket.expires_at ?? '');
  return Math.max(
    0,
    Math.ceil(
      Number.isFinite(expiry) ? Math.min(fromSnapshot, (expiry - nowMs) / 1000) : fromSnapshot
    )
  );
}
