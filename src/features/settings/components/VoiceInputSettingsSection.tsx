/**
 * 听写设置区块
 *
 * Notion 风格：标题 + 精简描述 + GroupTitle/SettingRow 模式。
 * 视觉层次：
 *   1. 状态条（随时可见的"是否可录音 + 申请权限"）
 *   2. ASR 模型分配（一行，异常状态用内联琥珀提示）
 *   3. 触发方式（segmented）/ 快捷键 / 最长时长（SettingRow）
 *   4. 自定义词典（块）
 *   5. 最近听写记录（块，若有内容）
 *   6. 运行时诊断（可折叠，默认收起）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Warning,
  ChartBar,
  CaretDown,
  Copy,
  CircleNotch,
  ArrowCounterClockwise,
  GearSix,
  Trash,
  Wrench,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  DEFAULT_VOICE_INPUT_CONFIG,
  loadVoiceInputConfig,
  saveVoiceInputConfig,
} from '@/voice-input/config';
import {
  VOICE_INPUT_HISTORY_CHANGED_EVENT,
  clearVoiceInputHistory,
  loadVoiceInputHistory,
} from '@/voice-input/history';
import type {
  VoiceInputAssignedModel,
  VoiceInputConfig,
  VoiceInputHistoryEntry,
  VoiceInputHotkeyMode,
} from '@/voice-input/types';
import {
  detectVoiceRecordingSupport,
  requestVoiceRecordingPermission,
  type VoiceRecordingSupport,
} from '@/voice-input/support';

type SettingsTabId = 'apis' | 'models' | 'statistics';

function openSettingsTab(tab: SettingsTabId): void {
  window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab } }));
}

function serializeVocabularyDraft(entries: string[] | undefined): string {
  return (entries ?? []).join('\n');
}

function parseVocabularyDraft(value: string): string[] {
  const unique = new Set<string>();
  for (const segment of value.split(/\n|,/g)) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    unique.add(trimmed);
  }
  return Array.from(unique);
}

function formatVoiceHistoryTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

// —— 公共小组件 ————————————————————————————————————————————

const GroupTitle: React.FC<{ title: string; description?: string; rightSlot?: React.ReactNode }> = ({
  title,
  description,
  rightSlot,
}) => (
  <div className="px-1 mb-3 flex items-start justify-between gap-3">
    <div className="min-w-0">
      <h3 className="text-base font-semibold text-foreground leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">{description}</p>
      )}
    </div>
    {rightSlot && <div className="flex-shrink-0 flex items-center gap-1">{rightSlot}</div>}
  </div>
);

const SettingRow: React.FC<{
  title: string;
  description?: string;
  children: React.ReactNode;
}> = ({ title, description, children }) => (
  <div className="group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 rounded">
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <div className="text-sm text-foreground/90 leading-tight">{title}</div>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="flex-shrink-0">{children}</div>
  </div>
);

const Subsection: React.FC<{
  title: string;
  description?: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, rightSlot, children }) => (
  <div className="py-2.5 px-1">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm text-foreground/90 leading-tight">{title}</div>
        {description && (
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">
            {description}
          </p>
        )}
      </div>
      {rightSlot}
    </div>
    <div className="mt-2">{children}</div>
  </div>
);

// —— 顶部状态条 ————————————————————————————————————————————

function StatusBar({
  support,
  requestingAccess,
  onRequestAccess,
  t,
}: {
  support: VoiceRecordingSupport | null;
  requestingAccess: boolean;
  onRequestAccess: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const { tone, label } = useMemo(() => {
    if (!support) {
      return {
        tone: 'muted' as const,
        label: t('settings:voice_input.status.checking', { defaultValue: 'Checking microphone support…' }),
      };
    }
    if (support.canRecord) {
      return {
        tone: 'ok' as const,
        label:
          support.recorderMode === 'pcm-wav'
            ? t('settings:voice_input.status.ready_fallback', {
                defaultValue: 'Ready with PCM/WAV fallback',
              })
            : t('settings:voice_input.status.ready', { defaultValue: 'Ready to record' }),
      };
    }
    const code = support.reasonCode;
    const map: Record<string, string> = {
      'permission-denied': t('settings:voice_input.status.permission_denied', {
        defaultValue: 'Microphone permission denied',
      }),
      'insecure-context': t('settings:voice_input.status.insecure_context', {
        defaultValue: 'Runtime is not exposing a secure recording context',
      }),
      'missing-get-user-media': t('settings:voice_input.status.missing_get_user_media', {
        defaultValue: 'Runtime does not expose getUserMedia',
      }),
    };
    return {
      tone: 'warn' as const,
      label:
        (code && map[code]) ??
        t('settings:voice_input.status.unavailable', { defaultValue: 'Recording backend unavailable' }),
    };
  }, [support, t]);

  const dotClass =
    tone === 'ok'
      ? 'bg-emerald-500'
      : tone === 'warn'
        ? 'bg-amber-500'
        : 'bg-muted-foreground/40';
  const labelClass =
    tone === 'ok'
      ? 'text-foreground/80'
      : tone === 'warn'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-muted-foreground/70';

  return (
    <div className="flex items-center justify-between gap-3 py-2.5 px-1 rounded">
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotClass)} />
        <span className={cn('text-sm truncate', labelClass)}>{label}</span>
      </div>
      <NotionButton
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRequestAccess}
        disabled={requestingAccess}
      >
        {requestingAccess ?           <CircleNotch size={14} className="animate-spin" /> : null}
        {t('settings:voice_input.request_access', { defaultValue: 'Request microphone access' })}
      </NotionButton>
    </div>
  );
}

// —— ASR 模型状态内联提示 ————————————————————————————————————

function ModelStatusHint({
  assignedModel,
  t,
}: {
  assignedModel: VoiceInputAssignedModel;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  if (assignedModel.status === 'ready') return null;

  const map: Record<Exclude<VoiceInputAssignedModel['status'], 'ready'>, string> = {
    'model-assignment-required': t('settings:voice_input.assignment_required_message', {
      defaultValue:
        'Voice input is enabled at the app layer, but it still needs a model assignment in Settings > Models before recordings can be transcribed.',
    }),
    'model-config-missing': t('settings:voice_input.assignment_missing_message', {
      defaultValue:
        'The saved assignment no longer points to a valid voice-capable model. Reassign it in Settings > Models.',
    }),
    'model-disabled': t('settings:voice_input.assignment_disabled_message', {
      defaultValue:
        'Enable the assigned model or pick another ASR model in Settings > Models before using voice input.',
    }),
    'provider-unavailable': t('settings:voice_input.assignment_provider_unavailable_message', {
      defaultValue:
        'This runtime currently supports SiliconFlow transcription only. Pick a SiliconFlow ASR model for now, or keep the current assignment as a placeholder for future streaming providers.',
    }),
  };

  return (
    <div className="mx-1 my-1 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
      <div className="flex items-start gap-2">
        <Warning className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>{map[assignedModel.status]}</span>
      </div>
    </div>
  );
}

// —— Segmented control (触发方式) ——————————————————————————————

function HotkeyModeSegmented({
  value,
  disabled,
  onChange,
  t,
}: {
  value: VoiceInputHotkeyMode;
  disabled: boolean;
  onChange: (mode: VoiceInputHotkeyMode) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const segments: Array<{
    mode: VoiceInputHotkeyMode;
    label: string;
    ariaLabel: string;
  }> = [
    {
      mode: 'hold-to-talk',
      label: t('settings:voice_input.hold_mode_short', { defaultValue: 'Hold' }),
      ariaLabel: t('settings:voice_input.hold_mode_title', {
        defaultValue: 'Press and hold the dictation shortcut',
      }),
    },
    {
      mode: 'toggle-to-record',
      label: t('settings:voice_input.toggle_mode_short', { defaultValue: 'Toggle' }),
      ariaLabel: t('settings:voice_input.toggle_mode_title', {
        defaultValue: 'Tap once to start, tap once to stop',
      }),
    },
  ];

  return (
    <SegmentedControl
      ariaLabel={t('settings:voice_input.trigger_mode_title', { defaultValue: 'Trigger Mode' })}
      value={value}
      onValueChange={onChange}
      size="compact"
      options={segments.map((segment) => ({
        value: segment.mode,
        label: segment.label,
        ariaLabel: segment.ariaLabel,
        disabled,
      }))}
    />
  );
}

// —— 历史记录条目 —————————————————————————————————————————

function HistoryEntryCard({
  entry,
  onCopy,
  copyLabel,
}: {
  entry: VoiceInputHistoryEntry;
  onCopy: (entry: VoiceInputHistoryEntry) => void;
  copyLabel: string;
}) {
  return (
    <div className="py-2.5 px-1 rounded">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="text-[11px] text-muted-foreground/70">
          {formatVoiceHistoryTime(entry.createdAt)}
          {entry.providerId ? ` · ${entry.providerId}` : ''}
          {entry.model ? ` · ${entry.model}` : ''}
          {typeof entry.durationMs === 'number'
            ? ` · ${Math.max(1, Math.round(entry.durationMs / 1000))}s`
            : ''}
        </div>
        <NotionButton type="button" variant="ghost" size="sm" onClick={() => onCopy(entry)}>
          <Copy size={14} />
          {copyLabel}
        </NotionButton>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
        {entry.text}
      </p>
    </div>
  );
}

// —— 主组件 ———————————————————————————————————————————————

interface VoiceInputSettingsSectionProps {
  assignedModel: VoiceInputAssignedModel;
  embedded?: boolean;
}

export function VoiceInputSettingsSection({ assignedModel, embedded = false }: VoiceInputSettingsSectionProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [config, setConfig] = useState<VoiceInputConfig>(DEFAULT_VOICE_INPUT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [support, setSupport] = useState<VoiceRecordingSupport | null>(null);
  const [historyEntries, setHistoryEntries] = useState<VoiceInputHistoryEntry[]>([]);
  const [vocabularyDraft, setVocabularyDraft] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const savedConfigRef = useRef<VoiceInputConfig>(DEFAULT_VOICE_INPUT_CONFIG);

  const refreshSupport = useCallback(async () => {
    const nextSupport = await detectVoiceRecordingSupport();
    setSupport(nextSupport);
  }, []);

  const refreshHistory = useCallback(async () => {
    const entries = await loadVoiceInputHistory();
    setHistoryEntries(entries);
  }, []);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        const [loadedConfig, loadedSupport, loadedHistory] = await Promise.all([
          loadVoiceInputConfig(),
          detectVoiceRecordingSupport(),
          loadVoiceInputHistory(),
        ]);
        if (disposed) return;
        savedConfigRef.current = loadedConfig;
        setConfig(loadedConfig);
        setVocabularyDraft(serializeVocabularyDraft(loadedConfig.dictationVocabulary));
        setSupport(loadedSupport);
        setHistoryEntries(loadedHistory);
      } catch {
        if (!disposed) {
          showGlobalNotification(
            'error',
            t('settings:voice_input.load_failed', {
              defaultValue: 'Failed to load voice input settings.',
            })
          );
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    })();

    return () => {
      disposed = true;
    };
  }, [t]);

  useEffect(() => {
    const handleHistoryChanged = () => {
      void refreshHistory();
    };
    window.addEventListener(VOICE_INPUT_HISTORY_CHANGED_EVENT, handleHistoryChanged);
    return () => window.removeEventListener(VOICE_INPUT_HISTORY_CHANGED_EVENT, handleHistoryChanged);
  }, [refreshHistory]);

  const persist = useCallback(
    async (nextConfig: VoiceInputConfig) => {
      setSaving(true);
      try {
        const savedConfig = await saveVoiceInputConfig(nextConfig);
        savedConfigRef.current = savedConfig;
        setConfig(savedConfig);
        setVocabularyDraft(serializeVocabularyDraft(savedConfig.dictationVocabulary));
      } catch {
        const fallbackConfig = savedConfigRef.current;
        setConfig(fallbackConfig);
        setVocabularyDraft(serializeVocabularyDraft(fallbackConfig.dictationVocabulary));
        showGlobalNotification(
          'error',
          t('settings:voice_input.save_failed', {
            defaultValue: 'Failed to save voice input settings.',
          })
        );
      } finally {
        setSaving(false);
      }
    },
    [t]
  );

  const handleSelectHotkeyMode = useCallback(
    (mode: VoiceInputHotkeyMode) => {
      const nextConfig = { ...config, hotkeyMode: mode };
      setConfig(nextConfig);
      void persist(nextConfig);
    },
    [config, persist]
  );

  const handlePersistVocabulary = useCallback(
    (value: string) => {
      const nextConfig = {
        ...config,
        dictationVocabulary: parseVocabularyDraft(value),
      };
      setConfig(nextConfig);
      setVocabularyDraft(value);
      void persist(nextConfig);
    },
    [config, persist]
  );

  const handleCopyHistoryEntry = useCallback(
    async (entry: VoiceInputHistoryEntry) => {
      try {
        await navigator.clipboard.writeText(entry.text);
        showGlobalNotification(
          'success',
          t('settings:voice_input.history_copy_success', { defaultValue: 'Dictation text copied.' })
        );
      } catch {
        showGlobalNotification(
          'error',
          t('settings:voice_input.history_copy_failed', {
            defaultValue: 'Unable to copy this dictation entry.',
          })
        );
      }
    },
    [t]
  );

  const handleClearHistory = useCallback(async () => {
    try {
      await clearVoiceInputHistory();
      setHistoryEntries([]);
      showGlobalNotification(
        'success',
        t('settings:voice_input.history_clear_success', {
          defaultValue: 'Recent dictation history cleared.',
        })
      );
    } catch {
      showGlobalNotification(
        'error',
        t('settings:voice_input.history_clear_failed', {
          defaultValue: 'Unable to clear recent dictation history.',
        })
      );
    }
  }, [t]);

  const requestMicrophoneAccess = useCallback(async () => {
    setRequestingAccess(true);
    try {
      const nextSupport = await requestVoiceRecordingPermission();
      setSupport(nextSupport);
      if (nextSupport.canRecord) {
        showGlobalNotification(
          'success',
          t('settings:voice_input.permission_request_success', {
            defaultValue: 'Microphone access is ready. You can start voice input now.',
          })
        );
      } else {
        const reasonCode = nextSupport.reasonCode ?? 'recording-unavailable';
        // Note: 'microphone-not-found' / 'microphone-busy' / 'permission-denied' are
        // runtime-only sentinels coming from async recorder errors (see catch block below).
        // They are not part of the static `reasonCode` union, so we only check the dynamic path here.
        showGlobalNotification('error', translatePermissionFailure(t, reasonCode));
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'recording-unavailable';
      showGlobalNotification(
        code === 'permission-denied' || code === 'microphone-not-found' || code === 'microphone-busy'
          ? 'warning'
          : 'error',
        translatePermissionFailure(t, code)
      );
      await refreshSupport();
    } finally {
      setRequestingAccess(false);
    }
  }, [refreshSupport, t]);

  if (loading) {
    return (
      <section className={embedded ? undefined : 'mt-8'}>
        <GroupTitle
          title={t('settings:voice_input.title', { defaultValue: 'Dictation' })}
        />
        <div className="flex items-center gap-2 py-3 px-1 text-sm text-muted-foreground">
          <CircleNotch size={16} className="animate-spin" />
          <span>
            {t('settings:voice_input.loading', {
              defaultValue: 'Loading voice input settings…',
            })}
          </span>
        </div>
      </section>
    );
  }

  const vocabularyCount = parseVocabularyDraft(vocabularyDraft).length;
  const activeHotkeyMode = config.hotkeyMode ?? DEFAULT_VOICE_INPUT_CONFIG.hotkeyMode;
  const assignedLabel =
    assignedModel.modelLabel ??
    assignedModel.model ??
    t('settings:voice_input.not_configured', { defaultValue: 'Not configured' });
  const assignedProvider = assignedModel.providerLabel ?? null;

  return (
    <section className={embedded ? undefined : 'mt-8'}>
      <GroupTitle
        title={t('settings:voice_input.title', { defaultValue: 'Dictation' })}
        description={t('settings:voice_input.description_short', {
          defaultValue: 'Shortcuts, vocabulary, and history for dictation.',
        })}
        rightSlot={
          <>
            <NotionButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => openSettingsTab('models')}
            >
              <GearSix size={14} />
              {t('settings:voice_input.open_model_settings', { defaultValue: 'Open Model Assignments' })}
            </NotionButton>
            <NotionButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => openSettingsTab('apis')}
            >
              <Wrench size={14} />
              {t('settings:voice_input.open_api_settings', { defaultValue: 'Open API Settings' })}
            </NotionButton>
            <NotionButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => openSettingsTab('statistics')}
            >
              <ChartBar size={14} />
              {t('settings:voice_input.open_usage_statistics', { defaultValue: 'Open Usage Statistics' })}
            </NotionButton>
          </>
        }
      />

      <div className="space-y-px">
        <StatusBar
          support={support}
          requestingAccess={requestingAccess}
          onRequestAccess={() => {
            void requestMicrophoneAccess();
          }}
          t={t}
        />

        <SettingRow
          title={t('settings:voice_input.assigned_model', { defaultValue: 'Assigned ASR Model' })}
          description={assignedProvider ?? undefined}
        >
          <div className="text-sm text-foreground/80 text-right">{assignedLabel}</div>
        </SettingRow>
        <ModelStatusHint assignedModel={assignedModel} t={t} />

        <SettingRow
          title={t('settings:voice_input.trigger_mode_title', { defaultValue: 'Trigger Mode' })}
          description={t('settings:voice_input.trigger_mode_description', {
            defaultValue:
              'Hold the hotkey to speak, or tap once to toggle. Dictation inserts at the cursor without auto-sending.',
          })}
        >
          <HotkeyModeSegmented
            value={activeHotkeyMode}
            disabled={saving}
            onChange={handleSelectHotkeyMode}
            t={t}
          />
        </SettingRow>

        <SettingRow title={t('settings:voice_input.hotkey', { defaultValue: 'Hotkey' })}>
          <Input
            disabled={saving}
            value={config.hotkey}
            onChange={(event) => {
              setConfig((current) => ({ ...current, hotkey: event.target.value }));
            }}
            onBlur={(event) => {
              const nextConfig = { ...config, hotkey: event.currentTarget.value };
              setConfig(nextConfig);
              void persist(nextConfig);
            }}
            className="h-8 w-40 text-xs"
          />
        </SettingRow>

        <SettingRow
          title={t('settings:voice_input.max_duration_ms', { defaultValue: 'Max Duration (ms)' })}
        >
          <Input
            disabled={saving}
            type="number"
            inputMode="numeric"
            value={String(config.maxDurationMs)}
            onChange={(event) => {
              setConfig((current) => ({
                ...current,
                maxDurationMs: Number(event.target.value || DEFAULT_VOICE_INPUT_CONFIG.maxDurationMs),
              }));
            }}
            onBlur={(event) => {
              const nextConfig = {
                ...config,
                maxDurationMs: Number(
                  event.currentTarget.value || DEFAULT_VOICE_INPUT_CONFIG.maxDurationMs
                ),
              };
              setConfig(nextConfig);
              void persist(nextConfig);
            }}
            className="h-8 w-32 text-xs"
          />
        </SettingRow>

        <Subsection
          title={t('settings:voice_input.dictionary_title', { defaultValue: 'Dictation Vocabulary' })}
          description={t('settings:voice_input.dictionary_description', {
            defaultValue: 'Words or short phrases dictation should prefer. One per line.',
          })}
        >
          <Textarea
            disabled={saving}
            value={vocabularyDraft}
            onChange={(event) => setVocabularyDraft(event.target.value)}
            onBlur={(event) => handlePersistVocabulary(event.currentTarget.value)}
            rows={4}
            placeholder={t('settings:voice_input.dictionary_placeholder', {
              defaultValue: 'Photosynthesis\nAnkylosing spondylitis\nDeepStudent',
            })}
          />
          <div className="mt-1.5 text-[11px] text-muted-foreground/70">
            {t('settings:voice_input.dictionary_count', {
              defaultValue: '{{count}} phrase hints',
              count: vocabularyCount,
            })}
          </div>
        </Subsection>

        <Subsection
          title={t('settings:voice_input.history_title', {
            defaultValue: 'Recent Dictation History',
          })}
          description={
            historyEntries.length === 0
              ? t('settings:voice_input.history_empty', {
                  defaultValue: 'Your recent dictation transcripts will appear here.',
                })
              : undefined
          }
          rightSlot={
            historyEntries.length > 0 ? (
              <NotionButton
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleClearHistory()}
              >
                <Trash size={14} />
                {t('settings:voice_input.history_clear', { defaultValue: 'Clear' })}
              </NotionButton>
            ) : null
          }
        >
          {historyEntries.length > 0 && (
            <div className="space-y-px">
              {historyEntries.map((entry) => (
                <HistoryEntryCard
                  key={entry.id}
                  entry={entry}
                  onCopy={handleCopyHistoryEntry}
                  copyLabel={t('settings:voice_input.history_copy', { defaultValue: 'Copy' })}
                />
              ))}
            </div>
          )}
        </Subsection>

        {/* 诊断（默认折叠） */}
        <div className="px-1">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => setDiagnosticsOpen((prev) => !prev)}
            aria-expanded={diagnosticsOpen}
            className="!h-auto !px-0 !py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <CaretDown
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                diagnosticsOpen ? 'rotate-0' : '-rotate-90'
              )}
            />
            {t('settings:voice_input.diagnostics_title', { defaultValue: 'Diagnostics' })}
          </NotionButton>
          {diagnosticsOpen && (
            <div className="pl-5 pb-2 space-y-2">
              <div className="grid gap-1.5 grid-cols-2 xl:grid-cols-4">
                <DiagnosticItem
                  label={t('settings:voice_input.diagnostics.permission', {
                    defaultValue: 'Permission',
                  })}
                  value={
                    support?.permissionState
                      ? t(`settings:voice_input.permission_states.${support.permissionState}`, {
                          defaultValue: support.permissionState,
                        })
                      : t('settings:voice_input.permission_states.unknown', {
                          defaultValue: 'unknown',
                        })
                  }
                />
                <DiagnosticItem
                  label={t('settings:voice_input.diagnostics.capture_api', {
                    defaultValue: 'Capture API',
                  })}
                  value={
                    support?.hasGetUserMedia === undefined
                      ? t('settings:voice_input.diagnostics.unknown', { defaultValue: 'Unknown' })
                      : support.hasGetUserMedia
                        ? 'getUserMedia'
                        : t('settings:voice_input.diagnostics.missing', { defaultValue: 'Missing' })
                  }
                />
                <DiagnosticItem
                  label={t('settings:voice_input.diagnostics.recorder_backend', {
                    defaultValue: 'Recorder Backend',
                  })}
                  value={
                    support?.recorderMode === 'media-recorder'
                      ? 'MediaRecorder'
                      : support?.recorderMode === 'pcm-wav'
                        ? 'PCM/WAV fallback'
                        : t('settings:voice_input.diagnostics.unavailable', {
                            defaultValue: 'Unavailable',
                          })
                  }
                />
                <DiagnosticItem
                  label={t('settings:voice_input.diagnostics.secure_context', {
                    defaultValue: 'Secure Context',
                  })}
                  value={
                    support?.isSecureContext === undefined
                      ? t('settings:voice_input.diagnostics.unknown', { defaultValue: 'Unknown' })
                      : support.isSecureContext
                        ? t('settings:voice_input.diagnostics.available', { defaultValue: 'Available' })
                        : t('settings:voice_input.diagnostics.missing', { defaultValue: 'Missing' })
                  }
                />
              </div>
              <div className="flex items-center gap-2">
                <NotionButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void refreshSupport();
                  }}
                  disabled={saving || requestingAccess}
                >
                  <ArrowCounterClockwise size={14} />
                  {t('settings:voice_input.refresh_support', { defaultValue: 'Refresh Support' })}
                </NotionButton>
              </div>
              <p className="text-[11px] leading-5 text-muted-foreground/70">
                {t('settings:voice_input.runtime_hint', {
                  defaultValue:
                    'If recording support is unavailable, the app build is still missing platform microphone capability, the runtime is not exposing getUserMedia, or OS permission is blocked.',
                })}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function DiagnosticItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{label}</div>
      <div className="mt-0.5 text-xs text-foreground/80">{value}</div>
    </div>
  );
}

