import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/DropdownMenu';
import { IconChevronDown } from '@/components/ui/icons';
import { PROVIDER_KIND_LABELS } from '../ProviderTable/kindMeta';
import { PROVIDER_KINDS, type ProviderKind } from '../ProviderTable/rowData';
import type { ProviderKindFilter } from '../ProviderTable/sort';
import styles from './ProviderToolbar.module.scss';

interface ProviderAddButtonProps {
  kind: ProviderKindFilter;
  disabled: boolean;
  className?: string;
  onAdd: (kind: ProviderKind) => void;
  codexSystemScopedOAuth?: boolean;
  onAddCodexOAuth?: (system: 'mac' | 'windows') => void;
}

export function ProviderAddButton({
  kind,
  disabled,
  className = styles.addButton,
  onAdd,
  codexSystemScopedOAuth = false,
  onAddCodexOAuth,
}: ProviderAddButtonProps) {
  const { t } = useTranslation();
  const canAddSystemOAuth = codexSystemScopedOAuth && Boolean(onAddCodexOAuth);
  const triggerLabel =
    kind === 'all'
      ? t('ai_providers.add_config_button')
      : t('ai_providers.add_kind_button', { name: PROVIDER_KIND_LABELS[kind] });

  if (kind !== 'all' && (kind !== 'codex' || !canAddSystemOAuth)) {
    return (
      <Button
        variant="primary"
        size="sm"
        onClick={() => onAdd(kind)}
        disabled={disabled}
        className={className}
      >
        {triggerLabel}
      </Button>
    );
  }

  const systemItems: DropdownMenuItem[] = [
    {
      key: 'codex-mac',
      label: t(
        kind === 'all' ? 'ai_providers.codex_mac_option' : 'auth_login.codex_macos_oauth_button'
      ),
      onClick: () => onAddCodexOAuth?.('mac'),
    },
    {
      key: 'codex-windows',
      label: t(
        kind === 'all'
          ? 'ai_providers.codex_windows_option'
          : 'auth_login.codex_windows_oauth_button'
      ),
      onClick: () => onAddCodexOAuth?.('windows'),
    },
  ];
  const manualItem: DropdownMenuItem = {
    key: 'codex-api-key',
    label: t(
      kind === 'all'
        ? 'ai_providers.codex_api_key_option'
        : 'ai_providers.codex_manual_config_option'
    ),
    onClick: () => onAdd('codex'),
  };
  const items: DropdownMenuItem[] =
    kind === 'all'
      ? PROVIDER_KINDS.flatMap((provider): DropdownMenuItem[] =>
          provider === 'codex' && canAddSystemOAuth
            ? [...systemItems, manualItem]
            : [
                {
                  key: provider,
                  label: PROVIDER_KIND_LABELS[provider],
                  onClick: () => onAdd(provider),
                },
              ]
        )
      : [...systemItems, { key: 'manual-divider', type: 'divider' }, manualItem];

  return (
    <DropdownMenu
      key={`${kind}:${canAddSystemOAuth}`}
      ariaLabel={t(
        kind === 'all' ? 'ai_providers.add_config_menu_aria' : 'ai_providers.codex_add_menu_aria'
      )}
      triggerLabel={
        <>
          {triggerLabel}
          <IconChevronDown size={14} />
        </>
      }
      triggerClassName={className}
      disabled={disabled}
      items={items}
    />
  );
}
