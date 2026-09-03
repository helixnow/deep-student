/**
 * SkillTapBrowser - Tap 技能源浏览面板（页面内嵌，非模态）
 *
 * 两个标签：
 * 1. GitHub：仓库链接 → catalog → 装前扫描 → 确认安装
 * 2. SkillMarket：搜索/trending → verify → download+scan → 确认 → install
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
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '../UnifiedNotification';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { skillRegistry, reloadSkills } from '@/features/chat/skills';
import {
  fetchTapCatalog,
  installTapSkill,
  skillMarketSearch,
  skillMarketVerify,
  skillMarketDownloadAndScan,
  type TapCatalog,
  type TapCatalogEntry,
  type SkillPackageScanResult,
  type SkillMarketSkillCard,
  type SkillMarketDownloadScanResult,
  type SkillMarketVerifyResult,
} from '@/features/chat/skills/api';
import {
  classifySkillMarketSearchError,
  resolveSkillMarketSearchSuccess,
  type SkillMarketListUiStatus,
} from '@/features/chat/skills/communitySkillsUi';
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

type SourceTab = 'github' | 'market';

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

function verifyBadgeKind(verify?: SkillMarketVerifyResult | null): 'ok' | 'fail' | 'pending' | 'unknown' {
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

  // —— SkillMarket state（empty / rate_limited / network_error / success 分通道）——
  const [marketQuery, setMarketQuery] = useState('');
  const [marketStatus, setMarketStatus] = useState<SkillMarketListUiStatus>('idle');
  const [marketErrorMessage, setMarketErrorMessage] = useState<string | null>(null);
  const [marketItems, setMarketItems] = useState<SkillMarketSkillCard[]>([]);
  const [nonSuspiciousOnly, setNonSuspiciousOnly] = useState(true);
  const marketLoading = marketStatus === 'loading';
  const [marketPending, setMarketPending] = useState<{
    card: SkillMarketSkillCard;
    result: SkillMarketDownloadScanResult;
    overwrite: boolean;
  } | null>(null);
  const [marketBusySlug, setMarketBusySlug] = useState<string | null>(null);
  const [marketInstalling, setMarketInstalling] = useState(false);
  const [marketInstalled, setMarketInstalled] = useState<Set<string>>(new Set());
  const marketRequestSeq = useRef(0);

  useEffect(() => () => {
    marketRequestSeq.current += 1;
  }, []);

  // Android 返回键：面板挂载（= 打开）期间注册 overlay handler，返回键先关本面板
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    return registerBackHandler(() => {
      // 保活守卫：skills-management 视图在被隐藏的保活层里仍保持挂载
      // （visibility:hidden），本面板也随之滞留——此时不消费返回键，
      // 交还给当前活跃视图（对照 EnhancedPdfViewer 的同款守卫）
      const el = rootRef.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      if (window.getComputedStyle(el).visibility === 'hidden') return false;
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
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

  // —— SkillMarket ——
  const loadSkillMarket = useCallback(async (query?: string) => {
    const requestSeq = ++marketRequestSeq.current;
    const q = (query ?? marketQuery).trim();
    setMarketStatus('loading');
    setMarketErrorMessage(null);
    setMarketPending(null);
    try {
      const result = await skillMarketSearch({
        q: q || undefined,
        limit: 24,
        nonSuspiciousOnly,
        sort: 'trending',
      });
      if (requestSeq !== marketRequestSeq.current) return;
      setMarketItems(result.items);
      setMarketStatus(resolveSkillMarketSearchSuccess(result.items));
    } catch (e) {
      if (requestSeq !== marketRequestSeq.current) return;
      setMarketItems([]);
      const kind = classifySkillMarketSearchError(e);
      setMarketStatus(kind);
      setMarketErrorMessage(
        kind === 'rate_limited'
          ? t('skills:tap.market.rate_limited')
          : t('skills:tap.market.network_error'),
      );
    }
  }, [marketQuery, nonSuspiciousOnly, t]);

  useEffect(() => {
    // 仅 idle 时自动拉取，避免 empty/error 被当成「未加载」反复请求
    if (tab === 'market' && marketStatus === 'idle') {
      void loadSkillMarket('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (tab !== 'market') return;
    // 切换 nonSuspiciousOnly 后刷新当前查询
    void loadSkillMarket(marketQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonSuspiciousOnly]);

  const handleMarketInstallClick = useCallback(async (card: SkillMarketSkillCard) => {
    setMarketBusySlug(card.slug);
    setMarketPending(null);
    try {
      // 1) verify
      const verify = await skillMarketVerify(card.slug, card.version || null);
      if (!verify.ok && verify.decision === 'fail') {
        showGlobalNotification(
          'error',
          verify.reasons.join('; ') || verify.securityStatus,
          t('skills:tap.market.verify_fail'),
        );
        // 仍允许用户看到失败徽章后自行决定；不自动中断扫描，但提示风险
      }
      // 2) download + scan
      const result = await skillMarketDownloadAndScan({
        slug: card.slug,
        version: card.version || verify.version || null,
        install: false,
        overwrite: true,
      });
      const overwrite = Boolean(skillRegistry.get(result.scan.skill_id));
      setMarketPending({
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
      const kind = classifySkillMarketSearchError(e);
      showGlobalNotification(
        'error',
        kind === 'rate_limited'
          ? t('skills:tap.market.rate_limited')
          : t('skills:tap.market.network_error'),
        t('skills:tap.market.scan_failed'),
      );
    } finally {
      setMarketBusySlug(null);
    }
  }, [t]);

  const handleClawConfirmInstall = useCallback(async () => {
    if (!marketPending) return;
    setMarketInstalling(true);
    try {
      const tempZipPath = marketPending.result.tempZipPath;
      if (!tempZipPath) {
        throw new Error('Confirmed SkillMarket scan artifact is missing; scan again');
      }
      const result = await skillMarketDownloadAndScan({
        slug: marketPending.card.slug,
        version: marketPending.result.version || marketPending.card.version || null,
        install: true,
        overwrite: marketPending.overwrite,
        expectedPackageSha256: marketPending.result.scan.package_sha256,
        tempZipPath,
        declaredRiskLevel: marketPending.result.scan.risk_level,
      });
      await reloadSkills();
      setMarketInstalled((prev) => new Set(prev).add(marketPending.card.slug));
      // 市场 verify≠本地 trust：安装成功后明确提示默认未信任
      showGlobalNotification(
        'success',
        t('skills:tap.install_untrusted_hint'),
        t('skills:tap.market.install_success', { name: result.scan.skill_id }),
      );
      setMarketPending(null);
    } catch (e) {
      const kind = classifySkillMarketSearchError(e);
      showGlobalNotification(
        'error',
        kind === 'rate_limited'
          ? t('skills:tap.market.rate_limited')
          : t('skills:tap.market.network_error'),
        t('skills:tap.market.install_failed'),
      );
    } finally {
      setMarketInstalling(false);
    }
  }, [marketPending, t]);

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
          <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs">
            {t('skills:package.permission_files', { count: scan.files_extracted })}
          </span>
          <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs">
            {t('skills:management.import_scan_scripts', { count: scan.scripts_count })}
          </span>
          <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs">
            {t('skills:management.import_scan_tools', { count: scan.allowed_tools_count })}
          </span>
          {scan.package_sha256 && (
            <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-2xs">
              sha256:{scan.package_sha256.slice(0, 12)}
            </span>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t('skills:management.risk_heading')}
            </span>
            <span className={cn('rounded-full px-1.5 py-0.5 text-2xs font-medium', RISK_BADGE_CLASSES[riskLevel])}>
              {t(`skills:management.risk_${riskLevel}`, scan.risk_level)}
            </span>
          </div>
          {riskLevel !== 'low' && scan.risk_signals.length > 0 && (
            <ul className="space-y-0.5">
              {scan.risk_signals.map((signal) => (
                <li key={signal} className="text-xs leading-relaxed text-muted-foreground">
                  · {t(`skills:management.risk_signal_${signal}`, signal)}
                </li>
              ))}
            </ul>
          )}
          {isHighRisk && (
            <p className="text-xs leading-relaxed text-red-600 dark:text-red-400">
              {t('skills:management.risk_high_warning')}
            </p>
          )}
          {overwrite && (
            <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
              {t('skills:management.import_confirm_overwrite_hint')}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            className="max-lg:!h-11 h-7 [@media(pointer:coarse)]:!min-h-11 px-2.5 text-xs"
          >
            {t('common:actions.cancel')}
          </DsButton>
          <DsButton
            variant={isHighRisk ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
            className="max-lg:!h-11 h-7 [@media(pointer:coarse)]:!min-h-11 px-2.5 text-xs"
          >
            {busy
              ? t('skills:tap.installing')
              : overwrite
                ? t('skills:management.import_confirm_overwrite_install')
                : t('skills:management.import_confirm_install')}
          </DsButton>
        </div>
      </div>
    );
  };

  const renderVerifyBadge = (verify?: SkillMarketVerifyResult | null) => {
    const kind = verifyBadgeKind(verify);
    const label =
      kind === 'ok'
        ? t('skills:tap.market.verify_ok')
        : kind === 'fail'
          ? t('skills:tap.market.verify_fail')
          : kind === 'pending'
            ? t('skills:tap.market.verify_pending')
            : t('skills:tap.market.verify_unknown');
    const security = verify?.securityStatus;
    const securityHint =
      security === 'clean'
        ? t('skills:tap.market.security_clean')
        : security === 'suspicious'
          ? t('skills:tap.market.security_suspicious')
          : security === 'malicious'
            ? t('skills:tap.market.security_malicious')
            : undefined;
    // 市场审核徽章 ≠ 本地 trust；title 明确二者正交，避免「已通过」被读成「已信任」
    const title = [securityHint, t('skills:tap.market.verify_not_trust_hint')]
      .filter(Boolean)
      .join(' · ');
    return (
      <span
        className={cn('skill-market-verify-badge', `skill-market-verify-badge--${kind}`)}
        title={title}
        aria-label={`${label}. ${t('skills:tap.market.verify_not_trust_hint')}`}
        data-testid="skill-market-verify-badge"
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
            className="h-8 max-lg:h-11 [@media(pointer:coarse)]:!h-11 pl-8 pr-3 text-xs"
          />
        </div>
        <DsButton
          variant="primary"
          size="sm"
          onClick={() => void handleBrowse()}
          disabled={loading || !url.trim()}
          className="max-lg:!h-11 [@media(pointer:coarse)]:!min-h-11 h-8 px-3 text-xs"
        >
          {loading ? t('skills:tap.browsing') : t('skills:tap.browse')}
        </DsButton>
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
              className="study-shell-badge inline-flex cursor-pointer items-center gap-1 px-2 py-1 [@media(pointer:coarse)]:!min-h-11 text-xs transition-colors hover:bg-[var(--interactive-hover)]"
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
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
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
                        <span className="truncate text-ui font-medium text-foreground">{displayName}</span>
                        {entry.version && (
                          <span className="flex-shrink-0 text-2xs text-muted-foreground/70">v{entry.version}</span>
                        )}
                      </div>
                      {entry.description && (
                        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {entry.description}
                        </p>
                      )}
                      <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted-foreground/60">
                        {entry.subdir && <span className="truncate font-mono">{entry.subdir}</span>}
                        <span className="flex-shrink-0">{t('skills:tap.file_count', { count: entry.fileCount })}</span>
                      </div>
                    </div>
                    <DsButton
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
                      className="max-lg:!h-11 h-7 [@media(pointer:coarse)]:!min-h-11 flex-shrink-0 px-2.5 text-xs"
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
                    </DsButton>
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

      <p className="text-2xs leading-relaxed text-muted-foreground/70">
        {t('skills:tap.footer_hint')}
      </p>
    </div>
  );

  const renderSkillMarketPanel = () => (
    <div className="space-y-3 p-3" data-testid="skill-market-panel">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlass
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50"
            aria-hidden="true"
          />
          <Input
            value={marketQuery}
            onChange={(e) => setMarketQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void loadSkillMarket();
            }}
            placeholder={t('skills:tap.market.search_placeholder')}
            aria-label={t('skills:tap.market.search_placeholder')}
            className="h-8 max-lg:h-11 [@media(pointer:coarse)]:!h-11 pl-8 pr-3 text-xs"
            data-testid="skill-market-search-input"
          />
        </div>
        <DsButton
          variant="primary"
          size="sm"
          onClick={() => void loadSkillMarket()}
          disabled={marketLoading}
          className="max-lg:!h-11 [@media(pointer:coarse)]:!min-h-11 h-8 px-3 text-xs"
          data-testid="skill-market-search-btn"
          aria-busy={marketLoading || undefined}
        >
          {marketLoading ? t('skills:tap.market.searching') : t('skills:tap.market.search')}
        </DsButton>
      </div>

      <div className="skill-market-filter-row">
        {/* 触屏：13px checkbox + 11px 文案不足触控标准，label 整体升到 44px 命中高度 */}
        <label className="[@media(pointer:coarse)]:!min-h-11">
          <input
            type="checkbox"
            checked={nonSuspiciousOnly}
            onChange={(e) => setNonSuspiciousOnly(e.target.checked)}
            data-testid="skill-market-non-suspicious"
          />
          {t('skills:tap.market.non_suspicious_only')}
        </label>
        <span className="text-2xs text-muted-foreground/60">
          {t('skills:tap.market.trending')}
        </span>
      </div>

      {marketStatus === 'loading' && marketItems.length === 0 && (
        <div
          className="py-6 text-center text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          data-testid="skill-market-loading"
        >
          {t('skills:tap.market.searching')}
        </div>
      )}

      {marketStatus === 'empty' && (
        <div
          className="py-6 text-center text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          data-testid="skill-market-empty"
        >
          {t('skills:tap.market.empty')}
        </div>
      )}

      {(marketStatus === 'rate_limited' || marketStatus === 'network_error') && marketErrorMessage && (
        <p
          className="break-all text-xs leading-relaxed text-red-600 dark:text-red-400"
          role="alert"
          aria-live="assertive"
          data-testid={marketStatus === 'rate_limited' ? 'skill-market-rate-limited' : 'skill-market-network-error'}
          data-skill-market-status={marketStatus}
        >
          {marketErrorMessage}
        </p>
      )}

      {marketStatus === 'success' && marketItems.length > 0 && (
        <div className="space-y-1" role="list" data-testid="skill-market-results" aria-live="polite">
          {marketItems.map((card) => {
            const installed = marketInstalled.has(card.slug) || Boolean(skillRegistry.get(card.slug));
            const isConfirming = marketPending?.card.slug === card.slug;
            const busy = marketBusySlug === card.slug;
            return (
              <div
                key={card.slug}
                role="listitem"
                className="rounded-md border border-border/40 px-3 py-2"
                data-testid={`skill-market-card-${card.slug}`}
              >
                <div className="flex items-start gap-3">
                  <Package size={16} className="mt-0.5 flex-shrink-0 text-muted-foreground/60" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-ui font-medium text-foreground">
                        {card.displayName || card.slug}
                      </span>
                      <span className="font-mono text-2xs text-muted-foreground/70">{card.slug}</span>
                      {card.version && (
                        <span className="flex-shrink-0 text-2xs text-muted-foreground/70">v{card.version}</span>
                      )}
                      {renderVerifyBadge(card.verify)}
                    </div>
                    {card.summary && (
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {card.summary}
                      </p>
                    )}
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground/60">
                      {card.ownerHandle && (
                        <span>{t('skills:tap.market.owner', { handle: card.ownerHandle })}</span>
                      )}
                      <span>{t('skills:tap.market.downloads', { count: card.downloads })}</span>
                    </div>
                  </div>
                  <DsButton
                    variant={installed ? 'ghost' : 'shell'}
                    size="sm"
                    onClick={() => {
                      if (isConfirming) {
                        setMarketPending(null);
                      } else {
                        void handleMarketInstallClick(card);
                      }
                    }}
                    disabled={marketBusySlug !== null || marketInstalling}
                    className="max-lg:!h-11 h-7 [@media(pointer:coarse)]:!min-h-11 flex-shrink-0 px-2.5 text-xs"
                    data-testid={`skill-market-install-${card.slug}`}
                  >
                    {busy ? (
                      t('skills:tap.market.scanning')
                    ) : installed ? (
                      <>
                        <CheckCircle size={13} className="mr-1 text-green-600 dark:text-green-400" />
                        {t('skills:tap.market.reinstall')}
                      </>
                    ) : (
                      <>
                        <DownloadSimple size={13} className="mr-1" />
                        {t('skills:tap.market.install')}
                      </>
                    )}
                  </DsButton>
                </div>
                {isConfirming && marketPending && renderRiskConfirm(
                  marketPending.result.scan,
                  t('skills:tap.market.install_confirm_source', {
                    name: marketPending.result.scan.skill_id,
                    slug: marketPending.card.slug,
                    version: marketPending.result.version,
                  }),
                  () => setMarketPending(null),
                  () => void handleClawConfirmInstall(),
                  marketInstalling,
                  marketPending.overwrite,
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-2xs leading-relaxed text-muted-foreground/70">
        {t('skills:tap.market.footer_hint')}
      </p>
    </div>
  );

  return (
    <section
      ref={rootRef}
      aria-label={t('skills:tap.title')}
      className={cn(
        'mb-4 rounded-lg border border-border/60 bg-[color:var(--surface-raised,transparent)]',
        className,
      )}
      data-testid="skill-tap-browser"
    >
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2.5">
        {tab === 'market' ? (
          <Storefront size={16} className="flex-shrink-0 text-muted-foreground" />
        ) : (
          <GithubLogo size={16} className="flex-shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium text-foreground">
            {tab === 'market' ? t('skills:tap.market.title') : t('skills:tap.title')}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {tab === 'market' ? t('skills:tap.market.description') : t('skills:tap.description')}
          </p>
        </div>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onClose}
          aria-label={t('common:actions.close')}
          className="h-7 w-7 flex-shrink-0 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
        >
          <X size={14} />
        </DsButton>
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
          aria-selected={tab === 'market'}
          className="skill-tap-tab"
          onClick={() => setTab('market')}
          data-testid="skill-tap-tab-market"
        >
          <Storefront size={13} />
          {t('skills:tap.tab_market')}
        </button>
      </div>

      {tab === 'github' ? renderGithubPanel() : renderSkillMarketPanel()}
    </section>
  );
};

export default SkillTapBrowser;
