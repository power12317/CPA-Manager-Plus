import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import type { ContextMenuState } from './ModelMappingDiagramTypes';
import styles from './ModelMappingDiagram.module.scss';

interface DiagramContextMenuProps {
  contextMenu: ContextMenuState | null;
  t: TFunction;
  onRequestClose: () => void;
  onAddAlias: () => void;
  onRenameAlias: (alias: string) => void;
  onOpenAliasSettings: (alias: string) => void;
  onDeleteAlias: (alias: string) => void;
  onEditProvider: (provider: string) => void;
  onDeleteProvider: (provider: string) => void;
  onOpenSourceSettings: (sourceId: string) => void;
}

export function DiagramContextMenu({
  contextMenu,
  t,
  onRequestClose,
  onAddAlias,
  onRenameAlias,
  onOpenAliasSettings,
  onDeleteAlias,
  onEditProvider,
  onDeleteProvider,
  onOpenSourceSettings,
}: DiagramContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (event: globalThis.MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onRequestClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu, onRequestClose]);

  if (!contextMenu) return null;

  const { type, data } = contextMenu;

  const renderBackground = () => (
    <button type="button" className={styles.menuItem} onClick={onAddAlias}>
      <span>{t('oauth_model_alias.diagram_add_alias')}</span>
    </button>
  );

  const renderAlias = () => {
    if (!data) return null;
    return (
      <>
        <button type="button" className={styles.menuItem} onClick={() => onRenameAlias(data)}>
          <span>{t('oauth_model_alias.diagram_rename')}</span>
        </button>
        <button type="button" className={styles.menuItem} onClick={() => onOpenAliasSettings(data)}>
          <span>{t('oauth_model_alias.diagram_settings')}</span>
        </button>
        <div className={styles.menuDivider} />
        <button
          type="button"
          className={`${styles.menuItem} ${styles.danger}`}
          onClick={() => onDeleteAlias(data)}
        >
          <span>{t('oauth_model_alias.diagram_delete_alias')}</span>
        </button>
      </>
    );
  };

  const renderProvider = () => {
    if (!data) return null;
    return (
      <>
        <button type="button" className={styles.menuItem} onClick={() => onEditProvider(data)}>
          <span>{t('common.edit')}</span>
        </button>
        <div className={styles.menuDivider} />
        <button
          type="button"
          className={`${styles.menuItem} ${styles.danger}`}
          onClick={() => onDeleteProvider(data)}
        >
          <span>{t('oauth_model_alias.delete')}</span>
        </button>
      </>
    );
  };

  const renderSource = () => {
    if (!data) return null;
    return (
      <button type="button" className={styles.menuItem} onClick={() => onOpenSourceSettings(data)}>
        <span>{t('oauth_model_alias.diagram_settings')}</span>
      </button>
    );
  };

  return createPortal(
    <div
      ref={menuRef}
      className={styles.contextMenu}
      style={{ top: contextMenu.y, left: contextMenu.x }}
      onClick={(e) => e.stopPropagation()}
    >
      {type === 'background' && renderBackground()}
      {type === 'alias' && renderAlias()}
      {type === 'provider' && renderProvider()}
      {type === 'source' && renderSource()}
    </div>,
    document.body
  );
}
