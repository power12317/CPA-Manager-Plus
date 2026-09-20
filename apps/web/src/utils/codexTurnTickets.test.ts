import { describe, expect, it } from 'vitest';
import {
  normalizeAuthFileTickets,
  resolveCodexTurnTicketTargetLength,
  ticketRemainingSeconds,
} from './codexTurnTickets';

describe('门票公开状态与倒计时', () => {
  it.each([
    ['free', 292],
    ['plus', 292],
    ['pro', 292],
    ['pro_20x', 292],
    ['team', 332],
    ['business', 332],
    ['business_premium_5x', 332],
  ] as const)('按账号计划 %s 解析门票目标长度', (plan, expected) => {
    expect(resolveCodexTurnTicketTargetLength(plan)).toBe(expected);
  });

  it('不为未知计划臆测门票目标长度', () => {
    expect(resolveCodexTurnTicketTargetLength('enterprise')).toBeNull();
    expect(resolveCodexTurnTicketTargetLength(undefined, 'unknown')).toBeNull();
  });

  it('拒绝畸形数据、去重模型并丢弃门票原文', () => {
    const tickets = normalizeAuthFileTickets(
      [
        null,
        { model: '' },
        {
          model: 'astra',
          ready: true,
          remaining_seconds: 12,
          token: 'never-render-this',
          value: 'secret',
        },
        { model: 'astra' },
      ],
      1000
    );
    expect(tickets).toHaveLength(1);
    expect(JSON.stringify(tickets)).not.toMatch(/secret|never-render/);
    expect(ticketRemainingSeconds(tickets[0], 13000)).toBe(0);
    expect(normalizeAuthFileTickets({})).toEqual([]);
  });
  it('根据真实时间递减，标签页挂起后也在绝对过期时间停止 ready', () => {
    const [ticket] = normalizeAuthFileTickets(
      [
        {
          model: 'sol',
          remaining_seconds: 60,
          expires_at: new Date(31_000).toISOString(),
          ready: true,
        },
      ],
      1000
    );
    expect(ticketRemainingSeconds(ticket, 1000)).toBe(30);
    expect(ticketRemainingSeconds(ticket, 30_500)).toBe(1);
    expect(ticketRemainingSeconds(ticket, 31_000)).toBe(0);
    expect(ticketRemainingSeconds(ticket, 121_000)).toBe(0);
  });
});
