import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield as PhosphorShield } from '@phosphor-icons/react';
import { Globe, GithubLogo, Bug, ArrowSquareOut, ArrowClockwise, Download } from '@phosphor-icons/react';
import { OpenSourceAcknowledgementsSection } from './OpenSourceAcknowledgementsSection';
import { SiliconFlowLogo } from '@/components/ui/SiliconFlowLogo';
import { DeepStudentLogo } from '@/components/ui/DeepStudentLogo';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/shad/Select';
import { SettingSection } from './SettingsCommon';
import { PrivacyPolicyDialog } from '@/components/legal/PrivacyPolicyDialog';
import VERSION_INFO from '@/version';
import { useAppUpdater, getUpdateChannel, setUpdateChannel, type UpdateChannel, getUpdateFrequency, setUpdateFrequency, type UpdateFrequency, getUpdateFrequencyDays, setUpdateFrequencyDays, getNoRemind, setNoRemind } from '@/hooks/useAppUpdater';
import ReactMarkdown from 'react-markdown';

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
  // 双栏切换点与 isSmallScreen（<768）对齐，避免 640-767px 移动模式下出现桌面双栏行
  <div className="group flex flex-col md:flex-row md:items-start gap-2 py-2.5 px-1 rounded overflow-hidden">
    <div className="flex-1 min-w-0 pt-1.5 md:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="min-w-0 max-w-full">
      {children}
    </div>
  </div>
);

const aboutActionRowClassName =
  'flex w-full items-center gap-3 rounded-[var(--button-radius)] px-2 py-2.5 text-left outline-none transition-[background-color] duration-150 ease-out hover:bg-[color:var(--sidebar-quiet-hover)] focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] motion-reduce:transition-none';

const aboutActionIconClassName =
  'h-4 w-4 flex-shrink-0 text-muted-foreground/70';

const aboutActionLabelClassName =
  'min-w-0 flex-1 text-sm text-foreground/90';

const aboutActionTrailingIconClassName =
  'ml-auto h-3 w-3 flex-shrink-0 text-muted-foreground/40';

type AboutActionRowProps = {
  icon: React.FC<{ className?: string }>;
  label: string;
  trailingIcon?: React.FC<{ className?: string }>;
} & (
  | {
      href: string;
      onClick?: never;
    }
  | {
      href?: never;
      onClick: () => void;
    }
);

const AboutActionRow = ({
  icon: Icon,
  label,
  href,
  onClick,
  trailingIcon: TrailingIcon,
}: AboutActionRowProps) => {
  const content = (
    <>
      <Icon className={aboutActionIconClassName} />
      <span className={aboutActionLabelClassName}>{label}</span>
      {TrailingIcon && <TrailingIcon className={aboutActionTrailingIconClassName} />}
    </>
  );

  if (href) {
    return (
      <a
        data-about-action-row
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={aboutActionRowClassName}
      >
        {content}
      </a>
    );
  }

  return (
    // eslint-disable-next-line ds-components/no-native-button -- This row primitive needs anchor/button parity while keeping native button semantics.
    <button
      data-about-action-row
      type="button"
      onClick={onClick}
      className={aboutActionRowClassName}
    >
      {content}
    </button>
  );
};

