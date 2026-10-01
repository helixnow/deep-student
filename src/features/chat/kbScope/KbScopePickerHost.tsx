import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderPickerDialog } from '@/features/learning-hub/components/finder/FolderPickerDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { KB_SCOPE_PICKER_EVENT, setKbScope } from './kbScope';

/** 挂在聊天页：「＋」菜单的「检索范围」打开文件夹选择器；选根目录 = 不限范围 */
export const KbScopePickerHost: React.FC = () => {
  const { t } = useTranslation('chatV2');
  const { isSmallScreen } = useBreakpoint();
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (id) setSessionId(id);
    };
    window.addEventListener(KB_SCOPE_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(KB_SCOPE_PICKER_EVENT, onOpen);
  }, []);
  return (
    <FolderPickerDialog
      open={sessionId !== null}
      onOpenChange={(open) => { if (!open) setSessionId(null); }}
      title={t('inputBar.plusMenu.kbScopePick', { defaultValue: '选择检索范围（课程 / 文件夹）' })}
      inline={isSmallScreen}
      onConfirm={(folderId) => {
        const id = sessionId;
        setSessionId(null);
        if (!id) return;
        void setKbScope(id, folderId ? [folderId] : [])
          .then(() => showGlobalNotification('success', folderId
            ? t('inputBar.plusMenu.kbScopeSet', { defaultValue: '知识库只检索所选文件夹' })
            : t('inputBar.plusMenu.kbScopeCleared', { defaultValue: '知识库检索全部资料' })))
          .catch((error) => showGlobalNotification('error', String(error)));
      }}
    />
  );
};
