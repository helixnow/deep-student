/**
 * SkillTapBrowser - Tap 技能源浏览对话框
 *
 * 输入 GitHub 仓库链接（tap 技能源），列出仓库内全部技能，
 * 单个技能走「装前扫描 → 风险确认 → 安装」的治理流程。
 * 已安装技能可通过管理页「检查更新」按 tap 来源复查上游漂移。
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GithubLogo, MagnifyingGlass, Package, CheckCircle, DownloadSimple } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import {
  NotionDialog,
  NotionDialogHeader,
  NotionDialogTitle,
  NotionDialogDescription,
  NotionDialogBody,
  NotionDialogFooter,
  NotionAlertDialog,
} from '../ui/NotionDialog';
import { showGlobalNotification } from '../UnifiedNotification';
import { skillRegistry, reloadSkills } from '@/features/chat/skills';
import {
  fetchTapCatalog,
  installTapSkill,
  type TapCatalog,
  type TapCatalogEntry,
  type SkillPackageScanResult,
} from '@/features/chat/skills/api';

// ============================================================================
// 常量
// ============================================================================

/** 最近使用的技能源（localStorage） */
const RECENT_TAPS_KEY = 'skills.tap.recent_sources';
const MAX_RECENT_TAPS = 8;

/** 预置技能源（社区常用 AgentSkills 目录仓库） */
const PRESET_TAPS: Array<{ label: string; url: string }> = [
  { label: 'anthropics/skills', url: 'https://github.com/anthropics/skills' },
];

const RISK_BADGE_CLASSES: Record<string, string> = {
  low: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  high: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

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

// ============================================================================
// 组件
// ============================================================================

export interface SkillTapBrowserProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const SkillTapBrowser: React.FC<SkillTapBrowserProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation(['skills', 'common']);

  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState<TapCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentTaps, setRecentTaps] = useState<string[]>(() => loadRecentTaps());
  // 装前确认（dry-run 扫描结果）
  const [pendingInstall, setPendingInstall] = useState<{
    entry: TapCatalogEntry;
    scan: SkillPackageScanResult;
    overwrite: boolean;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [scanningSubdir, setScanningSubdir] = useState<string | null>(null);
  // 本次会话内已安装的 subdir（用于按钮态即时更新）
  const [installedSubdirs, setInstalledSubdirs] = useState<Set<string>>(new Set());

  const handleBrowse = useCallback(async (targetUrl?: string) => {
    const repoUrl = (targetUrl ?? url).trim();
    if (!repoUrl) return;
    setLoading(true);
    setError(null);
    setCatalog(null);
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

  // 装前扫描（dry-run），成功后进入确认对话框
  const handleInstallClick = useCallback(async (entry: TapCatalogEntry) => {
    if (!catalog) return;
    const effectiveId = entry.skillId || entry.name;
    const overwrite = Boolean(effectiveId && skillRegistry.get(effectiveId));
    setScanningSubdir(entry.subdir);
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
      showGlobalNotification('error', t('skills:tap.scan_failed'), String(e));
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
      });
      await reloadSkills();
      setInstalledSubdirs((prev) => new Set(prev).add(pendingInstall.entry.subdir));
      showGlobalNotification(
        'success',
        t('skills:tap.install_success', { name: result.skill_id }),
        t('skills:tap.install_untrusted_hint'),
      );
      setPendingInstall(null);
    } catch (e) {
      showGlobalNotification('error', t('skills:tap.install_failed'), String(e));
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

  const renderInstallConfirm = () => {
    if (!pendingInstall) return null;
    const { scan, overwrite } = pendingInstall;
    const riskLevel = RISK_BADGE_CLASSES[scan.risk_level] ? scan.risk_level : 'low';
    const isHighRisk = riskLevel === 'high';
    return (
      <NotionAlertDialog
        open={true}
        onOpenChange={(next) => {
          if (!next) setPendingInstall(null);
        }}
        title={overwrite
          ? t('skills:management.import_confirm_overwrite_title')
          : t('skills:management.import_confirm_title')}
        description={t('skills:tap.install_confirm_source', {
          name: scan.skill_id,
          repo: catalog?.repoUrl ?? '',
        })}
        confirmText={overwrite
          ? t('skills:management.import_confirm_overwrite_install')
          : t('skills:management.import_confirm_install')}
        cancelText={t('common:actions.cancel')}
        confirmVariant={isHighRisk ? 'danger' : overwrite ? 'warning' : 'primary'}
        loading={installing}
        onConfirm={handleConfirmInstall}
        onCancel={() => setPendingInstall(null)}
        className="max-h-[85dvh] overflow-y-auto"
      >
        <div className="space-y-3">
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
        </div>
      </NotionAlertDialog>
    );
  };

  return (
    <>
      <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-2xl">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <GithubLogo size={18} />
            {t('skills:tap.title')}
          </NotionDialogTitle>
          <NotionDialogDescription>{t('skills:tap.description')}</NotionDialogDescription>
        </NotionDialogHeader>

        <NotionDialogBody className="py-4 space-y-3">
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
                <button
                  key={source.url}
                  type="button"
                  onClick={() => void handleBrowse(source.url)}
                  disabled={loading}
                  className="study-shell-badge inline-flex items-center gap-1 px-2 py-1 text-[11px] hover:bg-[var(--interactive-hover)] transition-colors cursor-pointer"
                >
                  <GithubLogo size={11} />
                  {source.label}
                </button>
              ))}
            </div>
          )}

          {error && (
            <p className="text-xs leading-relaxed text-red-600 dark:text-red-400 break-all">{error}</p>
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
                  return (
                    <div
                      key={entry.subdir || '__root__'}
                      className="flex items-start gap-3 rounded-md border border-border/40 px-3 py-2"
                    >
                      <Package size={16} className="mt-0.5 flex-shrink-0 text-muted-foreground/60" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium text-foreground truncate">{displayName}</span>
                          {entry.version && (
                            <span className="text-[10px] text-muted-foreground/70 flex-shrink-0">v{entry.version}</span>
                          )}
                        </div>
                        {entry.description && (
                          <p className="text-[11px] leading-relaxed text-muted-foreground line-clamp-2">
                            {entry.description}
                          </p>
                        )}
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground/60">
                          {entry.subdir && <span className="font-mono truncate">{entry.subdir}</span>}
                          <span className="flex-shrink-0">{t('skills:tap.file_count', { count: entry.fileCount })}</span>
                        </div>
                      </div>
                      <NotionButton
                        variant={installed ? 'ghost' : 'shell'}
                        size="sm"
                        onClick={() => void handleInstallClick(entry)}
                        disabled={scanningSubdir !== null}
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
                  );
                })}
              </div>
            </div>
          )}
        </NotionDialogBody>

        <NotionDialogFooter>
          <p className="mr-auto text-[10px] leading-relaxed text-muted-foreground/70">
            {t('skills:tap.footer_hint')}
          </p>
          <NotionButton variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="h-7 px-3 text-xs">
            {t('common:actions.close')}
          </NotionButton>
        </NotionDialogFooter>
      </NotionDialog>

      {renderInstallConfirm()}
    </>
  );
};

export default SkillTapBrowser;
