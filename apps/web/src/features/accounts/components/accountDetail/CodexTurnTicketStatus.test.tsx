import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexTurnTicketStatus } from './CodexTurnTicketStatus';
import { normalizeAuthFileTickets } from '@/utils/codexTurnTickets';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { time?: string; expected?: number | string; actual?: string }) => {
      if (options?.time) return key + ':' + options.time;
      if (options?.expected !== undefined && options.actual !== undefined) {
        return key + ':' + options.expected + ':' + options.actual;
      }
      return key;
    },
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
        length: 292,
        expires_at: new Date(3000).toISOString(),
      },
      { model: 'blocked-model', blocked: true },
      { model: 'missing-model', ready: false },
    ]);
    act(() => {
      view = create(
        createElement(CodexTurnTicketStatus, {
          tickets,
          planType: 'pro',
          compact: true,
        })
      );
    });
    expect(JSON.stringify(view!.toJSON())).toContain('accounts.codex_ticket_remaining:0m02s');
    expect(JSON.stringify(view!.toJSON())).toContain('accounts.codex_ticket_length:292:292');
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

  it('在 Team/Business 账号中显示 332 目标，并保留实际长度', () => {
    const tickets = normalizeAuthFileTickets([
      { model: 'team-model', ready: true, remaining_seconds: 60, length: 332 },
      { model: 'business-model', ready: false, remaining_seconds: 0, length: 292 },
    ]);
    act(() => {
      view = create(
        createElement(CodexTurnTicketStatus, {
          tickets,
          planType: 'team',
        })
      );
    });
    const text = JSON.stringify(view!.toJSON());
    expect(text).toContain('accounts.codex_ticket_length:332:332');
    expect(text).toContain('accounts.codex_ticket_length:332:292');
  });

  it('未知账号计划显示未知目标而不改变实际长度', () => {
    const tickets = normalizeAuthFileTickets([
      { model: 'unknown-model', ready: true, remaining_seconds: 60, length: 292 },
    ]);
    act(() => {
      view = create(
        createElement(CodexTurnTicketStatus, {
          tickets,
          planType: 'enterprise',
        })
      );
    });
    expect(JSON.stringify(view!.toJSON())).toContain('accounts.codex_ticket_length:—:292');
  });
});
