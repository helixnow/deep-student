import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { DsButton } from '@/components/ui/DsButton';
import { AppSelect } from '@/components/ui/app-menu';
import { Switch } from '@/components/ui/shad/Switch';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { getSetting, saveSetting } from '@/utils/settingsApi';
import { useOptionalDialogControl } from '@/contexts/DialogControlContext';
import { cn } from '@/lib/utils';
import type { ApiConfig, ModelProfile, VendorConfig } from '@/types';
import type { TestDeepseekCapabilityCommandArgs } from '../../../../contracts/ipc/generated/L02-llm-manager';
import type { AvailableOcrModelResponse } from '../../../../contracts/ipc/generated/L18-media-docs';
import { GroupTitle } from './settingsTabPrimitives';
import type { SystemConfig } from './types';
import speechSample from '../assets/deepseek-asr-sample.ogg?inline';

type Capability = TestDeepseekCapabilityCommandArgs['capability'] | 'tts';
type Result = { state: 'running' } | { state: 'passed'; time: number } | { state: 'failed'; message: string };
type Settings = Pick<SystemConfig, 'deepseekChatWebSearch' | 'deepseekChatReadUrl' | 'deepseekChatFiles' | 'deepseekChatSafetyCheck'
  | 'deepseekTtsVoice' | 'webSearchDeepseekKey' | 'webSearchDeepseekFetchEnabled' | 'voice_input_asr_model_config_id'>;

export interface DeepSeekCapabilitySettings {
  config: Settings;
  changeConfig(updates: Partial<Settings>): void;
  assignAsr(id: string | null): Promise<void>;
  enableModel(profile: ModelProfile): Promise<void>;
}

const toggles = {
  chat_search: ['deepseekChatWebSearch', 'deepseek.chat.web_search'],
  chat_read_url: ['deepseekChatReadUrl', 'deepseek.chat.read_url'],
  chat_files: ['deepseekChatFiles', 'deepseek.chat.files'],
  chat_safety: ['deepseekChatSafetyCheck', 'deepseek.chat.safety_check'],
  fetch: ['webSearchDeepseekFetchEnabled', 'web_search.deepseek.fetch_enabled'],
} as const;

function makeOcrSample() {
  const canvas = document.createElement('canvas');
  canvas.width = 420;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create the OCR test image');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';
  ctx.font = '38px sans-serif';
  ctx.fillText('DeepSeek OCR 34971', 20, 78);
  return canvas.toDataURL('image/png');
}

