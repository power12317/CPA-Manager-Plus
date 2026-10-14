import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigSection } from '@/components/config/ConfigSection';
import { Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import { IconSend } from '@/components/ui/icons';
import type { VisualConfigValues, VisualConfigValidationErrors } from '@/types/visualConfig';
import styles from './EventNotificationsSettingsCard.module.scss';

interface Props {
  disabled?: boolean;
  values: VisualConfigValues;
  validationErrors?: VisualConfigValidationErrors;
  onChange: (patch: Partial<VisualConfigValues>) => void;
}

export function EventNotificationsSettingsCard({
  disabled = false,
  values,
  validationErrors,
  onChange,
}: Props) {
  const { t } = useTranslation();
  const platformOptions = useMemo<ReadonlyArray<SelectOption>>(
    () => [
      { value: 'feishu', label: t('event_notifications.feishu') },
      { value: 'wecom', label: t('event_notifications.wecom') },
      { value: 'dingtalk', label: t('event_notifications.dingtalk') },
    ],
    [t]
  );

  return (
    <ConfigSection
      title={t('event_notifications.title')}
      description={t('event_notifications.description')}
      icon={<IconSend size={18} />}
    >
      <div className={styles.content}>
        <Input
          label={t('event_notifications.instance_name')}
          value={values.eventNotificationInstanceName}
          onChange={(event) => onChange({ eventNotificationInstanceName: event.target.value })}
          disabled={disabled}
          hint={t('event_notifications.instance_name_hint')}
          error={
            validationErrors?.eventNotificationInstanceName
              ? t(
                  `config_management.visual.validation.${validationErrors.eventNotificationInstanceName}`
                )
              : undefined
          }
        />
        <div className={styles.field}>
          <span className={styles.label}>{t('event_notifications.platform')}</span>
          <Select
            value={values.eventNotificationPlatform}
            options={platformOptions}
            onChange={(value) =>
              onChange({
                eventNotificationPlatform: value as VisualConfigValues['eventNotificationPlatform'],
                eventNotificationSecret: '',
              })
            }
            disabled={disabled}
            ariaLabel={t('event_notifications.platform')}
            fullWidth
          />
        </div>
        <Input
          label={t('event_notifications.webhook')}
          type="url"
          autoComplete="off"
          value={values.eventNotificationWebhook}
          onChange={(event) => onChange({ eventNotificationWebhook: event.target.value })}
          disabled={disabled}
          hint={t('event_notifications.webhook_hint')}
          error={
            validationErrors?.eventNotificationWebhook
              ? t(
                  `config_management.visual.validation.${validationErrors.eventNotificationWebhook}`
                )
              : undefined
          }
        />
        <Input
          label={t('event_notifications.secret')}
          type="password"
          autoComplete="off"
          value={values.eventNotificationSecret}
          onChange={(event) => onChange({ eventNotificationSecret: event.target.value })}
          disabled={disabled || values.eventNotificationPlatform === 'wecom'}
          hint={
            values.eventNotificationPlatform === 'wecom'
              ? t('event_notifications.secret_not_used')
              : t('event_notifications.secret_hint')
          }
        />
      </div>
    </ConfigSection>
  );
}