export const AboutTab: React.FC = () => {
  const { t } = useTranslation(['common', 'settings']);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);
  const updater = useAppUpdater();
  const [channel, setChannel] = useState<UpdateChannel>(getUpdateChannel);
  const [frequency, setFrequencyState] = useState<UpdateFrequency>(getUpdateFrequency);
  const [frequencyDays, setFrequencyDaysState] = useState<number>(getUpdateFrequencyDays);
  const [noRemind, setNoRemindState] = useState<boolean>(getNoRemind);

  const handleChannelChange = useCallback((val: UpdateChannel) => {
    setUpdateChannel(val);
    setChannel(val);
  }, []);

  const handleFrequencyChange = useCallback((freq: UpdateFrequency) => {
    setUpdateFrequency(freq);
    setFrequencyState(freq);
    if (freq !== 'never') {
      setNoRemindState(false);
    }
  }, []);

  const handleFrequencyDaysChange = useCallback((days: number) => {
    const clamped = Math.max(1, Math.round(days));
    setUpdateFrequencyDays(clamped);
    setFrequencyDaysState(clamped);
  }, []);

  const handleResetNoRemind = useCallback(() => {
    setNoRemind(false);
    setNoRemindState(false);
    handleFrequencyChange('every_launch');
  }, [handleFrequencyChange]);

  return (
    <div className="space-y-1 pb-10 text-left ui-fade-in-slow">
      <SettingSection title="" hideHeader className="overflow-hidden">
        <div className="flex flex-col md:flex-row gap-6 py-6">
          <div className="flex flex-col items-center justify-center md:w-1/3 gap-5">
            <DeepStudentLogo className="w-44 max-w-full" />
            <div className="text-center">
              <p className="text-xs text-muted-foreground/70 mt-0.5">{VERSION_INFO.FULL_VERSION}</p>
            </div>
          </div>
          <div className="md:w-2/3">
            <GroupTitle title={t('acknowledgements.developer.title')} />
            <div className="space-y-px">
              <SettingRow title={t('acknowledgements.developer.fields.developer')}>
                <span className="text-sm text-foreground/90">DeepStudent Team</span>
              </SettingRow>
            <SettingRow title={t('acknowledgements.developer.fields.version')}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-foreground/90 whitespace-nowrap">
                  {VERSION_INFO.FULL_VERSION}
                  <span className="text-muted-foreground/50 ml-1.5 text-xs">{VERSION_INFO.GIT_HASH}</span>
                </span>
                <DsButton
                  variant="outline"
                  size="sm"
                  onClick={() => updater.checkForUpdate(false)}
                  disabled={updater.checking}
                  className="flex-shrink-0 whitespace-nowrap"
                >
                  <ArrowClockwise size={12} className={`mr-1 ${updater.checking ? 'animate-spin' : ''}`} />
                  {updater.checking
                    ? t('about.update.checking')
                    : t('about.update.check')}
                </DsButton>
              </div>
            </SettingRow>

            <SettingRow
              title={t('about.update.channel')}
              description={channel === 'experimental'
                ? t('about.update.channelExpDesc')
                : t('about.update.channelStableDesc')}
            >
              <Select value={channel} onValueChange={(val) => handleChannelChange(val as UpdateChannel)}>
                <SelectTrigger className="w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stable">{t('about.update.channelStable')}</SelectItem>
                  <SelectItem value="experimental">{t('about.update.channelExp')}</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              title={t('about.update.frequency')}
              description={noRemind
                ? t('about.update.frequencyNoRemindDesc')
                : frequency === 'never'
                  ? t('about.update.frequencyNeverDesc')
                  : frequency === 'every_n_days'
                    ? t('about.update.frequencyDaysDesc', { days: frequencyDays })
                    : t('about.update.frequencyLaunchDesc')}
            >
              <div className="flex items-center gap-1.5">
                {noRemind ? (
                  <DsButton
                    variant="outline"
                    size="sm"
                    onClick={handleResetNoRemind}
                  >
                    {t('about.update.frequencyReEnable')}
                  </DsButton>
                ) : (
                  <>
                    <Select value={frequency} onValueChange={(val) => handleFrequencyChange(val as UpdateFrequency)}>
                      <SelectTrigger className="w-auto">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="every_launch">{t('about.update.freqEveryLaunch')}</SelectItem>
                        <SelectItem value="every_n_days">{t('about.update.freqEveryNDays')}</SelectItem>
                        <SelectItem value="never">{t('about.update.freqNever')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {frequency === 'every_n_days' && (
                      <Input
                        type="number"
                        min={1}
                        max={365}
                        value={frequencyDays}
                        onChange={(e) => handleFrequencyDaysChange(Number(e.target.value))}
                        className="h-6 [@media(pointer:coarse)]:h-10 w-14 px-1.5 text-xs text-center min-h-0"
                      />
                    )}
                  </>
                )}
              </div>
            </SettingRow>

            {/* 已是最新版本提示 */}
            {updater.upToDate && !updater.available && (
              <div className="mx-1 p-2 rounded-lg bg-green-500/5 border border-green-500/20">
                <p className="text-xs text-green-600 dark:text-green-400">
                  ✓ {t('about.update.upToDate')}
                </p>
              </div>
            )}

            {/* 更新可用提示 */}
            {updater.available && updater.info && (
              <div className="mx-1 p-3 rounded-lg bg-primary/5 border border-primary/20 overflow-hidden">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {t('about.update.available')}: v{updater.info.version}
                    </p>
                    {updater.info.body && (() => {
                      const md = updater.info!.body!
                        .replace(/ (#{1,3} )/g, '\n\n$1')
                        .replace(/ \* /g, '\n* ');
                      return (
                      <div className="text-xs text-muted-foreground mt-1 overflow-hidden release-notes-md">
                        <ReactMarkdown
                          components={{
                            h1: ({ children }) => <h4 className="text-xs font-semibold text-foreground/90 mt-2 first:mt-0">{children}</h4>,
                            h2: ({ children }) => <h4 className="text-xs font-semibold text-foreground/90 mt-2 first:mt-0">{children}</h4>,
                            h3: ({ children }) => <h5 className="text-xs font-medium text-foreground/80 mt-1.5 first:mt-0">{children}</h5>,
                            p: ({ children }) => <p className="mt-0.5 break-words" style={{ overflowWrap: 'anywhere' }}>{children}</p>,
                            ul: ({ children }) => <ul className="mt-0.5 ml-3 list-disc space-y-0.5">{children}</ul>,
                            li: ({ children }) => <li className="break-words" style={{ overflowWrap: 'anywhere' }}>{children}</li>,
                            a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" style={{ overflowWrap: 'anywhere' }}>{children}</a>,
                            strong: ({ children }) => <strong className="font-semibold text-foreground/90">{children}</strong>,
                            code: ({ children }) => <code className="px-1 py-0.5 rounded bg-muted text-xs">{children}</code>,
                          }}
                        >{md}</ReactMarkdown>
                      </div>);
                    })()}
                  </div>
                  {updater.isMobile ? (
                    <div className="w-full sm:w-auto sm:ml-3 flex-shrink-0 flex flex-col gap-1.5">
                      {updater.info?.apkUrl && (
                        <a
                          href={updater.info.apkUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                        >
                          <Download size={14} />
                          {t('about.update.mirrorDownload')}
                        </a>
                      )}
                      <a
                        href={`https://github.com/helixnow/deep-student/releases/latest`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary hover:underline"
                      >
                        <GithubLogo size={14} />
                        {t('about.update.githubDownload')}
                      </a>
                    </div>
                  ) : (
                    <DsButton
                      size="sm"
                      variant="outline"
                      onClick={() => updater.downloadAndInstall()}
                      disabled={updater.downloading}
                      className="ml-3 flex-shrink-0"
                    >
                      <Download size={14} className={`mr-1 ${updater.downloading ? 'animate-bounce' : ''}`} />
                      {updater.downloading
                        ? t('about.update.downloading')
                        : t('about.update.install')}
                    </DsButton>
                  )}
                </div>
                {!updater.isMobile && updater.downloading && updater.progress > 0 && (
                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${updater.progress}%` }} />
                  </div>
                )}
                {!updater.downloading && (
                  <div className="mt-2">
                    <DsButton
                      variant="outline"
                      size="sm"
                      onClick={() => updater.skipVersion(updater.info!.version)}
                    >
                      {t('about.update.dialog.skipVersion')}
                    </DsButton>
                  </div>
                )}
              </div>
            )}

            {/* 更新错误提示 */}
            {updater.error && (
              <div className={`mx-1 p-2 rounded-lg border ${
                updater.error.phase === 'relaunch'
                  ? 'bg-amber-500/5 border-amber-500/20'
                  : 'bg-destructive/5 border-destructive/20'
              }`}>
                <p className={`text-xs ${
                  updater.error.phase === 'relaunch' ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'
                }`}>
                  {updater.error.phase === 'check' && `${t('about.update.error.check')}：`}
                  {updater.error.phase === 'download' && `${t('about.update.error.download')}：`}
                  {updater.error.phase === 'install' && `${t('about.update.error.install')}：`}
                  {updater.error.phase === 'unavailable' && t('about.update.error.unavailable')}
                  {updater.error.phase !== 'relaunch' && updater.error.phase !== 'unavailable' && updater.error.message}
                  {updater.error.phase === 'relaunch' && t('about.update.error.relaunch')}
                </p>
              </div>
            )}
            <SettingRow title={t('acknowledgements.developer.fields.license')}>
              <span className="text-sm text-foreground/90">AGPL-3.0-or-later</span>
            </SettingRow>
            <SettingRow title={t('acknowledgements.developer.fields.platforms')}>
              <span className="text-sm text-foreground/90">
                {t('acknowledgements.developer.values.platforms', 'Windows / macOS / iPadOS / Android')}
              </span>
            </SettingRow>
            </div>
          </div>
        </div>

        <div className="mt-8">
          <GroupTitle title={t('acknowledgements.links.title')} />
          <div className="space-y-px">
            {[
              { icon: Globe, label: t('acknowledgements.links.website'), href: 'https://www.deepstudent.cn' },
              { icon: GithubLogo, label: t('acknowledgements.links.github', 'GitHub'), href: 'https://github.com/helixnow/deep-student' },
              { icon: Bug, label: t('acknowledgements.links.issues'), href: 'https://github.com/helixnow/deep-student/issues' },
            ].map((item) => (
              <AboutActionRow
                key={item.href}
                icon={item.icon}
                label={item.label}
                href={item.href}
                trailingIcon={ArrowSquareOut}
              />
            ))}
            <AboutActionRow
              icon={PhosphorShield}
              label={t('legal.settingsSection.viewPrivacyPolicy')}
              onClick={() => setShowPrivacyPolicy(true)}
            />
          </div>
        </div>

        <div className="mt-8">
          <GroupTitle title={t('acknowledgements.partners.title')} />
          <div className="flex items-start justify-between gap-4 px-1 py-1.5">
            <div className="min-w-0 flex-1 max-w-3xl">
              <h4 className="text-sm font-medium text-foreground/90">
                {t('acknowledgements.partners.cards.siliconflow.title', 'SiliconFlow')}
              </h4>
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground/70">
                {t('acknowledgements.partners.cards.siliconflow.description')}
              </p>
            </div>
            <SiliconFlowLogo
              alt={t('acknowledgements.partners.cards.siliconflow.alt', 'Powered by SiliconFlow')}
              className="mt-0.5 h-6 w-auto shrink-0 opacity-65"
            />
          </div>
        </div>

        <div className="mt-8">
          <OpenSourceAcknowledgementsSection />
        </div>

      </SettingSection>

      {/* 隐私政策弹窗 */}
      <PrivacyPolicyDialog open={showPrivacyPolicy} onOpenChange={setShowPrivacyPolicy} />

    </div>
  );
};

export default AboutTab;
