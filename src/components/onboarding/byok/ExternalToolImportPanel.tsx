import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  CircleNotch,
  ClipboardText,
  FolderOpen,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsButton } from '@/components/ui/DsButton';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Alert, AlertDescription } from '@/components/ui/shad/Alert';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Input } from '@/components/ui/shad/Input';
import { Switch } from '@/components/ui/shad/Switch';
import { Textarea } from '@/components/ui/shad/Textarea';
import { TECHNICAL_INPUT_PROPS } from '@/components/ui/shad/technicalInputProps';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  importExternalLlmConfigs,
  looksLikeStructuredExternalConfig,
  pickExternalConfigSource,
  probeExternalCandidateModels,
  scanExternalLlmConfigs,
  type ExternalCandidateModelDto,
  type ExternalLlmImportResult,
  type ExternalLlmScanReport,
  type ExternalVendorCandidateDto,
} from './externalImportApi';

export interface ExternalToolImportPanelProps {
  /** 可选预填文本（例如用户在密钥输入框直接粘贴了 ccswitch:// 链接或 .env） */
  initialTextInput?: string;
  /** 每次递增加 1 时强制重新触发扫描或解析 initialTextInput */
  triggerSeq?: number;
  /** 点击取消或收起时的回调（内联模式下可选） */
  onCancel?: () => void;
  /** 导入成功回调 */
  onImported?: (result: ExternalLlmImportResult) => void;
  className?: string;
}

type ImportModeTab = 'scan' | 'paste';

function formatContextTokens(tokens: number | null): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${m}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

function resolveCandidateIconHint(cand: ExternalVendorCandidateDto): string {
  if (cand.matchedVendorId) return cand.matchedVendorId;
  if (cand.providerType && cand.providerType !== 'anthropic' && cand.providerType !== 'custom') {
    return cand.providerType;
  }
  const lowerName = cand.name.toLowerCase();
  if (
    lowerName.includes('deepseek') ||
    lowerName.includes('zhipu') ||
    lowerName.includes('glm') ||
    lowerName.includes('moonshot') ||
    lowerName.includes('kimi') ||
    lowerName.includes('minimax') ||
    lowerName.includes('qwen') ||
    lowerName.includes('silicon') ||
    lowerName.includes('doubao') ||
    lowerName.includes('gemini')
  ) {
    return cand.name;
  }
  return cand.models[0]?.id || cand.providerType || cand.name;
}

function sourceDisplayName(
  source: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (source) {
    case 'magpie':
      return t('settings:external_import.sources.magpie');
    case 'cc-switch':
      return t('settings:external_import.sources.cc_switch');
    case 'opencode':
      return t('settings:external_import.sources.opencode');
    case 'claude-code':
      return t('settings:external_import.sources.claude_code');
    case 'codex':
      return t('settings:external_import.sources.codex');
    case 'paste':
      return t('settings:external_import.sources.paste');
    default:
      return t('settings:external_import.sources.file');
  }
}

function protocolShortLabel(
  protocol: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  switch (protocol) {
    case 'openai_responses':
      return t('settings:external_import.protocols.openai_responses');
    case 'anthropic_messages':
      return t('settings:external_import.protocols.anthropic_messages');
    case 'google_generate_content':
      return t('settings:external_import.protocols.google_generate_content');
    default:
      return t('settings:external_import.protocols.openai_chat_completions');
  }
}

function syncStatusMeta(
  status: ExternalVendorCandidateDto['syncStatus'],
  t: (key: string) => string,
): { textClass: string; label: string } {
  switch (status) {
    case 'new':
      return {
        textClass: 'text-success',
        label: t('settings:external_import.status.new'),
      };
    case 'match_builtin':
      return {
        textClass: 'text-info',
        label: t('settings:external_import.status.match_builtin'),
      };
    case 'update':
      return {
        textClass: 'text-warning',
        label: t('settings:external_import.status.update'),
      };
    case 'synced':
      return {
        textClass: 'text-muted-foreground',
        label: t('settings:external_import.status.synced'),
      };
  }
}

