/**
 * 启动时自动更新弹窗通知
 *
 * 当 useAppUpdater 在启动静默检查中发现新版本时，
 * 以模态弹窗方式通知用户，提供：更新 / 忽略 / 跳过版本 / 不再提醒。
 */
import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Github, ArrowUpCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import {
  NotionDialog,
  NotionDialogHeader,
  NotionDialogTitle,
  NotionDialogDescription,
  NotionDialogBody,
  NotionDialogFooter,
} from '../ui/NotionDialog';
import { NotionButton } from '../ui/NotionButton';

interface UpdateNotificationDialogProps {
  open: boolean;
  /** 更新版本号 */
  version: string;
  /** 更新日志 (markdown) */
  body?: string;
  /** 发布日期 */
  date?: string;
  /** 是否移动端 */
  isMobile: boolean;
  /** 移动端 APK 下载地址 */
  apkUrl?: string;
  /** 是否正在下载 */
  downloading: boolean;
  /** 下载进度 0-100 */
  progress: number;
  /** 点击"更新" */
  onUpdate: () => void;
  /** 点击"忽略"（关闭弹窗，下次启动仍提醒） */
  onDismiss: () => void;
  /** 点击"跳过版本" */
  onSkipVersion: (version: string) => void;
  /** 点击"不再提醒" */
  onNeverRemind: () => void;
}

export const UpdateNotificationDialog: React.FC<UpdateNotificationDialogProps> = ({
  open,
  version,
  body,
  date,
  isMobile,
  apkUrl,
  downloading,
  progress,
  onUpdate,
  onDismiss,
  onSkipVersion,
  onNeverRemind,
}) => {
  const { t } = useTranslation('common');
  const [showNeverRemindConfirm, setShowNeverRemindConfirm] = useState(false);

  const handleNeverRemind = useCallback(() => {
    if (!showNeverRemindConfirm) {
      setShowNeverRemindConfirm(true);
      return;
    }
    onNeverRemind();
    setShowNeverRemindConfirm(false);
  }, [showNeverRemindConfirm, onNeverRemind]);

  const handleClose = useCallback(() => {
    setShowNeverRemindConfirm(false);
    onDismiss();
  }, [onDismiss]);

  // 格式化 release notes markdown
  const formattedBody = body
    ?.replace(/ (#{1,3} )/g, '\n\n$1')
    .replace(/ \* /g, '\n* ');

  return (
    <NotionDialog
      open={open}
      onOpenChange={(v) => { if (!v) handleClose(); }}
      maxWidth="max-w-md"
      closeOnOverlay={!downloading}
      showClose={!downloading}
    >
      <NotionDialogHeader>
        <div className="flex items-center gap-2.5">
          <ArrowUpCircle className="h-5 w-5 text-primary flex-shrink-0" />
          <NotionDialogTitle>
            {t('about.update.dialog.title', '有可用新版本')}
          </NotionDialogTitle>
        </div>
        <NotionDialogDescription>
          v{version}
          {date && (
            <span className="ml-2 text-muted-foreground/50">
              {new Date(date).toLocaleDateString()}
            </span>
          )}
        </NotionDialogDescription>
      </NotionDialogHeader>

      {formattedBody && (
        <NotionDialogBody className="max-h-[200px]">
          <div className="text-xs text-muted-foreground leading-relaxed release-notes-md">
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
                code: ({ children }) => <code className="px-1 py-0.5 rounded bg-muted text-[11px]">{children}</code>,
              }}
            >{formattedBody}</ReactMarkdown>
          </div>
        </NotionDialogBody>
      )}

      {/* 下载进度条 */}
      {downloading && progress > 0 && (
        <div className="px-5 pb-2">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 text-right">{progress}%</p>
        </div>
      )}

      <NotionDialogFooter className="flex-col items-stretch gap-3">
        {/* 主操作按钮行 */}
        <div className="flex items-center justify-end gap-2">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => onSkipVersion(version)}
            disabled={downloading}
            className="text-muted-foreground"
          >
            {t('about.update.dialog.skipVersion', '跳过版本')}
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleClose}
            disabled={downloading}
          >
            {t('about.update.dialog.ignore', '忽略')}
          </NotionButton>
          {isMobile ? (
            <div className="flex items-center gap-1.5">
              {apkUrl && (
                <a
                  href={apkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('about.update.mirrorDownload', '镜像下载')}
                </a>
              )}
              <a
                href="https://github.com/helixnow/deep-student/releases/latest"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary hover:underline"
              >
                <Github className="h-3.5 w-3.5" />
                {t('about.update.githubDownload', 'GitHub 下载')}
              </a>
            </div>
          ) : (
            <NotionButton
              variant="primary"
              size="sm"
              onClick={onUpdate}
              disabled={downloading}
            >
              <Download className={`h-3.5 w-3.5 mr-1 ${downloading ? 'animate-bounce' : ''}`} />
              {downloading
                ? t('about.update.downloading', '下载中...')
                : t('about.update.dialog.update', '更新')}
            </NotionButton>
          )}
        </div>

        {/* 不再提醒 */}
        <div className="flex items-center justify-start border-t border-border/30 pt-2 -mb-1">
          {showNeverRemindConfirm ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('about.update.dialog.neverRemindConfirm', '确定不再提醒？可在设置中重新开启')}</span>
              <NotionButton variant="ghost" size="sm" onClick={handleNeverRemind} className="text-xs h-6 px-2">
                {t('about.update.dialog.confirm', '确定')}
              </NotionButton>
              <NotionButton variant="ghost" size="sm" onClick={() => setShowNeverRemindConfirm(false)} className="text-xs h-6 px-2">
                {t('about.update.dialog.cancel', '取消')}
              </NotionButton>
            </div>
          ) : (
            <button
              onClick={handleNeverRemind}
              disabled={downloading}
              className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors disabled:opacity-50"
            >
              {t('about.update.dialog.neverRemind', '不再提醒')}
            </button>
          )}
        </div>
      </NotionDialogFooter>
    </NotionDialog>
  );
};
