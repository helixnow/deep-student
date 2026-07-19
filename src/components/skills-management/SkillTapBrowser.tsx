/**
 * SkillTapBrowser - Tap 技能源浏览面板（页面内嵌，非模态）
 *
 * 两个标签：
 * 1. GitHub：仓库链接 → catalog → 装前扫描 → 确认安装
 * 2. ClawHub：搜索/trending → verify → download+scan → 确认 → install
 *
 * ★ 设计约束：本面板及装前确认均为页面内联展开，不使用模态框/遮罩。
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GithubLogo,
  MagnifyingGlass,
  Package,
  CheckCircle,
  DownloadSimple,
  X,
  Storefront,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '../UnifiedNotification';
import { skillRegistry, reloadSkills } from '@/features/chat/skills';
import {
  fetchTapCatalog,
  installTapSkill,
  clawhubSearch,
  clawhubVerify,
  clawhubDownloadAndScan,
  type TapCatalog,
  type TapCatalogEntry,
  type SkillPackageScanResult,
  type ClawHubSkillCard,
  type ClawHubDownloadScanResult,
  type ClawHubVerifyResult,
} from '@/features/chat/skills/api';
import {
  classifyClawHubSearchError,
  resolveClawHubSearchSuccess,
  type ClawHubListUiStatus,
} from '@/features/chat/skills/clawhubUi';
import './SkillTapBrowser.css';

// ============================================================================
// 常量
// ============================================================================

const RECENT_TAPS_KEY = 'skills.tap.recent_sources';
const MAX_RECENT_TAPS = 8;

const PRESET_TAPS: Array<{ label: string; url: string }> = [
  { label: 'anthropics/skills', url: 'https://github.com/anthropics/skills' },
];

const RISK_BADGE_CLASSES: Record<string, string> = {
  low: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  high: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

type SourceTab = 'github' | 'clawhub';

function loadRecentTaps(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_TAPS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecentTap(url: string): void {
  try {
    const next = [url, ...loadRecentTaps().filter((v) => v !== url)].slice(0, MAX_RECENT_TAPS);
    localStorage.setItem(RECENT_TAPS_KEY, JSON.stringify(next));
  } catch {
    // localStorage 不可用时静默降级
  }
}

function verifyBadgeKind(verify?: ClawHubVerifyResult | null): 'ok' | 'fail' | 'pending' | 'unknown' {
  if (!verify) return 'unknown';
  if (verify.ok && (verify.decision === 'pass' || verify.securityPassed)) return 'ok';
  if (verify.decision === 'fail' || verify.securityStatus === 'malicious') return 'fail';
  if (
    verify.decision === 'pending'
    || verify.securityStatus === 'pending'
    || verify.securityStatus === 'suspicious'
  ) {
    return 'pending';
  }
  if (verify.ok) return 'ok';
  return 'unknown';
}

// ============================================================================
// 组件
// ============================================================================

export interface SkillTapBrowserProps {
  onClose: () => void;
  className?: string;
}

export const SkillTapBrowser: React.FC<SkillTapBrowserProps> = ({ onClose, className }) => {
  const { t } = useTranslation(['skills', 'common']);
  const [tab, setTab] = useState<SourceTab>('github');

  // —— GitHub tap state ——
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState<TapCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentTaps, setRecentTaps] = useState<string[]>(() => loadRecentTaps());
  const [pendingInstall, setPendingInstall] = useState<{
    entry: TapCatalogEntry;
    scan: SkillPackageScanResult;
    overwrite: boolean;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [scanningSubdir, setScanningSubdir] = useState<string | null>(null);
  const [installedSubdirs, setInstalledSubdirs] = useState<Set<string>>(new Set());

  // —— ClawHub state（empty / rate_limited / network_error / success 分通道）——
  const [clawQuery, setClawQuery] = useState('');
  const [clawStatus, setClawStatus] = useState<ClawHubListUiStatus>('idle');
  const [clawErrorMessage, setClawErrorMessage] = useState<string | null>(null);
  const [clawItems, setClawItems] = useState<ClawHubSkillCard[]>([]);
  const [nonSuspiciousOnly, setNonSuspiciousOnly] = useState(true);
  const clawLoading = clawStatus === 'loading';
  const [clawPending, setClawPending] = useState<{
    card: ClawHubSkillCard;
    result: ClawHubDownloadScanResult;
    overwrite: boolean;
  } | null>(null);
  const [clawBusySlug, setClawBusySlug] = useState<string | null>(null);
  const [clawInstalling, setClawInstalling] = useState(false);
  const [clawInstalled, setClawInstalled] = useState<Set<string>>(new Set());
  const clawRequestSeq = useRef(0);

  useEffect(() => () => {
    clawRequestSeq.current += 1;
  }, []);

  const handleBrowse = useCallback(async (targetUrl?: string) => {
    const repoUrl = (targetUrl ?? url).trim();
    if (!repoUrl) return;
    setLoading(true);
    setError(null);
    setCatalog(null);
    setPendingInstall(null);
    try {
      const result = await fetchTapCatalog(repoUrl);
      setCatalog(result);
      setUrl(repoUrl);
      saveRecentTap(repoUrl);
      setRecentTaps(loadRecentTaps());
      if (result.skills.length === 0) {
        setError(t('skills:tap.no_skills_found'));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [url, t]);

  const handleInstallClick = useCallback(async (entry: TapCatalogEntry) => {
    if (!catalog) return;
    const effectiveId = entry.skillId || entry.name;
    const overwrite = Boolean(effectiveId && skillRegistry.get(effectiveId));
    setScanningSubdir(entry.subdir);
    setPendingInstall(null);
    try {
      const scan = await installTapSkill({
        zipUrl: catalog.resolvedZipUrl,
        subdir: entry.subdir,
        overwrite: true,
        dryRun: true,
      });
      setPendingInstall({
        entry,
        scan,
        overwrite: overwrite || Boolean(skillRegistry.get(scan.skill_id)),
      });
    } catch (e) {
      showGlobalNotification('error', String(e), t('skills:tap.scan_failed'));
    } finally {
      setScanningSubdir(null);
    }
  }, [catalog, t]);

  const handleConfirmInstall = useCallback(async () => {
    if (!pendingInstall || !catalog) return;
    setInstalling(true);
    try {
      const result = await installTapSkill({
        zipUrl: catalog.resolvedZipUrl,
        subdir: pendingInstall.entry.subdir,
        overwrite: pendingInstall.overwrite,
        dryRun: false,
        expectedPackageSha256: pendingInstall.scan.package_sha256,
      });
      await reloadSkills();
      setInstalledSubdirs((prev) => new Set(prev).add(pendingInstall.entry.subdir));
      showGlobalNotification(
        'success',
        t('skills:tap.install_untrusted_hint'),
        t('skills:tap.install_success', { name: result.skill_id }),
      );
      setPendingInstall(null);
    } catch (e) {
      showGlobalNotification('error', String(e), t('skills:tap.install_failed'));
    } finally {
      setInstalling(false);
    }
  }, [pendingInstall, catalog, t]);

  const isEntryInstalled = useCallback((entry: TapCatalogEntry): boolean => {
    if (installedSubdirs.has(entry.subdir)) return true;
    return Boolean(entry.skillId && skillRegistry.get(entry.skillId));
  }, [installedSubdirs]);

  const quickSources = useMemo(() => {
    const preset = PRESET_TAPS.map((p) => ({ label: p.label, url: p.url }));
    const recents = recentTaps
      .filter((u) => !preset.some((p) => p.url === u))
      .map((u) => ({ label: u.replace('https://github.com/', ''), url: u }));
    return [...preset, ...recents];
  }, [recentTaps]);

  // —— ClawHub ——
  const loadClawHub = useCallback(async (query?: string) => {
    const requestSeq = ++clawRequestSeq.current;
    const q = (query ?? clawQuery).trim();
    setClawStatus('loading');
    setClawErrorMessage(null);
    setClawPending(null);
    try {
      const result = await clawhubSearch({
        q: q || undefined,
        limit: 24,
        nonSuspiciousOnly,
        sort: 'trending',
      });
      if (requestSeq !== clawRequestSeq.current) return;
      setClawItems(result.items);
      setClawStatus(resolveClawHubSearchSuccess(result.items));
    } catch (e) {
      if (requestSeq !== clawRequestSeq.current) return;
      setClawItems([]);
      const kind = classifyClawHubSearchError(e);
      setClawStatus(kind);
      setClawErrorMessage(
        kind === 'rate_limited'
          ? t('skills:tap.clawhub.rate_limited')
          : t('skills:tap.clawhub.network_error'),
      );
    }
  }, [clawQuery, nonSuspiciousOnly, t]);

  useEffect(() => {
    // 仅 idle 时自动拉取，避免 empty/error 被当成「未加载」反复请求
    if (tab === 'clawhub' && clawStatus === 'idle') {
      void loadClawHub('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab !== 'clawhub') return;
    // 切换 nonSuspiciousOnly 后刷新当前查询
    void loadClawHub(clawQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonSuspiciousOnly]);

  const handleClawInstallClick = useCallback(async (card: ClawHubSkillCard) => {
    setClawBusySlug(card.slug);
    setClawPending(null);
    try {
      // 1) verify
      const verify = await clawhubVerify(card.slug, card.version || null);
      if (!verify.ok && verify.decision === 'fail') {
        showGlobalNotification(
          'error',
          verify.reasons.join('; ') || verify.securityStatus,
          t('skills:tap.clawhub.verify_fail'),
        );
        // 仍允许用户看到失败徽章后自行决定；不自动中断扫描，但提示风险
      }
      // 2) download + scan
      const result = await clawhubDownloadAndScan({
        slug: card.slug,
        version: card.version || verify.version || null,
        install: false,
        overwrite: true,
      });
      const overwrite = Boolean(skillRegistry.get(result.scan.skill_id));
      setClawPending({
        card: {
          ...card,
          version: result.version || card.version,
          verify,
          ownerHandle: card.ownerHandle || verify.publisherHandle,
        },
        result,
        overwrite,
      });
    } catch (e) {
      const kind = classifyClawHubSearchError(e);
      showGlobalNotification(
        'error',
        kind === 'rate_limited'
          ? t('skills:tap.clawhub.rate_limited')
          : t('skills:tap.clawhub.network_error'),
        t('skills:tap.clawhub.scan_failed'),
      );
    } finally {
      setClawBusySlug(null);
    }
  }, [t]);

  const handleClawConfirmInstall = useCallback(async () => {
    if (!clawPending) return;
    setClawInstalling(true);
    try {
      const tempZipPath = clawPending.result.tempZipPath;
      if (!tempZipPath) {
        throw new Error('Confirmed ClawHub scan artifact is missing; scan again');
      }
      const result = await clawhubDownloadAndScan({
        slug: clawPending.card.slug,
        version: clawPending.result.version || clawPending.card.version || null,
        install: true,
        overwrite: clawPending.overwrite,
        expectedPackageSha256: clawPending.result.scan.package_sha256,
        tempZipPath,
      });
      await reloadSkills();
      setClawInstalled((prev) => new Set(prev).add(clawPending.card.slug));
      // 市场 verify≠本地 trust：安装成功后明确提示默认未信任
      showGlobalNotification(
        'success',
        t('skills:tap.install_untrusted_hint'),
        t('skills:tap.clawhub.install_success', { name: result.scan.skill_id }),
      );
      setClawPending(null);
    } catch (e) {
      const kind = classifyClawHubSearchError(e);
      showGlobalNotification(
        'error',
        kind === 'rate_limited'
          ? t('skills:tap.clawhub.rate_limited')
          : t('skills:tap.clawhub.network_error'),
        t('skills:tap.clawhub.install_failed'),
      );
    } finally {
      setClawInstalling(false);
    }
  }, [clawPending, t]);

  const renderRiskConfirm = (
    scan: SkillPackageScanResult,
    sourceLabel: string,
    onCancel: () => void,
    onConfirm: () => void,
    busy: boolean,
    overwrite: boolean,
  ) => {
    const riskLevel = RISK_BADGE_CLASSES[scan.risk_level] ? scan.risk_level : 'low';
    const isHighRisk = riskLevel === 'high';
    return (
      <div className="mt-2 space-y-2.5 rounded-md border border-border/60 bg-[color:var(--surface-muted)] p-3">
        <p className="text-xs leading-relaxed text-foreground">{sourceLabel}</p>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px]">
            {t('skills:package.permission_files', { count: scan.files_extracted })}
          </span>
          <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px]">
            {t('skills:management.import_scan_scripts', { count: scan.scripts_count })}
          </span>
          <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px]">
            {t('skills:management.import_scan_tools', { count: scan.allowed_tools_count })}
          </span>
          {scan.package_sha256 && (
            <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[10px]">
              sha256:{scan.package_sha256.slice(0, 12)}
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {t('skills:management.risk_heading')}
            </span>
            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', RISK_BADGE_CLASSES[riskLevel])}>
              {t(`skills:management.risk_${riskLevel}`, scan.risk_level)}
            </span>
          </div>
          {riskLevel !== 'low' && scan.risk_signals.length > 0 && (
            <ul className="space-y-0.5">
              {scan.risk_signals.map((signal) => (
                <li key={signal} className="text-[11px] leading-relaxed text-muted-foreground">
                  · {t(`skills:management.risk_signal_${signal}`, signal)}
                </li>
              ))}
            </ul>
          )}
          {isHighRisk && (
            <p className="text-[11px] leading-relaxed text-red-600 dark:text-red-400">
              {t('skills:management.risk_high_warning')}
            </p>
          )}
          {overwrite && (
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              {t('skills:management.import_confirm_overwrite_hint')}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            className="h-7 px-2.5 text-xs"
          >
            {t('common:actions.cancel')}
          </NotionButton>
          <NotionButton
            variant={isHighRisk ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className="h-7 px-2.5 text-xs"
          >
            {busy
              ? t('skills:tap.installing')
              : overwrite
                ? t('skills:management.import_confirm_overwrite_install')
                : t('skills:management.import_confirm_install')}
          </NotionButton>
        </div>
      </div>
    );
  };

  const renderVerifyBadge = (verify?: ClawHubVerifyResult | null) => {
    const kind = verifyBadgeKind(verify);
    const label =
      kind === 'ok'
        ? t('skills:tap.clawhub.verify_ok')
        : kind === 'fail'
          ? t('skills:tap.clawhub.verify_fail')
          : kind === 'pending'
            ? t('skills:tap.clawhub.verify_pending')
            : t('skills:tap.clawhub.verify_unknown');
    const security = verify?.securityStatus;
    const securityHint =
      security === 'clean'
        ? t('skills:tap.clawhub.security_clean')
        : security === 'suspicious'
          ? t('skills:tap.clawhub.security_suspicious')
          : security === 'malicious'
            ? t('skills:tap.clawhub.security_malicious')
            : undefined;
    // 市场审核徽章 ≠ 本地 trust；title 明确二者正交，避免「已通过」被读成「已信任」
    const title = [securityHint, t('skills:tap.clawhub.verify_not_trust_hint')]
      .filter(Boolean)
      .join(' · ');
    return (
      <span
        className={cn('clawhub-verify-badge', `clawhub-verify-badge--${kind}`)}
        title={title}
        aria-label={`${label}. ${t('skills:tap.clawhub.verify_not_trust_hint')}`}
        data-testid="clawhub-verify-badge"
        data-verify-kind={kind}
      >
        {label}
        {security && security !== 'unknown' ? ` · ${security}` : ''}
      </span>
    );
  };

  const renderGithubPanel = () => (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleBrowse();
            }}
            placeholder={t('skills:tap.url_placeholder')}
            className="h-8 pl-8 pr-3 text-xs"
          />
        </div>
        <NotionButton
          variant="primary"
          size="sm"
          onClick={() => void handleBrowse()}
          disabled={loading || !url.trim()}
          className="h-8 px-3 text-xs"
        >
          {loading ? t('skills:tap.browsing') : t('skills:tap.browse')}
        </NotionButton>
      </div>

      {!catalog && quickSources.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {quickSources.map((source) => (
            // eslint-disable-next-line ds-components/no-native-button -- badge 形态快捷源 chip
            <button
              key={source.url}
              type="button"
              onClick={() => void handleBrowse(source.url)}
              disabled={loading}
              className="study-shell-badge inline-flex cursor-pointer items-center gap-1 px-2 py-1 text-[11px] transition-colors hover:bg-[var(--interactive-hover)]"
            >
              <GithubLogo size={11} />
              {source.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="break-all text-xs leading-relaxed text-red-600 dark:text-red-400">{error}</p>
      )}

      {catalog && catalog.skills.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('skills:tap.catalog_count', { count: catalog.skills.length })}
          </div>
          <div className="space-y-1">
            {catalog.skills.map((entry) => {
              const installed = isEntryInstalled(entry);
              const displayName = entry.name || entry.skillId || catalog.repoUrl;
              const isConfirming = pendingInstall?.entry.subdir === entry.subdir;
              return (
                <div
                  key={entry.subdir || '__root__'}
                  className="rounded-md border border-border/40 px-3 py-2"
                >
                  <div className="flex items-start gap-3">
                    <Package size={16} className="mt-0.5 flex-shrink-0 text-muted-foreground/60" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-foreground">{displayName}</span>
                        {entry.version && (
                          <span className="flex-shrink-0 text-[10px] text-muted-foreground/70">v{entry.version}</span>
                        )}
                      </div>
                      {entry.description && (
                        <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                          {entry.description}
                        </p>
                      )}
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/60">
                        {entry.subdir && <span className="truncate font-mono">{entry.subdir}</span>}
                        <span className="flex-shrink-0">{t('skills:tap.file_count', { count: entry.fileCount })}</span>
                      </div>
                    </div>
                    <NotionButton
                      variant={installed ? 'ghost' : 'shell'}
                      size="sm"
                      onClick={() => {
                        if (isConfirming) {
                          setPendingInstall(null);
                        } else {
                          void handleInstallClick(entry);
                        }
                      }}
                      disabled={scanningSubdir !== null || installing}
                      className="h-7 flex-shrink-0 px-2.5 text-xs"
                    >
                      {scanningSubdir === entry.subdir ? (
                        t('skills:tap.scanning')
                      ) : installed ? (
                        <>
                          <CheckCircle size={13} className="mr-1 text-green-600 dark:text-green-400" />
                          {t('skills:tap.reinstall')}
                        </>
                      ) : (
                        <>
                          <DownloadSimple size={13} className="mr-1" />
                          {t('skills:tap.install')}
                        </>
                      )}
                    </NotionButton>
                  </div>
                  {isConfirming && pendingInstall && renderRiskConfirm(
                    pendingInstall.scan,
                    t('skills:tap.install_confirm_source', {
                      name: pendingInstall.scan.skill_id,
                      repo: catalog?.repoUrl ?? '',
                    }),
                    () => setPendingInstall(null),
                    () => void handleConfirmInstall(),
                    installing,
                    pendingInstall.overwrite,
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        {t('skills:tap.footer_hint')}
      </p>
    </div>
  );

  const renderClawHubPanel = () => (
    <div className="space-y-3 p-3" data-testid="clawhub-panel">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlass
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50"
            aria-hidden="true"
          />
          <Input
            value={clawQuery}
            onChange={(e) => setClawQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void loadClawHub();
            }}
            placeholder={t('skills:tap.clawhub.search_placeholder')}
            aria-label={t('skills:tap.clawhub.search_placeholder')}
            className="h-8 pl-8 pr-3 text-xs"
            data-testid="clawhub-search-input"
          />
        </div>
        <NotionButton
          variant="primary"
          size="sm"
          onClick={() => void loadClawHub()}
          disabled={clawLoading}
          className="h-8 px-3 text-xs"
          data-testid="clawhub-search-btn"
          aria-busy={clawLoading || undefined}
        >
          {clawLoading ? t('skills:tap.clawhub.searching') : t('skills:tap.clawhub.search')}
        </NotionButton>
      </div>

      <div className="clawhub-filter-row">
        <label>
          <input
            type="checkbox"
            checked={nonSuspiciousOnly}
            onChange={(e) => setNonSuspiciousOnly(e.target.checked)}
            data-testid="clawhub-non-suspicious"
          />
          {t('skills:tap.clawhub.non_suspicious_only')}
        </label>
        <span className="text-[10px] text-muted-foreground/60">
          {t('skills:tap.clawhub.trending')}
        </span>
      </div>

      {clawStatus === 'loading' && clawItems.length === 0 && (
        <div
          className="py-6 text-center text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          data-testid="clawhub-loading"
        >
          {t('skills:tap.clawhub.searching')}
        </div>
      )}

      {clawStatus === 'empty' && (
        <div
          className="py-6 text-center text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          data-testid="clawhub-empty"
        >
          {t('skills:tap.clawhub.empty')}
        </div>
      )}

      {(clawStatus === 'rate_limited' || clawStatus === 'network_error') && clawErrorMessage && (
        <p
          className="break-all text-xs leading-relaxed text-red-600 dark:text-red-400"
          role="alert"
          aria-live="assertive"
          data-testid={clawStatus === 'rate_limited' ? 'clawhub-rate-limited' : 'clawhub-network-error'}
          data-clawhub-status={clawStatus}
        >
          {clawErrorMessage}
        </p>
      )}

      {clawStatus === 'success' && clawItems.length > 0 && (
        <div className="space-y-1" role="list" data-testid="clawhub-results" aria-live="polite">
          {clawItems.map((card) => {
            const installed = clawInstalled.has(card.slug) || Boolean(skillRegistry.get(card.slug));
            const isConfirming = clawPending?.card.slug === card.slug;
            const busy = clawBusySlug === card.slug;
            return (
              <div
                key={card.slug}
                role="listitem"
                className="rounded-md border border-border/40 px-3 py-2"
                data-testid={`clawhub-card-${card.slug}`}
              >
                <div className="flex items-start gap-3">
                  <Package size={16} className="mt-0.5 flex-shrink-0 text-muted-foreground/60" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {card.displayName || card.slug}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground/70">{card.slug}</span>
                      {card.version && (
                        <span className="flex-shrink-0 text-[10px] text-muted-foreground/70">v{card.version}</span>
                      )}
                      {renderVerifyBadge(card.verify)}
                    </div>
                    {card.summary && (
                      <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {card.summary}
                      </p>
                    )}
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground/60">
                      {card.ownerHandle && (
                        <span>{t('skills:tap.clawhub.owner', { handle: card.ownerHandle })}</span>
                      )}
                      <span>{t('skills:tap.clawhub.downloads', { count: card.downloads })}</span>
                    </div>
                  </div>
                  <NotionButton
                    variant={installed ? 'ghost' : 'shell'}
                    size="sm"
                    onClick={() => {
                      if (isConfirming) {
                        setClawPending(null);
                      } else {
                        void handleClawInstallClick(card);
                      }
                    }}
                    disabled={clawBusySlug !== null || clawInstalling}
                    className="h-7 flex-shrink-0 px-2.5 text-xs"
                    data-testid={`clawhub-install-${card.slug}`}
                  >
                    {busy ? (
                      t('skills:tap.clawhub.scanning')
                    ) : installed ? (
                      <>
                        <CheckCircle size={13} className="mr-1 text-green-600 dark:text-green-400" />
                        {t('skills:tap.clawhub.reinstall')}
                      </>
                    ) : (
                      <>
                        <DownloadSimple size={13} className="mr-1" />
                        {t('skills:tap.clawhub.install')}
                      </>
                    )}
                  </NotionButton>
                </div>
                {isConfirming && clawPending && renderRiskConfirm(
                  clawPending.result.scan,
                  t('skills:tap.clawhub.install_confirm_source', {
                    name: clawPending.result.scan.skill_id,
                    slug: clawPending.card.slug,
                    version: clawPending.result.version,
                  }),
                  () => setClawPending(null),
                  () => void handleClawConfirmInstall(),
                  clawInstalling,
                  clawPending.overwrite,
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-muted-foreground/70">
        {t('skills:tap.clawhub.footer_hint')}
      </p>
    </div>
  );

  return (
    <section
      aria-label={t('skills:tap.title')}
      className={cn(
        'mb-4 rounded-lg border border-border/60 bg-[color:var(--surface-raised,transparent)]',
        className,
      )}
      data-testid="skill-tap-browser"
    >
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2.5">
        {tab === 'clawhub' ? (
          <Storefront size={16} className="flex-shrink-0 text-muted-foreground" />
        ) : (
          <GithubLogo size={16} className="flex-shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground">
            {tab === 'clawhub' ? t('skills:tap.clawhub.title') : t('skills:tap.title')}
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {tab === 'clawhub' ? t('skills:tap.clawhub.description') : t('skills:tap.description')}
          </p>
        </div>
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onClose}
          aria-label={t('common:actions.close')}
          className="h-7 w-7 flex-shrink-0"
        >
          <X size={14} />
        </NotionButton>
      </div>

      <div className="skill-tap-tabs" role="tablist" aria-label={t('skills:tap.title')}>
        {/* eslint-disable-next-line ds-components/no-native-button -- tab strip */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'github'}
          className="skill-tap-tab"
          onClick={() => setTab('github')}
          data-testid="skill-tap-tab-github"
        >
          <GithubLogo size={13} />
          {t('skills:tap.tab_github')}
        </button>
        {/* eslint-disable-next-line ds-components/no-native-button -- tab strip */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'clawhub'}
          className="skill-tap-tab"
          onClick={() => setTab('clawhub')}
          data-testid="skill-tap-tab-clawhub"
        >
          <Storefront size={13} />
          {t('skills:tap.tab_clawhub')}
        </button>
      </div>

      {tab === 'github' ? renderGithubPanel() : renderClawHubPanel()}
    </section>
  );
};

export default SkillTapBrowser;
