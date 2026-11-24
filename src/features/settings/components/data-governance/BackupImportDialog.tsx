import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Upload } from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import {
  DsDialog,
  DsDialogBody,
  DsDialogDescription,
  DsDialogFooter,
  DsDialogHeader,
  DsDialogTitle,
} from '@/components/ui/DsDialog';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { isWebUiShell } from '@/utils/platform';
import {
  formatTimestamp,
  type BackupInfoResponse,
} from '@/types/dataGovernance';
import { localizeCloudStorageError, notifyErrorDeduped } from './localizeCloudError';

export interface BackupImportOutcome {
  success?: boolean;
  error?: string;
  cancelled?: boolean;
}

export function isPreRestoreSafetySnapshot(
  backup: Pick<BackupInfoResponse, 'path'>
): boolean {
  return /(?:^|[._/-])pre[_-]?restore\b|\.pre_restore|safety[_-]?snapshot/i.test(
    backup.path
  );
}

export function buildSnapshotAriaLabelMap(
  backups: readonly Pick<BackupInfoResponse, 'path' | 'created_at'>[]
): Map<string, string> {
  const formattedList = backups.map((backup) => ({
    path: backup.path,
    time: formatTimestamp(backup.created_at),
  }));
  const counts = new Map<string, number>();
  for (const item of formattedList) {
    counts.set(item.time, (counts.get(item.time) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const item of formattedList) {
    const label =
      (counts.get(item.time) ?? 0) > 1
        ? `${item.time} (${item.path.slice(-6)})`
        : item.time;
    labels.set(item.path, label);
  }
  return labels;
}

interface BackupImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resumeImportJobId?: string | null;
  onImportZip: (
    password?: string,
    filePath?: string
  ) => void | Promise<BackupImportOutcome | void>;
  onResumeJob?: (
    jobId: string,
    password?: string
  ) => void | Promise<BackupImportOutcome | void>;
}

export const BackupImportDialog: React.FC<BackupImportDialogProps> = ({
  open,
  onOpenChange,
  resumeImportJobId = null,
  onImportZip,
  onResumeJob,
}) => {
  const { t, i18n } = useTranslation(['data', 'common']);
  const [importPassword, setImportPassword] = useState('');
  const [importFilePath, setImportFilePath] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [importFileError, setImportFileError] = useState<string | null>(null);
  const [importPasswordError, setImportPasswordError] = useState<string | null>(null);
  const [isImportingSubmitting, setIsImportingSubmitting] = useState(false);
  const [isStagingImportFile, setIsStagingImportFile] = useState(false);
  const webUiMode = isWebUiShell();

  const resetImportDialogState = () => {
    setImportPassword('');
    setImportFilePath('');
    setImportFileName('');
    setImportFileError(null);
    setImportPasswordError(null);
    setIsImportingSubmitting(false);
    setIsStagingImportFile(false);
  };

  const handleStageWebImportFile = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportFileError(null);
    setIsStagingImportFile(true);
    try {
      const response = await fetch(
        `/api/files/stage?name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
          credentials: 'same-origin',
        }
      );
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        path?: string;
        name?: string;
        size?: number;
      };
      if (!data.path) {
        throw new Error('Missing staged file path');
      }
      setImportFilePath(data.path);
      setImportFileName(data.name || file.name);
      setImportFileError(null);
    } catch (error) {
      setImportFileError(
        t('data:governance.import_file_upload_failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    } finally {
      setIsStagingImportFile(false);
    }
  };

  const handleImportConfirm = async () => {
    if (isImportingSubmitting) return;
    if (resumeImportJobId && importPassword === '') {
      const requiredMsg = t('data:governance.import_sealed_password_required');
      setImportPasswordError(requiredMsg);
      showGlobalNotification('warning', requiredMsg);
      return;
    }
    if (!resumeImportJobId && webUiMode && !importFilePath.trim()) {
      setImportFileError(t('data:governance.import_file_required'));
      return;
    }
    const pwd = importPassword || undefined;
    const explicitPath = importFilePath.trim();
    setImportPasswordError(null);
    setIsImportingSubmitting(true);
    try {
      const outcome = resumeImportJobId
        ? await onResumeJob?.(resumeImportJobId, importPassword)
        : explicitPath
          ? await onImportZip(pwd, explicitPath)
          : await onImportZip(pwd);
      if (outcome && outcome.success === false) {
        if (!outcome.cancelled) {
          const inlineMsg =
            outcome.error || t('data:governance.import_decrypt_failed_inline');
          setImportPasswordError(inlineMsg);
          notifyErrorDeduped('error', inlineMsg);
        }
        return;
      }
      resetImportDialogState();
      onOpenChange(false);
    } catch (error: unknown) {
      const msg =
        localizeCloudStorageError(error, t, i18n?.language) ||
        t('data:governance.import_decrypt_failed_inline');
      setImportPasswordError(msg);
      notifyErrorDeduped('error', msg);
    } finally {
      setIsImportingSubmitting(false);
    }
  };

  return (
    <DsDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetImportDialogState();
          onOpenChange(false);
        }
      }}
      maxWidth="max-w-md"
    >
      <DsDialogHeader>
        <DsDialogTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5 text-primary" />
          {t(
            resumeImportJobId
              ? 'data:governance.resume_import_password_title'
              : 'data:governance.import_password_title'
          )}
        </DsDialogTitle>
        <DsDialogDescription>
          {t(
            resumeImportJobId
              ? 'data:governance.resume_import_password_desc'
              : 'data:governance.import_password_desc'
          )}
        </DsDialogDescription>
      </DsDialogHeader>
      <DsDialogBody
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void handleImportConfirm();
          }
        }}
      >
        <div className="space-y-3">
          {webUiMode && !resumeImportJobId && (
            <div className="space-y-1.5">
              <Label htmlFor="webui-import-file" className="text-sm">
                {t('data:governance.import_file_label')}
              </Label>
              <input
                id="webui-import-file"
                type="file"
                accept=".zip,.dsbk"
                disabled={isStagingImportFile}
                onChange={(e) => void handleStageWebImportFile(e)}
                className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-lg file:border file:border-border/70 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/80"
              />
              <Input
                id="webui-import-file-path"
                type="text"
                className="h-8 text-sm font-mono"
                value={importFilePath}
                placeholder={t('data:governance.import_file_path_placeholder')}
                onChange={(e) => {
                  setImportFilePath(e.target.value);
                  if (importFileError) setImportFileError(null);
                }}
              />
              {isStagingImportFile && (
                <p className="text-xs text-muted-foreground">
                  {t('data:governance.import_file_uploading')}
                </p>
              )}
              {importFileName && !importFileError && !isStagingImportFile && (
                <p className="text-xs text-success">
                  {t('data:governance.import_file_selected', {
                    name: importFileName,
                  })}
                </p>
              )}
              {importFileError && (
                <p role="alert" className="text-xs text-destructive">
                  {importFileError}
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="e2ee-import-password" className="text-sm">
              {t('data:governance.import_password_label')}
            </Label>
            <Input
              id="e2ee-import-password"
              type="password"
              autoComplete="current-password"
              className="h-8 text-sm"
              value={importPassword}
              placeholder={t('data:governance.import_password_placeholder')}
              required={resumeImportJobId !== null}
              disabled={isImportingSubmitting}
              onChange={(e) => {
                setImportPassword(e.target.value);
                if (importPasswordError) setImportPasswordError(null);
              }}
            />
            {importPasswordError && (
              <p role="alert" className="text-xs text-destructive">
                {importPasswordError}
              </p>
            )}
          </div>
        </div>
      </DsDialogBody>
      <DsDialogFooter>
        <DsButton
          variant="ghost"
          size="sm"
          disabled={isImportingSubmitting}
          onClick={() => {
            resetImportDialogState();
            onOpenChange(false);
          }}
        >
          {t('common:actions.cancel')}
        </DsButton>
        <DsButton
          variant="primary"
          size="sm"
          disabled={isStagingImportFile || isImportingSubmitting}
          onClick={() => void handleImportConfirm()}
        >
          {resumeImportJobId ? (
            <Play className="h-4 w-4 mr-1.5" />
          ) : (
            <Upload className="h-4 w-4 mr-1.5" />
          )}
          {t(
            resumeImportJobId
              ? 'data:governance.resume'
              : 'data:governance.import_button'
          )}
        </DsButton>
      </DsDialogFooter>
    </DsDialog>
  );
};
