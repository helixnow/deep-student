import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Loader2,
  RefreshCcw,
  Settings2,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  DEFAULT_VOICE_INPUT_CONFIG,
  loadVoiceInputConfig,
  saveVoiceInputConfig,
} from '@/voice-input/config';
import type { VoiceInputAssignedModel, VoiceInputConfig } from '@/voice-input/types';
import {
  detectVoiceRecordingSupport,
  requestVoiceRecordingPermission,
  type VoiceRecordingSupport,
} from '@/voice-input/support';

type SettingsTabId = 'apis' | 'models' | 'statistics';

function openSettingsTab(tab: SettingsTabId): void {
  window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab } }));
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
  const metaRows = [
    assignedModel.providerLabel
      ? {
          label: t('settings:voice_input.assigned_provider', { defaultValue: 'Provider' }),
          value: assignedModel.providerLabel,
        }
      : null,
    assignedModel.model
      ? {
          label: t('settings:voice_input.assigned_model_id', { defaultValue: 'Model ID' }),
          value: assignedModel.model,
        }
      : null,
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  if (assignedModel.status === 'ready') {
    return (
      <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-300" />
          <div className="min-w-0 space-y-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-700/80 dark:text-emerald-300/80">
                {t('settings:voice_input.assigned_model', { defaultValue: 'Assigned ASR Model' })}
              </div>
              <div className="mt-1 text-sm font-semibold text-foreground">
                {assignedModel.modelLabel ?? assignedModel.model ?? t('settings:voice_input.not_configured', { defaultValue: 'Not configured' })}
              </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t('settings:voice_input.assigned_model_hint', {
                defaultValue: 'Model selection is managed in Settings > Models. This page only controls recording behavior and diagnostics.',
              })}
            </p>
            {metaRows.length > 0 && (
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                {metaRows.map((row) => (
                  <div key={row.label} className="rounded-xl border border-border/50 bg-background/70 px-3 py-2">
                    <div className="mb-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
                      {row.label}
                    </div>
                    <div className="break-all text-foreground">{row.value}</div>
                  </div>
                ))}
              </div>
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
      toneClass: string;
      icon: React.ReactNode;
    }
  > = {
    ready: {
      title: '',
      description: '',
      toneClass: '',
      icon: null,
    },
    'model-assignment-required': {
      title: t('settings:voice_input.assignment_required_title', {
        defaultValue: 'Choose a voice input ASR model first',
      }),
      description: t('settings:voice_input.assignment_required_message', {
        defaultValue: 'Voice input is enabled at the app layer, but it still needs a model assignment in Settings > Models before recordings can be transcribed.',
      }),
      toneClass: 'border-amber-500/20 bg-amber-500/5 text-amber-900 dark:text-amber-100',
      icon: <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-300" />,
    },
    'model-config-missing': {
      title: t('settings:voice_input.assignment_missing_title', {
        defaultValue: 'The assigned ASR model needs attention',
      }),
      description: t('settings:voice_input.assignment_missing_message', {
        defaultValue: 'The saved assignment no longer points to a valid voice-capable model. Reassign it in Settings > Models.',
      }),
      toneClass: 'border-amber-500/20 bg-amber-500/5 text-amber-900 dark:text-amber-100',
      icon: <Wrench className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-300" />,
    },
    'model-disabled': {
      title: t('settings:voice_input.assignment_disabled_title', {
        defaultValue: 'The assigned ASR model is disabled',
      }),
      description: t('settings:voice_input.assignment_disabled_message', {
        defaultValue: 'Enable the assigned model or pick another ASR model in Settings > Models before using voice input.',
      }),
      toneClass: 'border-amber-500/20 bg-amber-500/5 text-amber-900 dark:text-amber-100',
      icon: <Wrench className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-300" />,
    },
    'provider-unavailable': {
      title: t('settings:voice_input.assignment_provider_unavailable_title', {
        defaultValue: 'The assigned provider is not usable yet',
      }),
      description: t('settings:voice_input.assignment_provider_unavailable_message', {
        defaultValue: 'This runtime currently supports SiliconFlow transcription only. Pick a SiliconFlow ASR model for now, or keep the current assignment as a placeholder for future streaming providers.',
      }),
      toneClass: 'border-amber-500/20 bg-amber-500/5 text-amber-900 dark:text-amber-100',
      icon: <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-300" />,
    },
  };

  const copy = copyByStatus[assignedModel.status];

  return (
    <div className={`rounded-2xl border p-4 ${copy.toneClass}`}>
      <div className="flex items-start gap-3">
        {copy.icon}
        <div className="min-w-0 space-y-2">
          <div className="text-sm font-semibold">{copy.title}</div>
          <p className="text-xs leading-5 text-current/80">{copy.description}</p>
          {(assignedModel.modelLabel || assignedModel.model) && (
            <div className="rounded-xl border border-current/10 bg-background/60 px-3 py-2 text-xs text-foreground">
              {assignedModel.modelLabel ?? assignedModel.model}
            </div>
          )}
        </div>
      </div>
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

  const refreshSupport = useCallback(async () => {
    const nextSupport = await detectVoiceRecordingSupport();
    setSupport(nextSupport);
  }, []);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        const [loadedConfig, loadedSupport] = await Promise.all([
          loadVoiceInputConfig(),
          detectVoiceRecordingSupport(),
        ]);
        if (disposed) {
          return;
        }
        setConfig(loadedConfig);
        setSupport(loadedSupport);
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

  const persist = useCallback(
    async (patch: Partial<VoiceInputConfig>) => {
      setSaving(true);
      try {
        const nextConfig = await saveVoiceInputConfig({ ...config, ...patch });
        setConfig(nextConfig);
      } catch (error) {
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
    [config, t]
  );

  const requestMicrophoneAccess = useCallback(async () => {
    setRequestingAccess(true);
    try {
      const nextSupport = await requestVoiceRecordingPermission();
      setSupport(nextSupport);
      showGlobalNotification(
        'success',
        t('settings:voice_input.permission_request_success', {
          defaultValue: 'Microphone access is ready. You can start voice input now.',
        })
      );
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
      <section className="study-shell-secondary-card overflow-hidden p-4 sm:p-5">
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

  return (
    <section className="study-shell-secondary-card overflow-hidden p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            {t('settings:voice_input.title', { defaultValue: 'Voice Input' })}
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
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

      <div className="space-y-4">
        <AssignedModelCard assignedModel={assignedModel} t={t} />

        <div className="flex flex-wrap gap-2">
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

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t('settings:voice_input.hotkey', { defaultValue: 'Hotkey' })}
            </span>
            <Input
              value={config.hotkey}
              onChange={(event) => {
                setConfig((current) => ({ ...current, hotkey: event.target.value }));
              }}
              onBlur={() => {
                void persist({ hotkey: config.hotkey });
              }}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t('settings:voice_input.max_duration_ms', { defaultValue: 'Max Duration (ms)' })}
            </span>
            <Input
              type="number"
              inputMode="numeric"
              value={String(config.maxDurationMs)}
              onChange={(event) => {
                setConfig((current) => ({
                  ...current,
                  maxDurationMs: Number(event.target.value || DEFAULT_VOICE_INPUT_CONFIG.maxDurationMs),
                }));
              }}
              onBlur={() => {
                void persist({ maxDurationMs: config.maxDurationMs });
              }}
            />
          </label>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-border/60 bg-background/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
              {t('settings:voice_input.diagnostics.permission', { defaultValue: 'Permission' })}
            </div>
            <div className="mt-1 text-sm text-foreground">
              {support?.permissionState
                ? t(`settings:voice_input.permission_states.${support.permissionState}`, {
                    defaultValue: support.permissionState,
                  })
                : t('settings:voice_input.permission_states.unknown', { defaultValue: 'unknown' })}
            </div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-background/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
              {t('settings:voice_input.diagnostics.capture_api', { defaultValue: 'Capture API' })}
            </div>
            <div className="mt-1 text-sm text-foreground">
              {support?.hasGetUserMedia === undefined
                ? t('settings:voice_input.diagnostics.unknown', { defaultValue: 'Unknown' })
                : support.hasGetUserMedia
                ? 'getUserMedia'
                : t('settings:voice_input.diagnostics.missing', { defaultValue: 'Missing' })}
            </div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-background/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
              {t('settings:voice_input.diagnostics.recorder_backend', { defaultValue: 'Recorder Backend' })}
            </div>
            <div className="mt-1 text-sm text-foreground">
              {support?.recorderMode === 'media-recorder'
                ? 'MediaRecorder'
                : support?.recorderMode === 'pcm-wav'
                ? 'PCM/WAV fallback'
                : t('settings:voice_input.diagnostics.unavailable', { defaultValue: 'Unavailable' })}
            </div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-background/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
              {t('settings:voice_input.diagnostics.secure_context', { defaultValue: 'Secure Context' })}
            </div>
            <div className="mt-1 text-sm text-foreground">
              {support?.isSecureContext === undefined
                ? t('settings:voice_input.diagnostics.unknown', { defaultValue: 'Unknown' })
                : support.isSecureContext
                ? t('settings:voice_input.diagnostics.available', { defaultValue: 'Available' })
                : t('settings:voice_input.diagnostics.missing', { defaultValue: 'Missing' })}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-border/60 bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80" />
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
