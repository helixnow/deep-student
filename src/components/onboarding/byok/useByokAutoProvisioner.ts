import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ByokProbeError, probeByokEndpoint } from './endpointProber';
import { detectByokProvider } from './keyDetector';
import { provisionByokSlots } from './slotProvisioner';
import type {
  ByokAutoProvisionSummary,
  ByokErrorInfo,
  ByokPresetId,
  ByokProvisionerState,
  KeyDetectionResult,
} from './types';
import { provisionByokVectorProfile } from './vectorProfileProvisioner';

export interface UseByokAutoProvisionerOptions {
  fetcher?: typeof fetch;
  /** Display context: 'onboarding' hides raw HTTP status codes from first-time learners */
  mode?: 'onboarding' | 'settings';
  /** Auto-trigger probing 250ms after pasting a plausible unambiguous key */
  autoProbeOnPaste?: boolean;
  debounceMs?: number;
  onProvisioned?: (summary: ByokAutoProvisionSummary) => void;
}

export interface UseByokAutoProvisionerReturn {
  state: ByokProvisionerState;
  rawApiKey: string;
  customBaseUrl: string;
  selectedPresetId: ByokPresetId | null;
  detection: KeyDetectionResult;
  summary: ByokAutoProvisionSummary | null;
  error: ByokErrorInfo | null;
  isBusy: boolean;
  setRawApiKey: (nextKey: string) => void;
  handlePasteApiKey: (pastedText: string) => void;
  setCustomBaseUrl: (nextUrl: string) => void;
  setSelectedPresetId: (presetId: ByokPresetId | null) => void;
  submitProvision: (overrideKey?: string) => Promise<ByokAutoProvisionSummary | null>;
  reset: () => void;
}

const DEFAULT_DEBOUNCE_MS = 250;

