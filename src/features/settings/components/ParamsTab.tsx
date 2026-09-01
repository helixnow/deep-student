import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/shad/Input';
import { Switch } from '@/components/ui/shad/Switch';
import { SettingSection } from './SettingsCommon';
import { SettingRow, SwitchRow, GroupTitle } from './settingsTabPrimitives';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { DEFAULT_CHAT_STREAM_TIMEOUT_SECONDS } from './constants';
import type { SettingsExtra } from './hookDepsTypes';


interface ParamsTabProps {
  extra: SettingsExtra;
  setExtra: React.Dispatch<React.SetStateAction<SettingsExtra>>;
  invoke: ((cmd: string, args?: any) => Promise<any>) | null;
  handleSaveChatStreamTimeout: () => Promise<void>;
  handleToggleChatStreamAutoCancel: (checked: boolean) => Promise<void>;
}

export const ParamsTab: React.FC<ParamsTabProps> = ({
  extra,
  setExtra,
  invoke,
  handleSaveChatStreamTimeout,
  handleToggleChatStreamAutoCancel,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const paramsLoaded = extra.paramsLoaded === true;

  const handleFtsToggle = useCallback(async (v: boolean) => {
    setExtra((prev: any) => ({ ...prev, chatSemanticFtsPrefilter: v }));
    try {
      // 后端（lance_vector_store）消费的 key 是 rag.hybrid.fts_prefilter.enabled，
      // 旧 key search.chat.semantic.fts_prefilter.enabled 已废弃（仅读取时回退兼容）
      await invoke?.('save_setting', { key: 'rag.hybrid.fts_prefilter.enabled', value: v ? '1' : '0' });
      showGlobalNotification('success', t('settings:notifications.semantic_fts_save_success'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('settings:notifications.semantic_fts_save_error', { error: getErrorMessage(error) }));
      // 保存失败时回滚
      setExtra((prev: any) => ({ ...prev, chatSemanticFtsPrefilter: !v }));
    }
  }, [invoke, setExtra, t]);

  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow">
      <SettingSection
        title=""
        className="overflow-visible"
        dataTourId="params-chat-stream-section"
        hideHeader
      >
        <div>
          <GroupTitle title={t('common:settings.chat_stream.card_title')} />
          <div className="rounded-2xl bg-muted px-3 py-3 sm:px-4"><div className="space-y-px">
            <SettingRow
              title={t('common:settings.chat_stream.timeout_label')}
              description={t('common:settings.chat_stream.timeout_hint', { defaultSeconds: DEFAULT_CHAT_STREAM_TIMEOUT_SECONDS })}
            >
              <Input
                type="number"
                min={0}
                step={10}
                value={String((extra as any)?.chatStreamTimeoutSeconds ?? '')}
                onChange={e => setExtra((prev: any) => ({ ...prev, chatStreamTimeoutSeconds: e.target.value }))}
                onBlur={() => { void handleSaveChatStreamTimeout(); }}
                placeholder={t('common:settings.chat_stream.timeout_placeholder') ?? ''}
                className="!w-32 md:!w-28"
              />
            </SettingRow>

            <SwitchRow
              title={t('common:settings.chat_stream.auto_cancel_label')}
              description={t('common:settings.chat_stream.auto_cancel_hint')}
              checked={(extra as any)?.chatStreamAutoCancel ?? true}
              loading={!paramsLoaded}
              onCheckedChange={checked => {
                if (!paramsLoaded) return;
                void handleToggleChatStreamAutoCancel(checked);
              }}
            />
          </div></div>
        </div>

        <div className="mt-8">
          <GroupTitle title={t('settings:cards.search_settings_title')} />
          <div className="rounded-2xl bg-muted px-3 py-3 sm:px-4"><div className="space-y-px">
            <SwitchRow
              title={t('settings:field_labels.semantic_search_fts_filter')}
              description={t('settings:sections.semantic_fts_desc')}
              checked={Boolean((extra as any)?.chatSemanticFtsPrefilter ?? true)}
              loading={!paramsLoaded}
              onCheckedChange={(checked) => {
                if (!paramsLoaded) return;
                void handleFtsToggle(checked);
              }}
            />
          </div></div>
        </div>

      </SettingSection>
    </div>
  );
};

export default ParamsTab;
