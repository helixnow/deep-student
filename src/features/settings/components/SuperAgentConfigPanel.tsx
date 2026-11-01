/**
 * 设置 → 自动化 → Super-agent → 额外指令（仅在启用后显示）。
 *
 * Super-agent 会话就是一个普通会话：模型、工具、审批等都沿用会话本身的设置，
 * 这里只保留一项——注入 Router 提示词的「额外指令」（后端 settings 的 super_agent.instructions）。
 *
 * 读写命令：super_session_get_settings / super_session_set_settings（与
 * features/chat/superSession/api.ts 的 getSuperSessionSettings / setSuperSessionSettings 同一契约）。
 * 设置页属于 features/settings，不能深引用 features/chat 内部模块，因此默认实现直接 invoke；
 * load/save 可注入，便于测试。
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Textarea } from '@/components/ui/shad/Textarea';
import { DsButton } from '@/components/ui/DsButton';
import { getErrorMessage } from '@/utils/errorUtils';
import { SettingRow } from './settingsTabPrimitives';

/** 后端 SuperSessionSettings（camelCase） */
export interface SuperSessionSettings {
  instructions: string;
}

interface Props {
  /** 注入式读写，便于测试；默认调用后端命令 */
  load?: () => Promise<SuperSessionSettings>;
  save?: (settings: SuperSessionSettings) => Promise<void>;
}

const defaultLoad = () => invoke<SuperSessionSettings>('super_session_get_settings');
const defaultSave = (settings: SuperSessionSettings) => invoke<void>('super_session_set_settings', { settings });

export const SuperAgentConfigPanel: React.FC<Props> = ({
  load = defaultLoad,
  save = defaultSave,
}) => {
  const { t } = useTranslation('superAgent');
  const [instructions, setInstructions] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((s) => !cancelled && setInstructions(s?.instructions ?? ''))
      .catch((e) => !cancelled && setMessage({ tone: 'error', text: getErrorMessage(e) }));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const submit = async () => {
    if (instructions === null) return;
    setSaving(true);
    try {
      await save({ instructions });
      setDirty(false);
      setMessage({ tone: 'ok', text: t('config.saved') });
    } catch (e) {
      setMessage({ tone: 'error', text: getErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  if (instructions === null) {
    return message ? <p className="px-1 pt-1 text-xs text-destructive">{message.text}</p> : null;
  }

  return (
    <div className="mt-2 border-t border-border/40 pt-2" data-testid="superagent-config">
      <SettingRow
        title={t('config.instructionsTitle')}
        description={t('config.instructionsDescription')}
        controlClassName="md:w-[320px]"
      >
        <Textarea
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            setDirty(true);
            setMessage(null);
          }}
          placeholder={t('config.instructionsPlaceholder')}
          rows={4}
          className="max-md:!w-full max-md:!min-w-0"
          aria-label={t('config.instructionsTitle')}
        />
      </SettingRow>
      <div className="flex items-center gap-3 px-1 pt-2">
        <DsButton size="sm" onClick={() => void submit()} disabled={!dirty || saving} data-testid="superagent-config-save">
          {t('config.save')}
        </DsButton>
        {message && (
          <span className={message.tone === 'ok' ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
};

export default SuperAgentConfigPanel;
