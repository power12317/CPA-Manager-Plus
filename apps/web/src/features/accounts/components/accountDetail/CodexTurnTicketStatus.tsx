import { useTranslation } from 'react-i18next';
import type { AuthFileCodexTurnTicket } from '@/types/authFile';
import styles from '@/features/accounts/AccountsPage.module.scss';

const formatRemaining = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

interface CodexTurnTicketStatusProps {
  tickets?: AuthFileCodexTurnTicket[];
  compact?: boolean;
}

export function CodexTurnTicketStatus({ tickets, compact = false }: CodexTurnTicketStatusProps) {
  const { t } = useTranslation();
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
        const remaining = Math.max(0, Number(ticket.remaining_seconds) || 0);
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
              ready ? styles.codexTicketItemReady : styles.codexTicketItemMissing
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
