import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileCodexTurnTicket } from '@/types/authFile';
import { ticketRemainingSeconds } from '@/utils/codexTurnTickets';
import styles from '@/features/accounts/AccountsPage.module.scss';

const formatRemaining = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
};

interface CodexTurnTicketStatusProps {
  tickets?: AuthFileCodexTurnTicket[];
  compact?: boolean;
}

export function CodexTurnTicketStatus({ tickets, compact = false }: CodexTurnTicketStatusProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const hasReady = tickets?.some((ticket) => ticket.ready) === true;
  useEffect(() => {
    if (!hasReady) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasReady]);
  if (!tickets || tickets.length === 0) return null;

  return (
    <div
      className={`${styles.codexTicketList} ${compact ? styles.codexTicketListCompact : ''}`}
      data-codex-turn-tickets="true"
      aria-label={t('accounts.codex_ticket_title')}
    >
      {!compact ? (
        <strong className={styles.codexTicketTitle}>{t('accounts.codex_ticket_title')}</strong>
      ) : null}
      {tickets.map((ticket) => {
        const remaining = ticketRemainingSeconds(ticket, Math.max(now, ticket.observedAtMs ?? now));
        const ready = ticket.ready && remaining > 0;
        const statusLabel = ready
          ? t('accounts.codex_ticket_remaining', { time: formatRemaining(remaining) })
          : ticket.blocked
            ? t('accounts.codex_ticket_blocked')
            : t('accounts.codex_ticket_missing');
        return (
          <span
            key={ticket.model}
            className={`${styles.codexTicketItem} ${
              ready
                ? styles.codexTicketItemReady
                : ticket.blocked
                  ? styles.codexTicketItemBlocked
                  : styles.codexTicketItemMissing
            }`}
            title={`${ticket.model}: ${statusLabel}`}
          >
            <span className={styles.codexTicketModel}>{ticket.model}</span>
            <span className={styles.codexTicketStatus}>{statusLabel}</span>
          </span>
        );
      })}
    </div>
  );
}
