/**
 * 设置 → 自动化 → Super-agent → 高级设置（仅在启用后显示）。
 *
 * 只暴露用户真正需要调的几项：处理策略、Router / Worker 模型、并行度、历史保留期。
 * 其余字段（过滤策略、超时、Watchdog 阈值）保持后端默认值，保存时原样回写。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { AppSelect, type AppSelectOption } from '@/components/ui/app-menu';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { DsButton } from '@/components/ui/DsButton';
import { getErrorMessage } from '@/utils/errorUtils';
import { TauriAPI } from '@/utils/tauriApi';
import { SettingRow } from './settingsTabPrimitives';

/** 后端 HubConfig（camelCase）；未列出的字段保存时原样回写。 */
export interface SuperAgentHubConfig {
  policyText: string;
  maxWorkers: number;
  workerConcurrency: number;
  routerModelId: string | null;
  workerModelId: string | null;
  retentionDays: number;
  [key: string]: unknown;
}

const FOLLOW_DEFAULT = '__default__';

const clampInt = (raw: string, min: number, max: number, fallback: number) => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

interface Props {
  /** 注入式读写，便于测试；默认调用后端命令 */
  load?: () => Promise<SuperAgentHubConfig>;
  save?: (config: SuperAgentHubConfig) => Promise<void>;
  loadModels?: () => Promise<AppSelectOption[]>;
}

const defaultLoad = () => invoke<SuperAgentHubConfig>('superagent_get_config');
const defaultSave = (config: SuperAgentHubConfig) => invoke<void>('superagent_set_config', { config });
const defaultLoadModels = async (): Promise<AppSelectOption[]> => {
  const configs = (await TauriAPI.getApiConfigurations()) ?? [];
  return configs
    .filter((c) => c.enabled !== false && !c.isEmbedding && !c.isReranker)
    .map((c) => ({ value: c.id, label: c.name || c.model }));
};

export const SuperAgentConfigPanel: React.FC<Props> = ({
  load = defaultLoad,
  save = defaultSave,
  loadModels = defaultLoadModels,
}) => {
  const { t } = useTranslation('superAgent');
  const [config, setConfig] = useState<SuperAgentHubConfig | null>(null);
  const [models, setModels] = useState<AppSelectOption[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((c) => !cancelled && setConfig(c))
      .catch((e) => !cancelled && setMessage({ tone: 'error', text: getErrorMessage(e) }));
    loadModels()
      .then((m) => !cancelled && setModels(m))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [load, loadModels]);

  const modelOptions = useMemo<AppSelectOption[]>(
    () => [{ value: FOLLOW_DEFAULT, label: t('config.followDefaultModel') }, ...models],
    [models, t],
  );

  const patch = useCallback((next: Partial<SuperAgentHubConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...next } : prev));
    setDirty(true);
    setMessage(null);
  }, []);

  const submit = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await save(config);
      setDirty(false);
      setMessage({ tone: 'ok', text: t('config.saved') });
    } catch (e) {
      setMessage({ tone: 'error', text: getErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return message ? <p className="px-1 pt-1 text-xs text-destructive">{message.text}</p> : null;
  }

  return (
    <div className="mt-2 border-t border-border/40 pt-2" data-testid="superagent-config">
      <SettingRow title={t('config.policyTitle')} description={t('config.policyDescription')} controlClassName="md:w-[320px]">
        <Textarea
          value={config.policyText}
          onChange={(e) => patch({ policyText: e.target.value })}
          placeholder={t('config.policyPlaceholder')}
          rows={4}
          aria-label={t('config.policyTitle')}
        />
      </SettingRow>
      <SettingRow title={t('config.routerModelTitle')} description={t('config.routerModelDescription')}>
        <AppSelect
          value={config.routerModelId ?? FOLLOW_DEFAULT}
          onValueChange={(v) => patch({ routerModelId: v === FOLLOW_DEFAULT ? null : v })}
          options={modelOptions}
          size="sm"
          width={260}
        />
      </SettingRow>
      <SettingRow title={t('config.workerModelTitle')} description={t('config.workerModelDescription')}>
        <AppSelect
          value={config.workerModelId ?? FOLLOW_DEFAULT}
          onValueChange={(v) => patch({ workerModelId: v === FOLLOW_DEFAULT ? null : v })}
          options={modelOptions}
          size="sm"
          width={260}
        />
      </SettingRow>
      <SettingRow title={t('config.concurrencyTitle')} description={t('config.concurrencyDescription')}>
        <Input
          type="number"
          min={1}
          max={6}
          className="w-24"
          value={config.workerConcurrency}
          onChange={(e) => patch({ workerConcurrency: clampInt(e.target.value, 1, 6, config.workerConcurrency) })}
          aria-label={t('config.concurrencyTitle')}
        />
      </SettingRow>
      <SettingRow title={t('config.maxWorkersTitle')} description={t('config.maxWorkersDescription')}>
        <Input
          type="number"
          min={1}
          max={20}
          className="w-24"
          value={config.maxWorkers}
          onChange={(e) => patch({ maxWorkers: clampInt(e.target.value, 1, 20, config.maxWorkers) })}
          aria-label={t('config.maxWorkersTitle')}
        />
      </SettingRow>
      <SettingRow title={t('config.retentionTitle')} description={t('config.retentionDescription')}>
        <Input
          type="number"
          min={0}
          max={3650}
          className="w-24"
          value={config.retentionDays}
          onChange={(e) => patch({ retentionDays: clampInt(e.target.value, 0, 3650, config.retentionDays) })}
          aria-label={t('config.retentionTitle')}
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
