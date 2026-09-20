import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexTurnTicketStatus } from './CodexTurnTicketStatus';
import { normalizeAuthFileTickets } from '@/utils/codexTurnTickets';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { time: string }) =>
      options?.time ? key + ':' + options.time : key,
  }),
}));
let view: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => view?.unmount());
  vi.useRealTimers();
});
describe('凭证门票显示', () => {
  it('同时展示模型 ready/blocked/missing，到期后不继续显示 ready', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const tickets = normalizeAuthFileTickets([
      {
        model: 'ready-model',
        ready: true,
        remaining_seconds: 2,
        expires_at: new Date(3000).toISOString(),
      },
      { model: 'blocked-model', blocked: true },
      { model: 'missing-model', ready: false },
    ]);
    act(() => {
      view = create(createElement(CodexTurnTicketStatus, { tickets, compact: true }));
    });
    expect(JSON.stringify(view!.toJSON())).toContain('accounts.codex_ticket_remaining:0m02s');
    expect(JSON.stringify(view!.toJSON())).toContain('accounts.codex_ticket_blocked');
    expect(JSON.stringify(view!.toJSON())).toContain('accounts.codex_ticket_missing');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(JSON.stringify(view!.toJSON())).not.toContain('accounts.codex_ticket_remaining');
    act(() => view!.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
  it('旧服务没有门票字段时不增加空区块', () => {
    act(() => {
      view = create(createElement(CodexTurnTicketStatus));
    });
    expect(view!.toJSON()).toBeNull();
  });
});
