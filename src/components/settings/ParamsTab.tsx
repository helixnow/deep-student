import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../ui/shad/Input';
import { Switch } from '../ui/shad/Switch';
import { SettingSection } from './SettingsCommon';
import { PdfSettingsSection } from './PdfSettingsSection';
import { OcrSettingsSection } from './OcrSettingsSection';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';
import { DEFAULT_CHAT_STREAM_TIMEOUT_SECONDS } from './constants';

const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

const SettingRow = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <div className="group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors overflow-hidden">
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="flex-shrink-0">
      {children}
    </div>
  </div>
);

const SwitchRow = ({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) => (
  <div className="group flex items-center justify-between gap-4 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors">
    <div className="flex-1 min-w-0">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <Switch checked={checked} onCheckedChange={onCheckedChange} />
  </div>
);

interface ParamsTabProps {
  extra: any;
  setExtra: React.Dispatch<React.SetStateAction<any>>;
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

  const handleFtsToggle = useCallback(async (v: boolean) => {
    setExtra((prev: any) => ({ ...prev, chatSemanticFtsPrefilter: v }));
    try {
      await invoke?.('save_setting', { key: 'search.chat.semantic.fts_prefilter.enabled', value: v ? '1' : '0' });
      showGlobalNotification('success', t('settings:notifications.semantic_fts_save_success'));
    } catch (error: unknown) {
      showGlobalNotification('error', t('settings:notifications.semantic_fts_save_error', { error: getErrorMessage(error) }));
      // 保存失败时回滚
      setExtra((prev: any) => ({ ...prev, chatSemanticFtsPrefilter: !v }));
    }
  }, [invoke, setExtra, t]);

  return (
    <div className="space-y-1 pb-10 text-left animate-in fade-in duration-500">
      <SettingSection
        title=""
        className="overflow-visible"
        dataTourId="params-chat-stream-section"
        hideHeader
      >
        <div>
          <GroupTitle title={t('common:settings.chat_stream.card_title')} />
          <div className="space-y-px">
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
                className="!w-28 h-8 text-xs bg-transparent"
              />
            </SettingRow>

            <SwitchRow
              title={t('common:settings.chat_stream.auto_cancel_label')}
              description={t('common:settings.chat_stream.auto_cancel_hint')}
              checked={(extra as any)?.chatStreamAutoCancel ?? true}
              onCheckedChange={checked => { void handleToggleChatStreamAutoCancel(checked); }}
            />
          </div>
        </div>

        <div className="mt-8">
          <GroupTitle title={t('settings:cards.search_settings_title')} />
          <div className="space-y-px">
            <SwitchRow
              title={t('settings:field_labels.semantic_search_fts_filter')}
              description={t('settings:sections.semantic_fts_desc')}
              checked={Boolean((extra as any)?.chatSemanticFtsPrefilter ?? true)}
              onCheckedChange={handleFtsToggle}
            />
          </div>
        </div>

        <div className="mt-8">
          <PdfSettingsSection />
        </div>

        <div className="mt-8">
          <OcrSettingsSection />
        </div>
      </SettingSection>
    </div>
  );
};

export default ParamsTab;