export function useByokAutoProvisioner(
  options: UseByokAutoProvisionerOptions = {},
): UseByokAutoProvisionerReturn {
  const { i18n } = useTranslation(['settings', 'common']);
  const isZh = (i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN').toLowerCase().startsWith('zh');
  const {
    fetcher,
    mode = 'settings',
    autoProbeOnPaste = false,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    onProvisioned,
  } = options;

  const [state, setState] = useState<ByokProvisionerState>('idle');
  const [rawApiKey, setRawApiKeyState] = useState('');
  const [customBaseUrl, setCustomBaseUrlState] = useState('');
  const [selectedPresetId, setSelectedPresetIdState] = useState<ByokPresetId | null>(null);
  const [summary, setSummary] = useState<ByokAutoProvisionSummary | null>(null);
  const [error, setError] = useState<ByokErrorInfo | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onProvisionedRef = useRef(onProvisioned);
  onProvisionedRef.current = onProvisioned;

  const clearPasteTimer = useCallback(() => {
    if (pasteTimerRef.current) {
      clearTimeout(pasteTimerRef.current);
      pasteTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearPasteTimer();
      abortRef.current?.abort();
    };
  }, [clearPasteTimer]);

  const detection = useMemo(
    () =>
      detectByokProvider({
        rawApiKey,
        customBaseUrl,
        selectedPresetId,
      }),
    [rawApiKey, customBaseUrl, selectedPresetId],
  );

  const formatProbeError = useCallback(
    (err: unknown): ByokErrorInfo => {
      if (err instanceof ByokProbeError) {
        if (err.code === 'empty_key') {
          return {
            code: 'empty_key',
            message: isZh
              ? '请先粘贴有效的 API 密钥。'
              : 'Please paste a valid API key first.',
          };
        }
        if (err.code === 'auth_failed') {
          const status = err.httpStatus ?? 401;
          return {
            code: 'auth_failed',
            httpStatus: status,
            message:
              mode === 'onboarding'
                ? isZh
                  ? '密钥验证未通过，请确认 API 密钥是否正确、余额是否充足，或检查自定义服务地址。'
                  : 'Could not verify this API key. Please check that the key is correct, has available credit, or verify the custom server address.'
                : isZh
                  ? `密钥校验未通过（HTTP ${status}），请检查 API 密钥或自定义服务地址。`
                  : `Authentication failed (HTTP ${status}). Check your API key or custom server address.`,
          };
        }
        if (err.code === 'no_models') {
          return {
            code: 'no_models',
            message: isZh
              ? '连接成功，但当前账号下暂无可用的对话模型，请检查账号权限或在设置中手动添加。'
              : 'Connected, but no chat models are available on this account. Please check permissions or add a model in Settings.',
          };
        }
        if (err.code === 'network_timeout') {
          return {
            code: 'network_timeout',
            message: isZh
              ? '连接服务商超时，请检查网络或填写自定义服务地址后重试。'
              : 'Connection timed out. Please check your network or enter a custom server address and try again.',
          };
        }
      }

      return {
        code: 'probe_failed',
        message: isZh
          ? '暂时无法连接或保存配置，请检查网络与密钥后重试。'
          : 'Could not connect or save settings right now. Please check your connection and key, then try again.',
      };
    },
    [isZh, mode],
  );

  const submitProvision = useCallback(
    async (overrideKey?: string): Promise<ByokAutoProvisionSummary | null> => {
      clearPasteTimer();
      abortRef.current?.abort();

      const activeDetection =
        overrideKey !== undefined
          ? detectByokProvider({
              rawApiKey: overrideKey,
              customBaseUrl,
              selectedPresetId,
            })
          : detection;

      if (!activeDetection.sanitizedApiKey) {
        const emptyErr = formatProbeError(new ByokProbeError('empty_key', 'Empty key'));
        setError(emptyErr);
        setState('error');
        return null;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setSummary(null);
      setState('probing');

      try {
        const probeResult = await probeByokEndpoint(activeDetection, {
          fetcher,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return null;

        setState('provisioning');

        const slotResult = await provisionByokSlots(
          probeResult,
          activeDetection.sanitizedApiKey,
        );
        if (controller.signal.aborted) return null;

        const vectorResult = await provisionByokVectorProfile({
          embeddingResult: probeResult.embeddingResult,
          embeddingConfigId: slotResult.embeddingConfigId,
        });
        if (controller.signal.aborted) return null;

        const totalDiscoveredCount =
          probeResult.chatModels.length +
          probeResult.embeddingCandidates.length +
          probeResult.rerankCandidates.length;

        const finalSummary: ByokAutoProvisionSummary = {
          status: vectorResult.status,
          preset: probeResult.resolvedPreset,
          baseUrl: probeResult.resolvedBaseUrl,
          probedModelCount: totalDiscoveredCount,
          enabledModelCount: slotResult.enabledModelProfiles.length,
          assignedSlotCount: slotResult.assignedSlotCount,
          slots: slotResult.slots,
          dimension: vectorResult.dimension,
          keptExistingDefaultDimension: vectorResult.keptExistingDefaultDimension,
          latencyMs: probeResult.latencyMs,
        };

        setSummary(finalSummary);
        setState(vectorResult.status);
        onProvisionedRef.current?.(finalSummary);
        return finalSummary;
      } catch (err) {
        if (controller.signal.aborted) return null;
        const formatted = formatProbeError(err);
        setError(formatted);
        setState('error');
        return null;
      }
    },
    [clearPasteTimer, customBaseUrl, detection, fetcher, formatProbeError, selectedPresetId],
  );

  const setRawApiKey = useCallback(
    (nextKey: string) => {
      clearPasteTimer();
      abortRef.current?.abort();
      setSummary(null);
      setRawApiKeyState(nextKey);
      setError(null);
      if (!nextKey.trim()) {
        setSummary(null);
        setState('idle');
      } else {
        setState('detecting');
      }
    },
    [clearPasteTimer],
  );

  const handlePasteApiKey = useCallback(
    (pastedText: string) => {
      clearPasteTimer();
      abortRef.current?.abort();
      setSummary(null);
      setRawApiKeyState(pastedText);
      setError(null);

      const nextDetection = detectByokProvider({
        rawApiKey: pastedText,
        customBaseUrl,
        selectedPresetId,
      });

      if (!nextDetection.sanitizedApiKey) {
        setState('idle');
        return;
      }

      setState('detecting');

      if (
        autoProbeOnPaste &&
        nextDetection.sanitizedApiKey.length >= 20 &&
        !nextDetection.isAmbiguous
      ) {
        pasteTimerRef.current = setTimeout(() => {
          pasteTimerRef.current = null;
          void submitProvision(pastedText);
        }, debounceMs);
      }
    },
    [autoProbeOnPaste, clearPasteTimer, customBaseUrl, debounceMs, selectedPresetId, submitProvision],
  );

  const setCustomBaseUrl = useCallback(
    (nextUrl: string) => {
      clearPasteTimer();
      abortRef.current?.abort();
      setSummary(null);
      setCustomBaseUrlState(nextUrl);
      setError(null);
      if (rawApiKey.trim()) {
        setState('detecting');
      }
    },
    [clearPasteTimer, rawApiKey],
  );

  const setSelectedPresetId = useCallback(
    (presetId: ByokPresetId | null) => {
      clearPasteTimer();
      abortRef.current?.abort();
      setSummary(null);
      setSelectedPresetIdState(presetId);
      setError(null);
      if (rawApiKey.trim()) {
        setState('detecting');
      }
    },
    [clearPasteTimer, rawApiKey],
  );

  const reset = useCallback(() => {
    clearPasteTimer();
    abortRef.current?.abort();
    setRawApiKeyState('');
    setCustomBaseUrlState('');
    setSelectedPresetIdState(null);
    setSummary(null);
    setError(null);
    setState('idle');
  }, [clearPasteTimer]);

  const isBusy = state === 'probing' || state === 'provisioning';

  return {
    state,
    rawApiKey,
    customBaseUrl,
    selectedPresetId,
    detection,
    summary,
    error,
    isBusy,
    setRawApiKey,
    handlePasteApiKey,
    setCustomBaseUrl,
    setSelectedPresetId,
    submitProvision,
    reset,
  };
}