function translatePermissionFailure(
  t: ReturnType<typeof useTranslation>['t'],
  code: string
): string {
  const map: Record<string, string> = {
    'permission-denied': t('settings:voice_input.permission_request_denied', {
      defaultValue: 'Microphone access was denied. Allow it in the system dialog or OS settings.',
    }),
    'missing-get-user-media': t('settings:voice_input.permission_request_missing_runtime', {
      defaultValue: 'This runtime is not exposing getUserMedia, so microphone capture cannot start yet.',
    }),
    'microphone-not-found': t('settings:voice_input.permission_request_no_device', {
      defaultValue: 'No microphone was found. Connect or enable a microphone first.',
    }),
    'microphone-busy': t('settings:voice_input.permission_request_busy', {
      defaultValue: 'The microphone is busy in another app. Close the other app and try again.',
    }),
    'missing-recorder-backend': t('settings:voice_input.permission_request_missing_backend', {
      defaultValue:
        'Microphone access is granted, but this runtime still lacks a usable recording backend.',
    }),
    'insecure-context': t('settings:voice_input.permission_request_insecure_context', {
      defaultValue:
        'Microphone access is granted, but this runtime is not exposing a secure recording context yet.',
    }),
  };
  return (
    map[code] ??
    t('settings:voice_input.permission_request_failed', {
      defaultValue: 'Unable to activate microphone access in this environment.',
    })
  );
}

export default VoiceInputSettingsSection;