export function DeepSeekCapabilities({ vendor, models, settings }: {
  vendor: VendorConfig;
  models: { profile: ModelProfile; api: ApiConfig }[];
  settings: DeepSeekCapabilitySettings;
}) {
  const { t } = useTranslation('settings');
  const prefix = 'deepseek_capabilities';
  const title = useId();
  const { config, changeConfig, assignAsr, enableModel } = settings;
  const ocr = models.find(({ api }) => api.model === 'deepseek-ocr');
  const asr = models.find(({ api }) => api.model === 'deepseek-asr');
  const [engines, setEngines] = useState<AvailableOcrModelResponse[] | null>(null);
  const [engineError, setEngineError] = useState(false);
  const dialog = useOptionalDialogControl();
  const hasDialog = dialog != null;
  const [savedSearch, setSavedSearch] = useState<string[]>([]);
  const [saving, setSaving] = useState<Capability | null>(null);
  const [results, setResults] = useState<Partial<Record<Capability, Result>>>({});
  const providerConfigured = Boolean(vendor.apiKey?.trim());
  const searchConfigured = providerConfigured || Boolean(config.webSearchDeepseekKey?.trim());
  const ocrEnabled = Boolean(ocr?.api.enabled && engines?.some(engine => engine.configId === ocr.api.id && engine.enabled));
  const asrEnabled = Boolean(asr?.api.enabled && config.voice_input_asr_model_config_id === asr.api.id);
  const voice = config.deepseekTtsVoice === 'stella' || config.deepseekTtsVoice === 'tide' ? config.deepseekTtsVoice : 'system';
  const testing = Object.values(results).some(value => value?.state === 'running');
  const selectedSearch = dialog?.ready ? dialog.selectedSearchEngines : savedSearch;

  useEffect(() => {
    let active = true;
    void invoke<AvailableOcrModelResponse[]>('get_available_ocr_models').then(rows => {
      if (active) setEngines(rows);
    }, () => { if (active) setEngineError(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (hasDialog) return;
    let active = true;
    void getSetting('session.selected_search_engines').then(value => {
      if (active) setSavedSearch(value == null ? ['bing_rss'] : value.split(',').map(engine => engine.trim()).filter(Boolean));
    });
    return () => { active = false; };
  }, [hasDialog]);

  const update = async (id: Capability, operation: () => Promise<void>) => {
    setSaving(id);
    try { await operation(); }
    catch (error) { showGlobalNotification('error', getErrorMessage(error)); }
    finally { setSaving(null); }
  };

  const toggleOcr = async (enabled: boolean) => {
    if (!ocr || !engines) return;
    if (enabled && !ocr.api.enabled) await enableModel(ocr.profile);
    const current = await invoke<AvailableOcrModelResponse[]>('get_available_ocr_models');
    if (enabled && !current.some(engine => engine.configId === ocr.api.id)) {
      await invoke('add_ocr_engine', { configId: ocr.api.id, model: ocr.api.model, name: ocr.api.name });
    } else {
      await invoke('update_ocr_engine_priority', {
        engineList: current.map(engine => ({ configId: engine.configId,
          enabled: engine.configId === ocr.api.id ? enabled : engine.enabled })),
      });
    }
    setEngines(await invoke('get_available_ocr_models'));
  };

  const test = async (id: Capability) => {
    setResults(prev => ({ ...prev, [id]: { state: 'running' } }));
    const started = performance.now();
    try {
      let time: number;
      if (id === 'tts') {
        const encoded = await invoke<string>('tts_deepseek', { text: 'Hello, this is a test.', voiceId: voice === 'system' ? 'stella' : voice });
        const header = atob(encoded.slice(0, 16));
        if (encoded.length <= 60 || !header.startsWith('RIFF') || header.slice(8, 12) !== 'WAVE') throw new Error(t(`${prefix}.empty_result`));
        time = Math.round(performance.now() - started);
      } else {
        time = await invoke<number>('test_deepseek_capability', { capability: id,
          ...(id === 'ocr' ? { image: makeOcrSample() } : {}),
          ...(id === 'asr' ? { audio: speechSample.slice(speechSample.indexOf(',') + 1) } : {}),
        });
      }
      setResults(prev => ({ ...prev, [id]: { state: 'passed', time } }));
    } catch (error) {
      setResults(prev => ({ ...prev, [id]: { state: 'failed', message: getErrorMessage(error) } }));
    }
  };

  const switchFor = (label: string, enabled: boolean, operation: (checked: boolean) => Promise<void>, id: Capability, disabled = false) => (
    <Switch checked={enabled} aria-label={label} disabled={saving !== null || disabled}
      onCheckedChange={checked => void update(id, () => operation(checked))} />
  );
  const group = (name: 'chat' | 'standalone', ids: Capability[]) => (
    <div className="space-y-2">
      <GroupTitle title={t(`${prefix}.${name}`)} />
      <div className="divide-y divide-border/40 rounded-2xl bg-muted px-3 sm:px-4">
        {ids.map(id => {
          const label = t(`${prefix}.${id}.label`);
          const result = results[id];
          const needsSearchKey = id === 'search' || id === 'fetch';
          const configured = needsSearchKey ? searchConfigured : providerConfigured;
          const toggle = id in toggles ? toggles[id as keyof typeof toggles] : null;
          let control;
          let enabled: boolean;
          if (toggle) {
            const [field, key] = toggle;
            enabled = Boolean(config[field]);
            control = switchFor(label, enabled, async checked => {
              await saveSetting(key, String(checked));
              changeConfig({ [field]: checked });
            }, id);
          } else if (id === 'search') {
            enabled = selectedSearch.includes('deepseek');
            control = switchFor(label, enabled, async checked => {
              const next = checked ? [...selectedSearch, 'deepseek'] : selectedSearch.filter(engine => engine !== 'deepseek');
              if (dialog) await dialog.saveSelectedSearchEngines(next);
              else {
                await saveSetting('session.selected_search_engines', next.join(','));
                setSavedSearch(next);
              }
            }, id, (!enabled && !searchConfigured) || (dialog != null && !dialog.ready));
          } else if (id === 'ocr') {
            enabled = ocrEnabled;
            control = switchFor(label, enabled, toggleOcr, id, !ocr || !engines);
          } else if (id === 'asr') {
            enabled = asrEnabled;
            control = switchFor(label, enabled, async checked => {
              if (!asr) return;
              if (checked && !asr.api.enabled) await enableModel(asr.profile);
              await assignAsr(checked ? asr.api.id : null);
            }, id, !asr);
          } else {
            enabled = voice !== 'system';
            control = <AppSelect ariaLabel={label} value={voice} size="sm" width={120} disabled={saving !== null}
              options={[{ value: 'system', label: t('external_search.deepseek_tts_system') }, { value: 'stella', label: 'Stella' }, { value: 'tide', label: 'Tide' }]}
              onValueChange={value => void update(id, async () => {
                const next = value === 'system' ? '' : value;
                await saveSetting('deepseek.tts.voice', next);
                changeConfig({ deepseekTtsVoice: next });
                setResults(prev => ({ ...prev, tts: undefined }));
              })} />;
          }
          const status = result?.state === 'passed' ? t(`${prefix}.passed`, { time: result.time })
            : result?.state === 'running' ? t(`${prefix}.running`)
            : result?.state === 'failed' ? t(`${prefix}.failed`)
            : !configured ? t(`${prefix}.missing_key`) : t(`${prefix}.untested`);
          return (
            <div key={id} className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3" data-testid={`deepseek-capability-${id}`}>
              <div className="min-w-0 flex-[1_1_16rem] space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h4 className="text-sm text-foreground/90">{label}</h4>
                  <span className="text-xs text-muted-foreground">{t(`${prefix}.${id === 'ocr' && !engines ? (engineError ? 'status_unavailable' : 'loading') : enabled ? 'enabled' : 'disabled'}`)}</span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{t(`${prefix}.${id}.description`)}</p>
                <p aria-live="polite" className={cn('break-words text-xs', result?.state === 'failed' ? 'text-destructive' : result?.state === 'passed' ? 'text-success' : 'text-muted-foreground')}>
                  {status}{result?.state === 'failed' && ` · ${result.message}`}
                </p>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-3">
                <DsButton size="sm" variant="outline" className="[@media(pointer:coarse)]:!min-h-11"
                  aria-label={t(`${prefix}.test_named`, { name: label })}
                  disabled={!configured || saving !== null || testing}
                  onClick={() => void test(id)}>{t(`${prefix}.test`)}</DsButton>
                {control}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <section aria-labelledby={title} className="space-y-4">
      <GroupTitle titleId={title} title={t(`${prefix}.title`)} description={t(`${prefix}.description`)} />
      {group('chat', ['chat_search', 'chat_read_url', 'chat_files', 'chat_safety'])}
      {group('standalone', ['search', 'fetch', 'ocr', 'asr', 'tts'])}
    </section>
  );
}
