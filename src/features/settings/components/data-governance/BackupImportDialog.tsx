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
import {
  isEnglishUiLanguage,
  localizeCloudStorageError,
  notifyErrorDeduped,
} from './localizeCloudError';

export interface BackupImportOutcome {
  success?: boolean;
  error?: string;
  cancelled?: boolean;
}

export type BackupImportErrorCategory =
  | 'path_traversal'
  | 'invalid_manifest'
  | 'password_required'
  | 'password_not_needed'
  | 'decrypt_failed'
  | 'corrupt_or_truncated_zip'
  | 'file_not_found'
  | 'permission_denied'
  | 'generic';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const PATH_TRAVERSAL_RE =
  /ZIP\s*包含越界或空路径|密封载荷包含越界或空路径|ZIP\s*包含不安全路径|目录遍历|路径越界|路径中不允许包含\s*['"]?\.\.['"]?|路径中不允许包含\s*null\s*字节|不允许包含符号链接|不允许符号链接|ZIP\s*路径包含换行符|密封载荷路径包含换行符|未加密\s*ZIP\s*禁止包含密钥或本地审计材料|发现越权条目|path[\s_-]*traversal|directory[\s_-]*traversal|zip[\s_-]*slip|unsafe\s+(?:archive\s+)?path|symbolic\s+link|symlink|\.\.[/\\]/i;

const INVALID_MANIFEST_RE =
  /解析清单失败|清单文件不存在|清单必须是普通文件|清单文件过大|解封后的原始清单无法解析|密封载荷缺少原始\s*manifest\.json|密封载荷未还原原始清单|manifest\s*v\d+\s*缺少|coverage\s+ledger|清单声明为加密全保真备份.*缺少密封载荷|但清单未声明\s*key_policy|未加密\s*ZIP\s*必须声明\s*key_policy|解封后的清单密钥策略无效|旧版\s*ZIP\s*未通过升级前严格验证|ZIP\s*包含清单未声明的文件|备份清单包含重复路径|完整快照缺少核心数据库|invalid[\s_-]+manifest|missing[\s_-]+manifest|manifest\.json.*(?:missing|invalid|corrupt|not\s+found|parse|failed|error|unexpected)|(?:missing|invalid|corrupt|bad)\s+(?:backup\s+)?manifest/i;

const PASSWORD_REQUIRED_RE =
  /E_BACKUP_SEALED_PASSWORD_REQUIRED|密码密封的敏感材料|请提供导出时设置的备份密码|断点续传必须携带.*备份密码|password\s+required\s+to\s+decrypt/i;

const PASSWORD_NOT_NEEDED_RE =
  /不是加密全保真备份.*无需提供备份密码|请去掉密码后重试导入|password\s+is\s+not\s+needed|not\s+password[- ]encrypted/i;

const DECRYPT_FAILED_RE =
  /E_BACKUP_SEALED_DECRYPT_FAILED|解封加密备份失败|无法解封备份中的敏感材料|备份密码错误|密封载荷损坏|密封载荷已损坏|incorrect\s+backup\s+password|wrong\s+(?:backup\s+)?password|decryption\s+failed|sealed\s+payload\s+is\s+corrupted|aead.*(?:decrypt|tag|auth)/i;

const RAW_DECRYPT_DIAGNOSTIC_RE =
  /E_BACKUP_SEALED_DECRYPT_FAILED|解封加密备份失败|ZIP\s*导入失败|decryptBackupFile|\baead\b/i;

const CORRUPT_OR_TRUNCATED_ZIP_RE =
  /ZIP\s+error:|无法读取\s*ZIP\s*文件|invalid\s+zip\s+header|could\s+not\s+find\s+(?:zip64\s+)?central\s+directory\s+end|file\s+cannot\s+contain\s+zip64|invalid\s+central\s+directory|central\s+directory\s+too\s+large|invalid\s+local\s+file\s+header|zip64\s+value\s+exceeds|truncated\s+raw\s+deflate|invalid\s+raw\s+deflate|unexpected\s+bytes\s+after\s+raw\s+deflate|failed\s+to\s+fill\s+whole\s+buffer|invalid\s+checksum|\bcrc(?:\s*32)?\s*(?:mismatch|error|failed|invalid)|ZIP\s*校验和不匹配|校验和(?:文件格式无效|格式无效|路径缺失或重复|文件未覆盖|条目必须是普通文件)|校验和不匹配|条目实际大小与中央目录不一致|密封载荷实际大小与中央目录不一致|密封载荷不是有效\s*ZIP|压缩比异常|总压缩比异常|解压总量超限|实际解压总量超限|文件数量超限|非空条目压缩大小为零|总压缩大小异常为零|compression\s+method\s+not\s+supported|multi-disk\s+files|unexpected\s+eof|truncated\s+(?:zip|archive|backup|file|stream)|corrupt(?:ed)?\s*(?:zip|archive|backup|file)|damaged\s+(?:zip|archive|backup)|not\s+a\s+valid\s+zip|bad\s+zip|invalid\s+zip|备份文件可能已损坏|压缩包.*损坏|归档.*损坏|数据库完整性检查失败/i;

const FILE_NOT_FOUND_RE =
  /ZIP\s*文件不存在|\bENOENT\b|no\s+such\s+file|file\s+not\s+found/i;

const PERMISSION_DENIED_RE =
  /\bEACCES\b|\bEPERM\b|permission\s+denied|权限不足/i;

function translateWithFallback(
  t: Translate,
  key: string,
  fallback: string,
): string {
  const translated = t(key, { defaultValue: fallback });
  if (!translated || translated === key) {
    return fallback;
  }
  return translated;
}

export function classifyBackupImportError(
  rawError: string | null | undefined,
): BackupImportErrorCategory {
  const trimmed = rawError?.trim() ?? '';
  if (!trimmed) return 'generic';
  if (PATH_TRAVERSAL_RE.test(trimmed)) return 'path_traversal';
  if (INVALID_MANIFEST_RE.test(trimmed)) return 'invalid_manifest';
  if (PASSWORD_REQUIRED_RE.test(trimmed)) return 'password_required';
  if (PASSWORD_NOT_NEEDED_RE.test(trimmed)) return 'password_not_needed';
  if (DECRYPT_FAILED_RE.test(trimmed)) return 'decrypt_failed';
  if (CORRUPT_OR_TRUNCATED_ZIP_RE.test(trimmed)) {
    return 'corrupt_or_truncated_zip';
  }
  if (FILE_NOT_FOUND_RE.test(trimmed)) return 'file_not_found';
  if (PERMISSION_DENIED_RE.test(trimmed)) return 'permission_denied';
  return 'generic';
}

export function formatBackupImportError(
  rawError: string | null | undefined,
  t: Translate,
  language?: string,
): { category: BackupImportErrorCategory; message: string } {
  const trimmed = rawError?.trim() ?? '';
  const english = isEnglishUiLanguage(language);
  const category = classifyBackupImportError(trimmed);

  switch (category) {
    case 'path_traversal':
      return {
        category,
        message: translateWithFallback(
          t,
          'data:governance.import_zip_path_traversal',
          english
            ? 'Unsafe backup ZIP rejected: archive contains path-traversal or disallowed entries. Your current data was not modified.'
            : '已拒绝导入不安全的备份 ZIP：归档包含目录遍历或非法路径条目。当前数据没有被改动。',
        ),
      };
    case 'invalid_manifest':
      return {
        category,
        message: translateWithFallback(
          t,
          'data:governance.import_zip_invalid_manifest',
          english
            ? 'Invalid or missing backup manifest (manifest.json). Your current data was not modified; please select a valid backup ZIP.'
            : '备份清单（manifest.json）缺失或格式无效。当前数据没有被改动；请选择有效的备份 ZIP 文件。',
        ),
      };
    case 'password_required':
      return {
        category,
        message: translateWithFallback(
          t,
          'data:governance.import_sealed_password_required',
          english
            ? 'This backup ZIP contains password-sealed sensitive material. Enter the backup password used during export and try again. Your current data was not changed.'
            : '这份备份 ZIP 含密码密封的敏感材料。请输入导出时设置的备份密码后重试；当前数据没有被改动。',
        ),
      };
    case 'password_not_needed':
      return {
        category,
        message: translateWithFallback(
          t,
          'data:governance.import_zip_password_not_needed',
          english
            ? 'This backup ZIP is not password-encrypted. Clear the password field and try importing again.'
            : '该 ZIP 不是加密全保真备份，无需提供备份密码；请清空密码后重试导入。',
        ),
      };
    case 'decrypt_failed': {
      const hasRawHostDiagnostic =
        RAW_DECRYPT_DIAGNOSTIC_RE.test(trimmed) ||
        (english && /[\u4e00-\u9fff]/.test(trimmed));
      if (!hasRawHostDiagnostic) {
        return { category, message: trimmed };
      }
      return {
        category,
        message: translateWithFallback(
          t,
          'data:governance.import_decrypt_failed_inline',
          english
            ? 'Incorrect backup password or corrupted sealed payload. Your current data was not modified; verify the password and try again.'
            : '备份密码错误或密封载荷损坏，当前数据没有被改动；请确认密码后重试。',
        ),
      };
    }
    case 'corrupt_or_truncated_zip':
      return {
        category,
        message: translateWithFallback(
          t,
          'data:governance.import_zip_corrupt_or_truncated',
          english
            ? 'Backup ZIP archive is corrupted or truncated. Your current data was not modified; please verify or re-export the archive and try again.'
            : '备份 ZIP 文件已损坏或不完整（截断或校验失败）。当前数据没有被改动；请确认文件完整或重新导出后重试。',
        ),
      };
    case 'file_not_found':
      return {
        category,
        message: translateWithFallback(
          t,
          'data:backup_import.error_file_not_found',
          english
            ? 'Backup file not found or path invalid'
            : '备份文件不存在或路径无效',
        ),
      };
    case 'permission_denied':
      return {
        category,
        message: translateWithFallback(
          t,
          'data:backup_import.error_permission_denied',
          english
            ? 'Permission denied: cannot access backup file'
            : '权限不足：无法访问备份文件',
        ),
      };
    default: {
      if (trimmed) {
        const localized = localizeCloudStorageError(trimmed, t, language).trim();
        if (localized) {
          return { category, message: localized };
        }
      }
      return {
        category,
        message: translateWithFallback(
          t,
          'data:backup_import.error_import_failed',
          english ? 'Failed to import backup' : '导入备份失败',
        ),
      };
    }
  }
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
  const { t, i18n } = useTranslation(['data', 'common', 'cloudStorage']);
  const [importPassword, setImportPassword] = useState('');
  const [importFilePath, setImportFilePath] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [importFileError, setImportFileError] = useState<string | null>(null);
  const [importPasswordError, setImportPasswordError] = useState<string | null>(null);
  const [importErrorCategory, setImportErrorCategory] =
    useState<BackupImportErrorCategory | null>(null);
  const [isImportingSubmitting, setIsImportingSubmitting] = useState(false);
  const [isStagingImportFile, setIsStagingImportFile] = useState(false);
  const webUiMode = isWebUiShell();

  const resetImportDialogState = () => {
    setImportPassword('');
    setImportFilePath('');
    setImportFileName('');
    setImportFileError(null);
    setImportPasswordError(null);
    setImportErrorCategory(null);
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
    setImportPasswordError(null);
    setImportErrorCategory(null);
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
      setImportErrorCategory('password_required');
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
    setImportErrorCategory(null);
    setIsImportingSubmitting(true);
    try {
      const outcome = resumeImportJobId
        ? await onResumeJob?.(resumeImportJobId, importPassword)
        : explicitPath
          ? await onImportZip(pwd, explicitPath)
          : await onImportZip(pwd);
      if (outcome && outcome.success === false) {
        if (!outcome.cancelled) {
          const formatted = formatBackupImportError(
            outcome.error,
            t,
            i18n?.language,
          );
          setImportPasswordError(formatted.message);
          setImportErrorCategory(formatted.category);
          notifyErrorDeduped('error', formatted.message);
        }
        return;
      }
      resetImportDialogState();
      onOpenChange(false);
    } catch (error: unknown) {
      const rawMsg =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : '';
      const candidate =
        classifyBackupImportError(rawMsg) !== 'generic'
          ? rawMsg
          : localizeCloudStorageError(error, t, i18n?.language);
      const formatted = formatBackupImportError(candidate, t, i18n?.language);
      setImportPasswordError(formatted.message);
      setImportErrorCategory(formatted.category);
      notifyErrorDeduped('error', formatted.message);
    } finally {
      setIsImportingSubmitting(false);
    }
  };

  return (
    <DsDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (isImportingSubmitting || isStagingImportFile) return;
          resetImportDialogState();
          onOpenChange(false);
        }
      }}
      showClose={!isImportingSubmitting && !isStagingImportFile}
      closeOnOverlay={!isImportingSubmitting && !isStagingImportFile}
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
                  if (importPasswordError) {
                    setImportPasswordError(null);
                    setImportErrorCategory(null);
                  }
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
                if (importPasswordError) {
                  setImportPasswordError(null);
                  setImportErrorCategory(null);
                }
              }}
            />
            {importPasswordError && (
              <p
                role="alert"
                data-error-category={importErrorCategory ?? undefined}
                className="text-xs text-destructive"
              >
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
          disabled={isImportingSubmitting || isStagingImportFile}
          onClick={() => {
            if (isImportingSubmitting || isStagingImportFile) return;
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
