import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Copy,
  Loader2,
  Mic2,
  RefreshCcw,
  Settings2,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { NotionButton } from '@/components/ui/NotionButton';
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

function StatusPill({
  support,
  t,
}: {
  support: VoiceRecordingSupport | null;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const label = useMemo(() => {
    if (!support) {
      return t('settings:voice_input.status.checking', { defaultValue: 'Checking microphone support…' });
    }
    if (support.canRecord) {
      return support.recorderMode === 'pcm-wav'
        ? t('settings:voice_input.status.ready_fallback', {
            defaultValue: 'Ready with PCM/WAV fallback',
          })
        : t('settings:voice_input.status.ready', { defaultValue: 'Ready to record' });
    }
    if (support.reasonCode === 'permission-denied') {
      return t('settings:voice_input.status.permission_denied', {
        defaultValue: 'Microphone permission denied',
      });
    }
    if (support.reasonCode === 'insecure-context') {
      return t('settings:voice_input.status.insecure_context', {
        defaultValue: 'Runtime is not exposing a secure recording context',
      });
    }
    if (support.reasonCode === 'missing-get-user-media') {
      return t('settings:voice_input.status.missing_get_user_media', {
        defaultValue: 'Runtime does not expose getUserMedia',
      });
    }
    return t('settings:voice_input.status.unavailable', {
      defaultValue: 'Recording backend unavailable',
    });
  }, [support, t]);

  const toneClass = !support
    ? 'border-border/60 bg-muted/40 text-muted-foreground'
    : support.canRecord
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300';

  return (
    <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${toneClass}`}>
      {label}
    </div>
  );
}

function AssignedModelCard({
  assignedModel,
  t,
}: {
  assignedModel: VoiceInputAssignedModel;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  if (assignedModel.status === 'ready') {
    return (
      <div className="py-2.5 px-1 hover:bg-muted/30 rounded transition-colors">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-300" />
          <div className="min-w-0">
            <h3 className="text-sm text-foreground/90 leading-tight">
              {assignedModel.modelLabel ?? assignedModel.model ?? t('settings:voice_input.not_configured', { defaultValue: 'Not configured' })}
            </h3>
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">
              {t('settings:voice_input.assigned_model_hint', {
                defaultValue: 'Model selection is managed in Settings > Models. This page only controls recording behavior and diagnostics.',
              })}
            </p>
            {assignedModel.providerLabel && (
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                {t('settings:voice_input.assigned_provider', { defaultValue: 'Provider' })}: {assignedModel.providerLabel}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const copyByStatus: Record<
    VoiceInputAssignedModel['status'],
    {
      title: string;
      description: string;
      icon: React.ReactNode;
    }
  > = {
    ready: {
      title: '',
      description: '',
      icon: null,
    },
    'model-assignment-required': {
      title: t('settings:voice_input.assignment_required_title', {
        defaultValue: 'Choose a voice input ASR model first',
      }),
      description: t('settings:voice_input.assignment_required_message', {
        defaultValue: 'Voice input is enabled at the app layer, but it still needs a model assignment in Settings > Models before recordings can be transcribed.',
      }),
      icon: <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-300" />,
    },
    'model-config-missing': {
      title: t('settings:voice_input.assignment_missing_title', {
        defaultValue: 'The assigned ASR model needs attention',
      }),
      description: t('settings:voice_input.assignment_missing_message', {
        defaultValue: 'The saved assignment no longer points to a valid voice-capable model. Reassign it in Settings > Models.',
      }),
      icon: <Wrench className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-300" />,
    },
    'model-disabled': {
      title: t('settings:voice_input.assignment_disabled_title', {
        defaultValue: 'The assigned ASR model is disabled',
      }),
      description: t('settings:voice_input.assignment_disabled_message', {
        defaultValue: 'Enable the assigned model or pick another ASR model in Settings > Models before using voice input.',
      }),
      icon: <Wrench className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-300" />,
    },
    'provider-unavailable': {
      title: t('settings:voice_input.assignment_provider_unavailable_title', {
        defaultValue: 'The assigned provider is not usable yet',
      }),
      description: t('settings:voice_input.assignment_provider_unavailable_message', {
        defaultValue: 'This runtime currently supports SiliconFlow transcription only. Pick a SiliconFlow ASR model for now, or keep the current assignment as a placeholder for future streaming providers.',
      }),
      icon: <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-300" />,
    },
  };

  const copy = copyByStatus[assignedModel.status];

  return (
    <div className="py-2.5 px-1 rounded bg-amber-500/5">
      <div className="flex items-start gap-2">
        {copy.icon}
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground leading-tight">{copy.title}</h3>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">{copy.description}</p>
          {(assignedModel.modelLabel || assignedModel.model) && (
            <p className="text-[11px] text-muted-foreground mt-1">
              {assignedModel.modelLabel ?? assignedModel.model}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ShortcutModeCard({
  active,
  disabled = false,
  icon,
  title,
  description,
  actionLabel,
  onSelect,
}: {
  active: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={[
        'w-full rounded px-1 py-2.5 text-left transition-colors',
        active
          ? 'bg-primary/10'
          : 'hover:bg-muted/30',
        disabled && 'cursor-not-allowed opacity-60',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className="mt-0.5 flex-shrink-0 text-muted-foreground">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="text-sm text-foreground/90 leading-tight">{title}</div>
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">{description}</p>
          </div>
        </div>
        <div
          className={[
            'flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium',
            active
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground',
          ].join(' ')}
        >
          {actionLabel}
        </div>
      </div>
    </button>
  );
}

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
    <div className="py-2.5 px-1 hover:bg-muted/30 rounded transition-colors">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] text-muted-foreground/70">
            {formatVoiceHistoryTime(entry.createdAt)}
            {entry.providerId ? ` · ${entry.providerId}` : ''}
            {entry.model ? ` · ${entry.model}` : ''}
            {typeof entry.durationMs === 'number' ? ` · ${Math.max(1, Math.round(entry.durationMs / 1000))}s` : ''}
          </div>
        </div>
        <NotionButton type="button" variant="ghost" size="sm" onClick={() => onCopy(entry)}>
          <Copy className="h-3.5 w-3.5" />
          {copyLabel}
        </NotionButton>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{entry.text}</p>
    </div>
  );
}

interface VoiceInputSettingsSectionProps {
  assignedModel: VoiceInputAssignedModel;
}

export function VoiceInputSettingsSection({
  assignedModel,
}: VoiceInputSettingsSectionProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [config, setConfig] = useState<VoiceInputConfig>(DEFAULT_VOICE_INPUT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [support, setSupport] = useState<VoiceRecordingSupport | null>(null);
  const [historyEntries, setHistoryEntries] = useState<VoiceInputHistoryEntry[]>([]);
  const [vocabularyDraft, setVocabularyDraft] = useState('');
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
        if (disposed) {
          return;
        }
        savedConfigRef.current = loadedConfig;
        setConfig(loadedConfig);
        setVocabularyDraft(serializeVocabularyDraft(loadedConfig.dictationVocabulary));
        setSupport(loadedSupport);
        setHistoryEntries(loadedHistory);
      } catch (error) {
        if (!disposed) {
          showGlobalNotification(
            'error',
            t('settings:voice_input.load_failed', {
              defaultValue: 'Failed to load voice input settings.',
            })
          );
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
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
      } catch (error) {
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

  const handlePersistVocabulary = useCallback((value: string) => {
    const nextConfig = {
      ...config,
      dictationVocabulary: parseVocabularyDraft(value),
    };
    setConfig(nextConfig);
    setVocabularyDraft(value);
    void persist(nextConfig);
  }, [config, persist]);

  const handleCopyHistoryEntry = useCallback(
    async (entry: VoiceInputHistoryEntry) => {
      try {
        await navigator.clipboard.writeText(entry.text);
        showGlobalNotification(
          'success',
          t('settings:voice_input.history_copy_success', {
            defaultValue: 'Dictation text copied.',
          })
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
        const copyByCode: Record<string, string> = {
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
            defaultValue: 'Microphone access is granted, but this runtime still lacks a usable recording backend.',
          }),
          'insecure-context': t('settings:voice_input.permission_request_insecure_context', {
            defaultValue: 'Microphone access is granted, but this runtime is not exposing a secure recording context yet.',
          }),
        };
        const reasonCode = nextSupport.reasonCode ?? 'recording-unavailable';
        showGlobalNotification(
          reasonCode === 'permission-denied' || reasonCode === 'microphone-not-found' || reasonCode === 'microphone-busy'
            ? 'warning'
            : 'error',
          copyByCode[reasonCode] ??
            t('settings:voice_input.permission_request_failed', {
              defaultValue: 'Unable to activate microphone access in this environment.',
            })
        );
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'recording-unavailable';
      const copyByCode: Record<string, string> = {
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
          defaultValue: 'Microphone access is granted, but this runtime still lacks a usable recording backend.',
        }),
        'insecure-context': t('settings:voice_input.permission_request_insecure_context', {
          defaultValue: 'Microphone access is granted, but this runtime is not exposing a secure recording context yet.',
        }),
      };
      showGlobalNotification(
        code === 'permission-denied' || code === 'microphone-not-found' || code === 'microphone-busy'
          ? 'warning'
          : 'error',
        copyByCode[code] ??
          t('settings:voice_input.permission_request_failed', {
            defaultValue: 'Unable to activate microphone access in this environment.',
          })
      );
      await refreshSupport();
    } finally {
      setRequestingAccess(false);
    }
  }, [refreshSupport, t]);

  if (loading) {
    return (
      <section className="mt-8">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
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

  return (
    <section className="mt-8">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-foreground">
            {t('settings:voice_input.title', { defaultValue: 'Voice Input' })}
          </h3>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            {t('settings:voice_input.description', {
              defaultValue:
                'Recording controls live here. ASR model assignment belongs to Settings > Models, provider credentials belong to Settings > APIs, and usage is tracked in Statistics.',
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill support={support} t={t} />
          <NotionButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void requestMicrophoneAccess();
            }}
            disabled={saving || requestingAccess}
          >
            {requestingAccess ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {t('settings:voice_input.request_access', {
              defaultValue: 'Request microphone access',
            })}
          </NotionButton>
          <NotionButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void refreshSupport();
            }}
            disabled={saving || requestingAccess}
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            {t('settings:voice_input.refresh_support', { defaultValue: 'Refresh Support' })}
          </NotionButton>
        </div>
      </div>

      <div className="space-y-px">
        <AssignedModelCard assignedModel={assignedModel} t={t} />

        {/* 听写快捷键 */}
        <div className="mt-6">
          <div className="px-1 mb-2">
            <h3 className="text-sm text-foreground/90 leading-tight">
              {t('settings:voice_input.shortcut_title', {
                defaultValue: 'Dictation Shortcut',
              })}
            </h3>
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">
              {t('settings:voice_input.shortcut_description', {
                defaultValue:
                  'Choose how the app-wide shortcut behaves inside DeepStudent. Dictation still inserts at the active supported text cursor and never auto-sends.',
              })}
            </p>
          </div>

          <div className="space-y-px">
            <ShortcutModeCard
              active={activeHotkeyMode === 'hold-to-talk'}
              disabled={saving}
              icon={<Mic2 className="h-4 w-4" />}
              title={t('settings:voice_input.hold_mode_title', {
                defaultValue: 'Press and hold the dictation shortcut',
              })}
              description={t('settings:voice_input.hold_mode_description', {
                defaultValue:
                  'Hold the shortcut anywhere inside DeepStudent to dictate into the current supported input, then release to stop.',
              })}
              actionLabel={
                activeHotkeyMode === 'hold-to-talk'
                  ? t('settings:voice_input.mode_active', { defaultValue: 'Active' })
                  : t('settings:voice_input.mode_select', { defaultValue: 'Use This Mode' })
              }
              onSelect={() => handleSelectHotkeyMode('hold-to-talk')}
            />
            <ShortcutModeCard
              active={activeHotkeyMode === 'toggle-to-record'}
              disabled={saving}
              icon={<RefreshCcw className="h-4 w-4" />}
              title={t('settings:voice_input.toggle_mode_title', {
                defaultValue: 'Tap once to start, tap once to stop',
              })}
              description={t('settings:voice_input.toggle_mode_description', {
                defaultValue:
                  'Use the same shortcut as a toggle when you want hands-free dictation inside DeepStudent.',
              })}
              actionLabel={
                activeHotkeyMode === 'toggle-to-record'
                  ? t('settings:voice_input.mode_active', { defaultValue: 'Active' })
                  : t('settings:voice_input.mode_select', { defaultValue: 'Use This Mode' })
              }
              onSelect={() => handleSelectHotkeyMode('toggle-to-record')}
            />
          </div>

          <div className="mt-3 grid gap-4 md:grid-cols-2 px-1">
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t('settings:voice_input.hotkey', { defaultValue: 'Hotkey' })}
              </span>
              <Input
                disabled={saving}
                value={config.hotkey}
                onChange={(event) => {
                  setConfig((current) => ({ ...current, hotkey: event.target.value }));
                }}
                onBlur={(event) => {
                  const nextConfig = {
                    ...config,
                    hotkey: event.currentTarget.value,
                  };
                  setConfig(nextConfig);
                  void persist(nextConfig);
                }}
              />
            </label>

            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t('settings:voice_input.max_duration_ms', { defaultValue: 'Max Duration (ms)' })}
              </span>
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
              />
            </label>
          </div>
        </div>

        {/* 设置与恢复 */}
        <div className="mt-6">
          <div className="px-1 mb-2">
            <h3 className="text-sm text-foreground/90 leading-tight">
              {t('settings:voice_input.quick_actions_title', {
                defaultValue: 'Setup & Recovery',
              })}
            </h3>
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">
              {t('settings:voice_input.quick_actions_description', {
                defaultValue:
                  'Jump straight to model assignment, provider credentials, and usage analytics when dictation needs attention.',
              })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 px-1">
            <NotionButton type="button" variant="ghost" size="sm" onClick={() => openSettingsTab('models')}>
              <Settings2 className="h-3.5 w-3.5" />
              {t('settings:voice_input.open_model_settings', {
                defaultValue: 'Open Model Assignments',
              })}
            </NotionButton>
            <NotionButton type="button" variant="ghost" size="sm" onClick={() => openSettingsTab('apis')}>
              <Wrench className="h-3.5 w-3.5" />
              {t('settings:voice_input.open_api_settings', {
                defaultValue: 'Open API Settings',
              })}
            </NotionButton>
            <NotionButton type="button" variant="ghost" size="sm" onClick={() => openSettingsTab('statistics')}>
              <BarChart3 className="h-3.5 w-3.5" />
              {t('settings:voice_input.open_usage_statistics', {
                defaultValue: 'Open Usage Statistics',
              })}
            </NotionButton>
          </div>
        </div>

        {/* 听写词典 */}
        <div className="mt-6">
          <div className="px-1 mb-2">
            <h3 className="text-sm text-foreground/90 leading-tight">
              {t('settings:voice_input.dictionary_title', {
                defaultValue: 'Dictation Vocabulary',
              })}
            </h3>
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">
              {t('settings:voice_input.dictionary_description', {
                defaultValue:
                  'Add words or short phrases that dictation should prefer to recognize. Use one item per line.',
              })}
            </p>
          </div>
          <div className="px-1 space-y-2">
            <Textarea
              disabled={saving}
              value={vocabularyDraft}
              onChange={(event) => setVocabularyDraft(event.target.value)}
              onBlur={(event) => handlePersistVocabulary(event.currentTarget.value)}
              rows={5}
              placeholder={t('settings:voice_input.dictionary_placeholder', {
                defaultValue: 'Photosynthesis\nAnkylosing spondylitis\nDeepStudent',
              })}
            />
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground/70">
              <span>
                {t('settings:voice_input.dictionary_count', {
                  defaultValue: '{{count}} phrase hints',
                  count: vocabularyCount,
                })}
              </span>
              <span>
                {t('settings:voice_input.dictionary_hint', {
                  defaultValue: 'These hints are merged into the ASR prompt when supported.',
                })}
              </span>
            </div>
          </div>
        </div>

        {/* 最近的听写记录 */}
        <div className="mt-6">
          <div className="px-1 mb-2 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm text-foreground/90 leading-tight">
                {t('settings:voice_input.history_title', {
                  defaultValue: 'Recent Dictation History',
                })}
              </h3>
              <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5">
                {t('settings:voice_input.history_description', {
                  defaultValue:
                    'Recent transcripts stay here so you can recover them if the text lands in the wrong place or focus changes unexpectedly.',
                })}
              </p>
            </div>
            {historyEntries.length > 0 && (
              <NotionButton type="button" variant="ghost" size="sm" onClick={() => void handleClearHistory()}>
                <Trash2 className="h-3.5 w-3.5" />
                {t('settings:voice_input.history_clear', {
                  defaultValue: 'Clear',
                })}
              </NotionButton>
            )}
          </div>

          <div className="space-y-px">
            {historyEntries.length === 0 ? (
              <div className="px-1 py-3 text-[11px] text-muted-foreground/70">
                {t('settings:voice_input.history_empty', {
                  defaultValue: 'Your recent dictation transcripts will appear here.',
                })}
              </div>
            ) : (
              historyEntries.map((entry) => (
                <HistoryEntryCard
                  key={entry.id}
                  entry={entry}
                  onCopy={handleCopyHistoryEntry}
                  copyLabel={t('settings:voice_input.history_copy', {
                    defaultValue: 'Copy',
                  })}
                />
              ))
            )}
          </div>
        </div>

        {/* 诊断信息 */}
        <div className="mt-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-4 px-1">
          <div className="py-2">
            <div className="text-[11px] text-muted-foreground/70">
              {t('settings:voice_input.diagnostics.permission', { defaultValue: 'Permission' })}
            </div>
            <div className="mt-0.5 text-sm text-foreground">
              {support?.permissionState
                ? t(`settings:voice_input.permission_states.${support.permissionState}`, {
                    defaultValue: support.permissionState,
                  })
                : t('settings:voice_input.permission_states.unknown', { defaultValue: 'unknown' })}
            </div>
          </div>
          <div className="py-2">
            <div className="text-[11px] text-muted-foreground/70">
              {t('settings:voice_input.diagnostics.capture_api', { defaultValue: 'Capture API' })}
            </div>
            <div className="mt-0.5 text-sm text-foreground">
              {support?.hasGetUserMedia === undefined
                ? t('settings:voice_input.diagnostics.unknown', { defaultValue: 'Unknown' })
                : support.hasGetUserMedia
                ? 'getUserMedia'
                : t('settings:voice_input.diagnostics.missing', { defaultValue: 'Missing' })}
            </div>
          </div>
          <div className="py-2">
            <div className="text-[11px] text-muted-foreground/70">
              {t('settings:voice_input.diagnostics.recorder_backend', { defaultValue: 'Recorder Backend' })}
            </div>
            <div className="mt-0.5 text-sm text-foreground">
              {support?.recorderMode === 'media-recorder'
                ? 'MediaRecorder'
                : support?.recorderMode === 'pcm-wav'
                ? 'PCM/WAV fallback'
                : t('settings:voice_input.diagnostics.unavailable', { defaultValue: 'Unavailable' })}
            </div>
          </div>
          <div className="py-2">
            <div className="text-[11px] text-muted-foreground/70">
              {t('settings:voice_input.diagnostics.secure_context', { defaultValue: 'Secure Context' })}
            </div>
            <div className="mt-0.5 text-sm text-foreground">
              {support?.isSecureContext === undefined
                ? t('settings:voice_input.diagnostics.unknown', { defaultValue: 'Unknown' })
                : support.isSecureContext
                ? t('settings:voice_input.diagnostics.available', { defaultValue: 'Available' })
                : t('settings:voice_input.diagnostics.missing', { defaultValue: 'Missing' })}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 px-1 text-[11px] leading-5 text-muted-foreground/70">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <div>
            {t('settings:voice_input.runtime_hint', {
              defaultValue:
                'If recording support is unavailable, the app build is still missing platform microphone capability, the runtime is not exposing getUserMedia, or OS permission is blocked.',
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

export default VoiceInputSettingsSection;