export const ExternalToolImportPanel: React.FC<ExternalToolImportPanelProps> = ({
  initialTextInput = '',
  triggerSeq = 0,
  onCancel,
  onImported,
  className,
}) => {
  const { t } = useTranslation(['settings', 'common']);

  const [activeTab, setActiveTab] = useState<ImportModeTab>(() =>
    initialTextInput.trim() ? 'paste' : 'scan',
  );
  const [pasteText, setPasteText] = useState(initialTextInput);
  const [lastParsedPasteText, setLastParsedPasteText] = useState('');
  const [pickedFilePathLabel, setPickedFilePathLabel] = useState<string | null>(null);
  const [report, setReport] = useState<ExternalLlmScanReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [probingByCandidate, setProbingByCandidate] = useState<Record<string, boolean>>({});
  const [probeErrorByCandidate, setProbeErrorByCandidate] = useState<Record<string, string>>({});
  const [modelSearchByVendor, setModelSearchByVendor] = useState<Record<string, string>>({});
  const [scanError, setScanError] = useState<string | null>(null);

  const [selectedVendors, setSelectedVendors] = useState<Record<string, boolean>>({});
  const [selectedModelsByVendor, setSelectedModelsByVendor] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [expandedVendors, setExpandedVendors] = useState<Record<string, boolean>>({});
  const [autoAssignEmptySlots, setAutoAssignEmptySlots] = useState(true);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearDebounceTimer, [clearDebounceTimer]);

  const hydrateSelectionsFromReport = useCallback((nextReport: ExternalLlmScanReport) => {
    const nextVendorChecked: Record<string, boolean> = {};
    const nextModelsChecked: Record<string, Record<string, boolean>> = {};
    const nextExpanded: Record<string, boolean> = {};

    for (const cand of nextReport.candidates) {
      nextVendorChecked[cand.candidateId] = cand.syncStatus !== 'synced';
      const modelMap: Record<string, boolean> = {};
      for (const m of cand.models) {
        modelMap[m.id] = m.recommended || cand.models.length <= 5;
      }
      nextModelsChecked[cand.candidateId] = modelMap;
      nextExpanded[cand.candidateId] = cand.models.length > 0 && cand.models.length <= 6;
    }

    if (
      nextReport.candidates.length === 1 &&
      nextReport.candidates[0]?.syncStatus === 'synced' &&
      nextReport.sources[0]?.source === 'paste'
    ) {
      nextVendorChecked[nextReport.candidates[0].candidateId] = true;
    }

    setSelectedVendors(nextVendorChecked);
    setSelectedModelsByVendor(nextModelsChecked);
    setExpandedVendors(nextExpanded);
    setProbingByCandidate({});
    setProbeErrorByCandidate({});
    setModelSearchByVendor({});
  }, []);

  const runScan = useCallback(
    async (params?: { textInput?: string | null; filePath?: string | null }) => {
      clearDebounceTimer();
      setScanning(true);
      setScanError(null);
      try {
        const result = await scanExternalLlmConfigs(params);
        setReport(result);
        hydrateSelectionsFromReport(result);
        if (params?.textInput !== undefined && params.textInput !== null) {
          setLastParsedPasteText(params.textInput.trim());
        }
        if (params?.filePath) {
          setPickedFilePathLabel(result.sources[0]?.pathLabel ?? params.filePath);
        } else {
          setPickedFilePathLabel(null);
        }
        if (!params?.textInput && !params?.filePath && !result.autoScanSupported) {
          setActiveTab('paste');
        }
        return result;
      } catch (err) {
        setScanError(getErrorMessage(err));
        return null;
      } finally {
        setScanning(false);
      }
    },
    [clearDebounceTimer, hydrateSelectionsFromReport],
  );

  useEffect(() => {
    const trimmedInit = initialTextInput.trim();
    if (trimmedInit) {
      setActiveTab('paste');
      setPasteText(trimmedInit);
      void runScan({ textInput: trimmedInit });
    } else {
      setActiveTab('scan');
      setPasteText('');
      setLastParsedPasteText('');
      void runScan();
    }
  }, [initialTextInput, runScan, triggerSeq]);

  const handlePasteTextChange = useCallback(
    (nextVal: string) => {
      setPasteText(nextVal);
      clearDebounceTimer();
      const trimmed = nextVal.trim();
      if (!trimmed) {
        setLastParsedPasteText('');
        setReport(null);
        return;
      }
      if (looksLikeStructuredExternalConfig(trimmed)) {
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          void runScan({ textInput: trimmed });
        }, 350);
      }
    },
    [clearDebounceTimer, runScan],
  );

  const handleReadClipboard = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return;
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) return;
      setActiveTab('paste');
      setPasteText(clip);
      await runScan({ textInput: clip });
    } catch (err) {
      setScanError(getErrorMessage(err));
    }
  }, [runScan]);

  const handlePickFile = useCallback(async () => {
    try {
      const picked = await pickExternalConfigSource(t('settings:external_import.pick_file_title'));
      if (!picked) return;
      if (picked.kind === 'path') {
        setActiveTab('scan');
        await runScan({ filePath: picked.filePath });
      } else {
        setActiveTab('paste');
        setPasteText(picked.text);
        await runScan({ textInput: picked.text });
      }
    } catch (err) {
      setScanError(getErrorMessage(err));
    }
  }, [runScan, t]);

  const handleProbeModels = useCallback(
    async (candidate: ExternalVendorCandidateDto) => {
      if (!report) return;
      const cid = candidate.candidateId;
      setProbingByCandidate((prev) => ({ ...prev, [cid]: true }));
      setProbeErrorByCandidate((prev) => {
        const copy = { ...prev };
        delete copy[cid];
        return copy;
      });
      try {
        const models = await probeExternalCandidateModels(report.sessionId, cid);
        setReport((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            candidates: prev.candidates.map((item) =>
              item.candidateId === cid ? { ...item, models } : item,
            ),
          };
        });
        setSelectedModelsByVendor((prev) => {
          const prevMap = prev[cid] ?? {};
          const nextMap: Record<string, boolean> = {};
          for (const m of models) {
            nextMap[m.id] = prevMap[m.id] ?? m.recommended;
          }
          return { ...prev, [cid]: nextMap };
        });
        setSelectedVendors((prev) => ({ ...prev, [cid]: true }));
        setExpandedVendors((prev) => ({ ...prev, [cid]: true }));
      } catch (err) {
        setProbeErrorByCandidate((prev) => ({ ...prev, [cid]: getErrorMessage(err) }));
      } finally {
        setProbingByCandidate((prev) => ({ ...prev, [cid]: false }));
      }
    },
    [report],
  );

  const toggleVendorChecked = (candidateId: string, checked: boolean) => {
    setSelectedVendors((prev) => ({ ...prev, [candidateId]: checked }));
  };

  const toggleAllVendors = (checked: boolean) => {
    if (!report) return;
    const next: Record<string, boolean> = {};
    for (const c of report.candidates) {
      next[c.candidateId] = checked;
    }
    setSelectedVendors(next);
  };

  const toggleModelChecked = (candidateId: string, modelId: string, checked: boolean) => {
    setSelectedModelsByVendor((prev) => ({
      ...prev,
      [candidateId]: {
        ...(prev[candidateId] ?? {}),
        [modelId]: checked,
      },
    }));
    if (checked) {
      setSelectedVendors((prev) => (prev[candidateId] ? prev : { ...prev, [candidateId]: true }));
    }
  };

  const applyModelQuickFilter = (
    candidate: ExternalVendorCandidateDto,
    mode: 'recommended' | 'all' | 'none',
  ) => {
    const nextMap: Record<string, boolean> = {};
    for (const m of candidate.models) {
      nextMap[m.id] = mode === 'all' ? true : mode === 'recommended' ? m.recommended : false;
    }
    setSelectedModelsByVendor((prev) => ({ ...prev, [candidate.candidateId]: nextMap }));
    if (mode !== 'none') {
      setSelectedVendors((prev) => ({ ...prev, [candidate.candidateId]: true }));
    }
  };

  const selectedCandidateCount = useMemo(() => {
    if (!report) return 0;
    return report.candidates.filter((c) => Boolean(selectedVendors[c.candidateId])).length;
  }, [report, selectedVendors]);

  const allCandidatesAlreadySynced = useMemo(() => {
    if (!report || report.candidates.length === 0) return false;
    return report.candidates.every((c) => c.syncStatus === 'synced');
  }, [report]);

  const isPasteUnparsed =
    activeTab === 'paste' &&
    pasteText.trim() !== '' &&
    pasteText.trim() !== lastParsedPasteText;

  const sourceSummaryText = useMemo(() => {
    if (!report || report.sources.length === 0) return null;
    const matched = report.sources.filter((s) => s.candidateCount > 0);
    const matchedNames = Array.from(new Set(matched.map((s) => sourceDisplayName(s.source, t))));
    const tooltip = report.sources
      .map(
        (s) =>
          `${sourceDisplayName(s.source, t)} (${s.pathLabel}): ${s.error ? s.error : s.candidateCount}`,
      )
      .join('\n');

    if (pickedFilePathLabel) {
      return {
        text: `${t('settings:external_import.sources.file')}: ${pickedFilePathLabel}`,
        tooltip,
      };
    }

    if (matchedNames.length > 0) {
      return {
        text: t('settings:external_import.scan_summary_found', {
          total: report.sources.length,
          sources: matchedNames.join('、'),
        }),
        tooltip,
      };
    }

    return {
      text: t('settings:external_import.scan_summary_none', {
        total: report.sources.length,
      }),
      tooltip,
    };
  }, [pickedFilePathLabel, report, t]);

  const handleConfirmImport = useCallback(async () => {
    if (!report || selectedCandidateCount === 0) return;
    setImporting(true);
    setScanError(null);
    try {
      const selections = report.candidates
        .filter((c) => Boolean(selectedVendors[c.candidateId]))
        .map((c) => {
          if (c.models.length === 0) {
            return { candidateId: c.candidateId, selectedModelIds: null };
          }
          const map = selectedModelsByVendor[c.candidateId] ?? {};
          const chosen = c.models.filter((m) => Boolean(map[m.id])).map((m) => m.id);
          return { candidateId: c.candidateId, selectedModelIds: chosen };
        });

      const result = await importExternalLlmConfigs({
        sessionId: report.sessionId,
        selections,
        autoFetchMissingModels: true,
        autoAssignEmptySlots,
      });

      const totalVendors = result.importedVendorCount + result.updatedVendorCount;
      showGlobalNotification(
        'success',
        t('settings:external_import.notifications.import_success_title'),
        t('settings:external_import.notifications.import_success_desc', {
          vendorCount: totalVendors,
          modelCount: result.importedModelCount,
          slotCount: result.assignedSlotCount,
        }),
      );
      if (result.warnings.length > 0) {
        showGlobalNotification(
          'warning',
          t('settings:external_import.notifications.import_warning_title'),
          result.warnings.join('；'),
        );
      }
      onImported?.(result);
    } catch (err) {
      setScanError(getErrorMessage(err));
    } finally {
      setImporting(false);
    }
  }, [
    autoAssignEmptySlots,
    onImported,
    report,
    selectedCandidateCount,
    selectedModelsByVendor,
    selectedVendors,
    t,
  ]);

  const renderModelRow = (candidateId: string, model: ExternalCandidateModelDto) => {
    const checked = Boolean(selectedModelsByVendor[candidateId]?.[model.id]);
    const ctxText = formatContextTokens(model.contextWindow);
    return (
      <label
        key={model.id}
        className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Checkbox
            checked={checked}
            onCheckedChange={(val) => toggleModelChecked(candidateId, model.id, Boolean(val))}
          />
          <code className="truncate font-mono text-xs text-foreground">{model.id}</code>
          {model.recommended && (
            <span className="shrink-0 text-2xs text-primary">
              {t('settings:external_import.model_recommended')}
            </span>
          )}
          {model.alreadyExists && (
            <span className="shrink-0 text-2xs text-muted-foreground">
              {t('settings:external_import.model_exists')}
            </span>
          )}
        </div>
        {ctxText && (
          <code className="shrink-0 font-mono text-2xs text-muted-foreground">{ctxText}</code>
        )}
      </label>
    );
  };

  const tabOptions = useMemo(
    () => [
      {
        value: 'scan' as const,
        label: t('settings:external_import.tabs.scan'),
        disabled: report !== null && !report.autoScanSupported && !pickedFilePathLabel,
      },
      {
        value: 'paste' as const,
        label: t('settings:external_import.tabs.paste'),
      },
    ],
    [pickedFilePathLabel, report, t],
  );

  return (
    <div
      data-testid="external-tool-import-panel"
      className={cn('space-y-3', className)}
    >
      {/* 紧凑工具栏：模式切换 + 静默操作 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<ImportModeTab>
          ariaLabel={t('settings:external_import.mode_switch_aria')}
          size="compact"
          value={activeTab}
          onValueChange={(next) => {
            clearDebounceTimer();
            setActiveTab(next);
            if (next === 'scan') {
              void runScan();
            } else if (pasteText.trim()) {
              void runScan({ textInput: pasteText });
            } else {
              setReport(null);
            }
          }}
          options={tabOptions}
        />

        <div className="flex items-center gap-1">
          {activeTab === 'scan' && (
            <DsButton
              variant="ghost"
              size="sm"
              disabled={scanning || importing}
              onClick={() => void runScan()}
              data-testid="external-import-rescan-btn"
            >
              <ArrowsClockwise size={13} className={cn(scanning && 'animate-spin')} />
              <span>{t('settings:external_import.actions.rescan')}</span>
            </DsButton>
          )}
          <DsButton
            variant="ghost"
            size="sm"
            disabled={scanning || importing}
            onClick={() => void handlePickFile()}
            data-testid="external-import-pick-file-btn"
          >
            <FolderOpen size={13} />
            <span>{t('settings:external_import.actions.pick_file')}</span>
          </DsButton>
        </div>
      </div>

      {/* 粘贴输入区（粘贴即自动解析，支持剪贴板一键读取） */}
      {activeTab === 'paste' && (
        <div className="space-y-2 rounded-xl border border-border/35 bg-background/60 p-2.5">
          <Textarea
            {...TECHNICAL_INPUT_PROPS}
            rows={3}
            value={pasteText}
            onChange={(e) => handlePasteTextChange(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData?.getData('text');
              if (pasted && pasted.trim()) {
                e.preventDefault();
                setPasteText(pasted);
                void runScan({ textInput: pasted });
              }
            }}
            placeholder={t('settings:external_import.paste_placeholder')}
            aria-label={t('settings:external_import.paste_aria_label')}
            className="font-mono text-xs resize-y bg-transparent"
            data-testid="external-import-paste-textarea"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t('settings:external_import.paste_hint')}
            </span>
            <div className="flex items-center gap-1">
              {typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText) && (
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={scanning || importing}
                  onClick={() => void handleReadClipboard()}
                >
                  <ClipboardText size={13} />
                  <span>{t('settings:external_import.actions.paste_clipboard')}</span>
                </DsButton>
              )}
              <DsButton
                variant="ghost"
                size="sm"
                disabled={scanning || importing || !pasteText.trim()}
                onClick={() => void runScan({ textInput: pasteText })}
                data-testid="external-import-parse-btn"
              >
                {scanning ? (
                  <CircleNotch size={13} className="animate-spin" />
                ) : (
                  <MagnifyingGlass size={13} />
                )}
                <span>{t('settings:external_import.actions.parse_snippet')}</span>
              </DsButton>
            </div>
          </div>
        </div>
      )}

      {/* 单行扫描摘要 + 批量勾选（替代原先多行零项标签） */}
      {activeTab === 'scan' && sourceSummaryText && !scanning && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0" title={sourceSummaryText.tooltip}>
            <span className="truncate">{sourceSummaryText.text}</span>
            {report && report.skippedProxyCount > 0 && (
              <span className="text-muted-foreground/80">
                · {t('settings:external_import.skipped_proxy_short', { count: report.skippedProxyCount })}
              </span>
            )}
          </div>
          {report && report.candidates.length > 1 && (
            <div className="flex shrink-0 items-center gap-1">
              <DsButton variant="ghost" size="sm" onClick={() => toggleAllVendors(true)}>
                {t('settings:external_import.actions.select_all')}
              </DsButton>
              <DsButton variant="ghost" size="sm" onClick={() => toggleAllVendors(false)}>
                {t('settings:external_import.actions.select_none')}
              </DsButton>
            </div>
          )}
        </div>
      )}

      {/* 粘贴模式下的代理跳过提示 / 批量选择 */}
      {activeTab === 'paste' && report && (report.skippedProxyCount > 0 || report.candidates.length > 1) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {report.skippedProxyCount > 0
              ? t('settings:external_import.skipped_proxy_notice', {
                  count: report.skippedProxyCount,
                })
              : t('settings:external_import.vendor_selection_summary', {
                  selected: selectedCandidateCount,
                  total: report.candidates.length,
                })}
          </span>
          {report.candidates.length > 1 && (
            <div className="flex items-center gap-1">
              <DsButton variant="ghost" size="sm" onClick={() => toggleAllVendors(true)}>
                {t('settings:external_import.actions.select_all')}
              </DsButton>
              <DsButton variant="ghost" size="sm" onClick={() => toggleAllVendors(false)}>
                {t('settings:external_import.actions.select_none')}
              </DsButton>
            </div>
          )}
        </div>
      )}

      {/* 全部已同步静默提示条 */}
      {allCandidatesAlreadySynced && selectedCandidateCount === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-success/25 bg-success/[0.06] px-3 py-2 text-xs">
          <div className="flex items-center gap-2 text-foreground/90">
            <CheckCircle size={14} className="shrink-0 text-success" />
            <span>
              {t('settings:external_import.all_synced_banner', {
                count: report?.candidates.length ?? 0,
              })}
            </span>
          </div>
          <DsButton variant="ghost" size="sm" onClick={() => toggleAllVendors(true)}>
            {t('settings:external_import.actions.force_resync_all')}
          </DsButton>
        </div>
      )}

      {/* 错误提示 */}
      {scanError && (
        <Alert variant="destructive" className="px-3 py-2">
          <AlertDescription className="text-xs">{scanError}</AlertDescription>
        </Alert>
      )}

      {/* 扫描中 / 空状态 / 统一细线分隔的供应商列表 */}
      {scanning && (!report || report.candidates.length === 0) ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
          <CircleNotch size={15} className="animate-spin" />
          <span>{t('settings:external_import.scanning')}</span>
        </div>
      ) : !report || report.candidates.length === 0 ? (
        <div
          data-testid="external-import-empty-state"
          className="rounded-xl border border-dashed border-border/50 bg-background/40 px-4 py-6 text-center space-y-2.5"
        >
          <p className="text-xs font-medium text-foreground">
            {activeTab === 'paste' && !pasteText.trim()
              ? t('settings:external_import.paste_empty_title')
              : t('settings:external_import.empty_title')}
          </p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
            {t('settings:external_import.empty_desc')}
          </p>
          {activeTab === 'scan' && (
            <div className="flex flex-wrap items-center justify-center gap-1.5 pt-0.5">
              <DsButton variant="ghost" size="sm" onClick={() => void handlePickFile()}>
                <FolderOpen size={13} />
                <span>{t('settings:external_import.actions.pick_file')}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  setActiveTab('paste');
                  setReport(null);
                }}
              >
                <ClipboardText size={13} />
                <span>{t('settings:external_import.tabs.paste')}</span>
              </DsButton>
            </div>
          )}
        </div>
      ) : (
        <div
          data-testid="external-import-candidate-list"
          className="rounded-xl border border-border/35 bg-background/60 divide-y divide-border/35 overflow-hidden"
        >
          {report.candidates.map((cand) => {
            const isChecked = Boolean(selectedVendors[cand.candidateId]);
            const isExpanded = Boolean(expandedVendors[cand.candidateId]);
            const isProbing = Boolean(probingByCandidate[cand.candidateId]);
            const probeErr = probeErrorByCandidate[cand.candidateId];
            const modelCheckMap = selectedModelsByVendor[cand.candidateId] ?? {};
            const chosenModelCount = cand.models.filter((m) => Boolean(modelCheckMap[m.id])).length;
            const searchKeyword = (modelSearchByVendor[cand.candidateId] ?? '').trim().toLowerCase();
            const visibleModels = searchKeyword
              ? cand.models.filter(
                  (m) =>
                    m.id.toLowerCase().includes(searchKeyword) ||
                    m.label.toLowerCase().includes(searchKeyword),
                )
              : cand.models;
            const statusMeta = syncStatusMeta(cand.syncStatus, t);
            const sourceLabels = cand.sources.map((src) => sourceDisplayName(src, t)).join(' / ');

            return (
              <div
                key={cand.candidateId}
                data-testid={`external-candidate-${cand.candidateId}`}
                className={cn(
                  'transition-colors',
                  isChecked ? 'hover:bg-muted/20' : 'opacity-65 hover:opacity-90',
                )}
              >
                <div className="px-3 py-2.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={(val) => toggleVendorChecked(cand.candidateId, Boolean(val))}
                        aria-label={cand.name}
                      />
                      <ProviderIcon
                        modelId={resolveCandidateIconHint(cand)}
                        size={15}
                        showTooltip={false}
                        variant="color"
                      />
                      <span className="text-sm font-medium text-foreground truncate">
                        {cand.name}
                      </span>
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center text-xs',
                          statusMeta.textClass,
                        )}
                      >
                        {statusMeta.label}
                      </span>
                      <span className="hidden sm:inline text-xs text-muted-foreground truncate">
                        · {sourceLabels} · {protocolShortLabel(cand.apiProtocol, t)}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5">
                      <DsButton
                        variant="ghost"
                        size="sm"
                        disabled={isProbing || importing}
                        onClick={() => void handleProbeModels(cand)}
                        data-testid={`external-probe-${cand.candidateId}`}
                      >
                        {isProbing ? (
                          <CircleNotch size={13} className="animate-spin motion-reduce:animate-none" />
                        ) : (
                          <MagnifyingGlass size={13} />
                        )}
                        <span>{t('settings:external_import.actions.probe_models')}</span>
                      </DsButton>
                      {cand.models.length > 0 && (
                        <DsButton
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setExpandedVendors((prev) => ({
                              ...prev,
                              [cand.candidateId]: !prev[cand.candidateId],
                            }))
                          }
                          aria-label={t('settings:external_import.actions.toggle_models')}
                        >
                          {isExpanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
                          <span className="tabular-nums">
                            {t('settings:external_import.selected_models_count', {
                              selected: chosenModelCount,
                              total: cand.models.length,
                            })}
                          </span>
                        </DsButton>
                      )}
                    </div>
                  </div>

                  <div className="pl-6 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
                    <code className="font-mono truncate max-w-[280px] sm:max-w-[360px]">
                      {cand.baseUrl}
                    </code>
                    {cand.maskedApiKey && (
                      <code className="font-mono text-muted-foreground/85">
                        {cand.maskedApiKey}
                      </code>
                    )}
                    {cand.extraKeyCount > 0 && (
                      <span>
                        {t('settings:external_import.extra_keys_badge', {
                          count: cand.extraKeyCount,
                        })}
                      </span>
                    )}
                    {cand.models.length === 0 && !probeErr && (
                      <span className="text-muted-foreground/75">
                        · {t('settings:external_import.auto_probe_short')}
                      </span>
                    )}
                  </div>

                  {isChecked && cand.models.length > 0 && chosenModelCount === 0 && !probeErr && (
                    <p className="pl-6 text-xs text-warning">
                      {t('settings:external_import.zero_models_selected_hint')}
                    </p>
                  )}

                  {probeErr && (
                    <p className="pl-6 text-xs text-destructive">{probeErr}</p>
                  )}
                </div>

                {/* 展开的模型选择区（双列紧凑布局，超过 8 个显示搜索框） */}
                {isExpanded && cand.models.length > 0 && (
                  <div className="border-t border-border/35 bg-muted/20 px-3 py-2 space-y-2">
                    {(cand.models.length > 5 || searchKeyword !== '') && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {cand.models.length > 8 ? (
                          <Input
                            {...TECHNICAL_INPUT_PROPS}
                            value={modelSearchByVendor[cand.candidateId] ?? ''}
                            onChange={(e) =>
                              setModelSearchByVendor((prev) => ({
                                ...prev,
                                [cand.candidateId]: e.target.value,
                              }))
                            }
                            placeholder={t('settings:external_import.search_models_placeholder')}
                            aria-label={t('settings:external_import.search_models_placeholder')}
                            className="h-7 max-w-[220px] font-mono text-xs"
                          />
                        ) : (
                          <span />
                        )}
                        <div className="flex items-center gap-0.5">
                          <DsButton
                            variant="ghost"
                            size="sm"
                            onClick={() => applyModelQuickFilter(cand, 'recommended')}
                          >
                            {t('settings:external_import.actions.select_recommended')}
                          </DsButton>
                          <DsButton
                            variant="ghost"
                            size="sm"
                            onClick={() => applyModelQuickFilter(cand, 'all')}
                          >
                            {t('settings:external_import.actions.select_all')}
                          </DsButton>
                          <DsButton
                            variant="ghost"
                            size="sm"
                            onClick={() => applyModelQuickFilter(cand, 'none')}
                          >
                            {t('settings:external_import.actions.select_none')}
                          </DsButton>
                        </div>
                      </div>
                    )}
                    <div className="max-h-44 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-0.5 pr-1">
                      {visibleModels.length > 0 ? (
                        visibleModels.map((m) => renderModelRow(cand.candidateId, m))
                      ) : (
                        <p className="col-span-full py-2.5 text-center text-xs text-muted-foreground">
                          {t('settings:external_import.no_matching_models')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 底部静默操作栏：左开关 + 右主按钮（与「一键连接并配置」视觉一致） */}
      {report && report.candidates.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-border/35">
          <label
            className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            title={t('settings:external_import.auto_assign_slots_desc')}
          >
            <Switch
              checked={autoAssignEmptySlots}
              onCheckedChange={setAutoAssignEmptySlots}
              aria-label={t('settings:external_import.auto_assign_slots_title')}
            />
            <span>{t('settings:external_import.auto_assign_slots_title')}</span>
          </label>

          <div className="flex items-center gap-2">
            {onCancel && (
              <DsButton variant="ghost" size="sm" onClick={onCancel} disabled={importing}>
                {t('common:actions.cancel')}
              </DsButton>
            )}
            <DsButton
              variant="primary"
              size="sm"
              disabled={importing || scanning || isPasteUnparsed || selectedCandidateCount === 0}
              onClick={() => void handleConfirmImport()}
              data-testid="external-import-confirm-btn"
              className="h-9 rounded-control !border-transparent !bg-foreground px-4 text-xs font-medium !text-background hover:!bg-foreground/90 hover:!text-background active:!bg-foreground/85"
            >
              {importing ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <CheckCircle size={14} />
              )}
              <span>
                {importing
                  ? t('settings:external_import.actions.importing')
                  : t('settings:external_import.actions.import_selected', {
                      count: selectedCandidateCount,
                    })}
              </span>
            </DsButton>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExternalToolImportPanel;
