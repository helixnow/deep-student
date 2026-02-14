import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, Github, Bug, Shield, ExternalLink, RefreshCw, Download } from 'lucide-react';
import { OpenSourceAcknowledgementsSection } from './OpenSourceAcknowledgementsSection';
import { SiliconFlowLogo } from '../ui/SiliconFlowLogo';
import { NotionButton } from '../ui/NotionButton';
import pkgJson from '../../../package.json';
import { SettingSection } from './SettingsCommon';
import { PrivacyPolicyDialog } from '../legal/PrivacyPolicyDialog';
import VERSION_INFO from '../../version';
import { useAppUpdater } from '../../hooks/useAppUpdater';

const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

const SettingRow = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <div className="group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors overflow-hidden">
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="flex-shrink-0">
      {children}
    </div>
  </div>
);

const LinkRow = ({
  icon: Icon,
  label,
  href,
}: {
  icon: React.FC<{ className?: string }>;
  label: string;
  href: string;
}) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="group flex items-center gap-3 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors"
  >
    <Icon className="h-4 w-4 text-muted-foreground/70 group-hover:text-primary transition-colors flex-shrink-0" />
    <span className="text-sm text-foreground/90 group-hover:text-primary transition-colors">{label}</span>
    <ExternalLink className="h-3 w-3 text-muted-foreground/40 group-hover:text-primary/60 transition-colors ml-auto" />
  </a>
);

export const AboutTab: React.FC = () => {
  const { t } = useTranslation(['common', 'settings']);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);
  const updater = useAppUpdater();

  return (
    <div className="space-y-1 pb-10 text-left animate-in fade-in duration-500">
      <SettingSection title="" hideHeader className="overflow-visible">
        <div>
          <GroupTitle title={t('acknowledgements.partners.title', '技术合作伙伴致谢')} />
          <div className="relative p-4 rounded-lg bg-muted/30 hover:bg-muted/40 transition-colors">
            <h4 className="text-sm font-medium text-foreground/90 mb-1.5">
              {t('acknowledgements.partners.cards.siliconflow.title', 'SiliconFlow')}
            </h4>
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed mb-6 max-w-md">
              {t('acknowledgements.partners.cards.siliconflow.description', '提供多模态与推理模型服务，保障 DeepStudent 在国产算力生态中的高效稳定运行。')}
            </p>
            <SiliconFlowLogo
              alt={t('acknowledgements.partners.cards.siliconflow.alt', 'Powered by SiliconFlow')}
              className="absolute bottom-3 right-3 h-7 w-auto opacity-60"
            />
          </div>
        </div>

        <div className="mt-8">
          <OpenSourceAcknowledgementsSection />
        </div>

        <div className="mt-8">
          <GroupTitle title={t('acknowledgements.developer.title', '开发信息')} />
          <div className="space-y-px">
            <SettingRow title={t('acknowledgements.developer.fields.developer', '开发者')}>
              <span className="text-sm text-foreground/90">DeepStudent Team</span>
            </SettingRow>
            <SettingRow title={t('acknowledgements.developer.fields.version', '版本')}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-foreground/90">
                  {VERSION_INFO.FULL_VERSION}
                  <span className="text-muted-foreground/50 ml-1.5 text-xs">{VERSION_INFO.GIT_HASH}</span>
                </span>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={() => updater.checkForUpdate(false)}
                  disabled={updater.checking}
                  className="h-6 px-2 text-xs"
                >
                  <RefreshCw className={`h-3 w-3 mr-1 ${updater.checking ? 'animate-spin' : ''}`} />
                  {updater.checking
                    ? t('about.update.checking', '检查中...')
                    : t('about.update.check', '检查更新')}
                </NotionButton>
              </div>
            </SettingRow>

            {/* 已是最新版本提示 */}
            {updater.upToDate && !updater.available && (
              <div className="mx-1 p-2 rounded-lg bg-green-500/5 border border-green-500/20">
                <p className="text-xs text-green-600 dark:text-green-400">
                  ✓ {t('about.update.upToDate', '已是最新版本')}
                </p>
              </div>
            )}

            {/* 更新可用提示 */}
            {updater.available && updater.info && (
              <div className="mx-1 p-3 rounded-lg bg-primary/5 border border-primary/20">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {t('about.update.available', '发现新版本')}: v{updater.info.version}
                    </p>
                    {updater.info.body && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{updater.info.body}</p>
                    )}
                  </div>
                  {updater.isMobile ? (
                    <a
                      href={`https://github.com/000haoji/deep-student/releases/latest`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-3 flex-shrink-0 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t('about.update.goToGithub', '前往下载')}
                    </a>
                  ) : (
                    <NotionButton
                      size="sm"
                      onClick={() => updater.downloadAndInstall()}
                      disabled={updater.downloading}
                      className="ml-3 flex-shrink-0"
                    >
                      <Download className={`h-3.5 w-3.5 mr-1 ${updater.downloading ? 'animate-bounce' : ''}`} />
                      {updater.downloading
                        ? t('about.update.downloading', '下载中...')
                        : t('about.update.install', '下载更新')}
                    </NotionButton>
                  )}
                </div>
                {!updater.isMobile && updater.downloading && updater.progress > 0 && (
                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${updater.progress}%` }} />
                  </div>
                )}
              </div>
            )}

            {/* 更新错误提示 */}
            {updater.error && (
              <div className="mx-1 p-2 rounded-lg bg-destructive/5 border border-destructive/20">
                <p className="text-xs text-destructive">{updater.error}</p>
              </div>
            )}
            <SettingRow title={t('acknowledgements.developer.fields.license', '许可证')}>
              <span className="text-sm text-foreground/90">AGPL-3.0-or-later</span>
            </SettingRow>
            <SettingRow title={t('acknowledgements.developer.fields.platforms', '平台支持')}>
              <span className="text-sm text-foreground/90">
                {t('acknowledgements.developer.values.platforms', 'Windows / macOS / iPadOS / Android')}
              </span>
            </SettingRow>
          </div>
        </div>

        <div className="mt-8">
          <GroupTitle title={t('acknowledgements.links.title', '官方链接')} />
          <div className="space-y-px">
            {[
              { icon: Globe, label: t('acknowledgements.links.website', '访问官网'), href: 'https://www.deepstudent.com' },
              { icon: Github, label: t('acknowledgements.links.github', 'GitHub'), href: 'https://github.com/000haoji/deep-student' },
              { icon: Bug, label: t('acknowledgements.links.issues', 'Issue 反馈'), href: 'https://github.com/000haoji/deep-student/issues' },
            ].map((item) => (
              <LinkRow key={item.href} icon={item.icon} label={item.label} href={item.href} />
            ))}
            {/* 应用内隐私政策（合规要求） */}
            <NotionButton
              variant="ghost"
              onClick={() => setShowPrivacyPolicy(true)}
              className="group flex h-auto w-full items-center gap-3 py-2.5 px-1 text-left hover:bg-muted/30 rounded"
            >
              <Shield className="h-4 w-4 text-muted-foreground/70 group-hover:text-primary transition-colors flex-shrink-0" />
              <span className="text-sm text-foreground/90 group-hover:text-primary transition-colors">
                {t('legal.settingsSection.viewPrivacyPolicy', '查看隐私政策')}
              </span>
            </NotionButton>
          </div>
        </div>
      </SettingSection>

      {/* 隐私政策弹窗 */}
      <PrivacyPolicyDialog open={showPrivacyPolicy} onOpenChange={setShowPrivacyPolicy} />
    </div>
  );
};

export default AboutTab;
