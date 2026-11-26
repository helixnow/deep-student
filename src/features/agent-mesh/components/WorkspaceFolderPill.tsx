import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, Check, FolderOpen, GitBranch, X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Switch } from '@/components/ui/shad/Switch';
import { Z_INDEX } from '@/config/zIndex';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { formatWorkspaceFolderBasename } from '../types';
import { setWorkspaceBinding } from '../hostBridge';
import { useAgentMeshStore } from '../store/useAgentMeshStore';

export interface WorkspaceFolderPillProps {
  sessionId?: string | null;
  disabled?: boolean;
  className?: string;
}

export const WorkspaceFolderPill: React.FC<WorkspaceFolderPillProps> = ({
  sessionId,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation(['agentMesh', 'common']);
  const switchLabelId = useId();
  const effectiveSessionId = sessionId || 'default';
  const binding = useAgentMeshStore(
    (s) => s.workspaceBindings[effectiveSessionId] ?? null,
  );

  const [open, setOpen] = useState(false);
  const [draftPath, setDraftPath] = useState(binding?.rootPath ?? '');
  const [isolatedBranch, setIsolatedBranch] = useState(Boolean(binding?.isolatedBranch));
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setDraftPath(binding?.rootPath ?? '');
      setIsolatedBranch(Boolean(binding?.isolatedBranch));
    }
  }, [binding?.isolatedBranch, binding?.rootPath, open]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  const handlePointerDownOutside = useCallback(
    (event: Event) => {
      if (!open) return;
      const target = event.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) {
        setOpen(false);
      }
    },
    [open],
  );

  const handleEscapeKey = useCallback(
    (event: Event) => {
      if (!open) return;
      const ke = event as KeyboardEvent;
      if (ke.key === 'Escape') {
        ke.stopPropagation();
        setOpen(false);
      }
    },
    [open],
  );

  useEventRegistry(
    open
      ? [
          {
            target: 'document',
            type: 'pointerdown',
            listener: handlePointerDownOutside,
          },
          {
            target: 'window',
            type: 'keydown',
            listener: handleEscapeKey,
          },
        ]
      : [],
    [open, handlePointerDownOutside, handleEscapeKey],
  );

  const applyBinding = useCallback(
    async (nextPath: string, nextIsolated = isolatedBranch) => {
      await setWorkspaceBinding({
        chatSessionId: effectiveSessionId,
        rootPath: nextPath.trim(),
        isolatedBranch: nextIsolated,
      });
      setOpen(false);
    },
    [effectiveSessionId, isolatedBranch],
  );

  const handleBrowseNative = useCallback(async () => {
    try {
      const { open: dialogOpen } = await import('@tauri-apps/plugin-dialog');
      const selected = await dialogOpen({
        directory: true,
        multiple: false,
        title: t('agentMesh:workspace.dialogTitle', {
          defaultValue: '选择外部编程工具的工作目录',
        }),
      });
      if (typeof selected === 'string' && selected.trim()) {
        setDraftPath(selected.trim());
        await applyBinding(selected.trim(), isolatedBranch);
      }
    } catch {
      inputRef.current?.focus();
    }
  }, [applyBinding, isolatedBranch, t]);

  const folderLabel = formatWorkspaceFolderBasename(binding?.rootPath);
  const pillTitle = binding?.rootPath
    ? t('agentMesh:workspace.boundFolderTitle', {
        path: binding.rootPath,
        defaultValue: '当前协作目录：{{path}}',
      })
    : t('agentMesh:workspace.selectFolder', { defaultValue: '选择目录' });

  return (
    <div ref={containerRef} className={cn('relative inline-flex items-center', className)}>
      <DsButton
        variant="ghost"
        size="sm"
        disabled={disabled}
        data-testid="workspace-folder-pill"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={pillTitle}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        className={cn(
          '!h-6 !px-2.5 !py-0.5 !rounded-full gap-1 text-xs font-normal transition-colors',
          'border border-border/35 bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/60',
          binding?.rootPath && 'text-foreground/85 border-border/45',
        )}
      >
        <FolderOpen size={12} weight="duotone" className="shrink-0 text-muted-foreground" />
        <span className="max-w-[120px] truncate">
          {folderLabel || t('agentMesh:workspace.selectFolder', { defaultValue: '选择目录' })}
        </span>
        {binding?.isolatedBranch && (
          <GitBranch size={11} className="shrink-0 text-primary" aria-hidden="true" />
        )}
        <CaretDown size={10} className="shrink-0 opacity-65" aria-hidden="true" />
      </DsButton>

      {open && (
        <div
          role="dialog"
          aria-label={t('agentMesh:workspace.popoverTitle', {
            defaultValue: '关联本地项目目录',
          })}
          data-testid="workspace-folder-popover"
          style={{ zIndex: Z_INDEX.inputBarPopover }}
          className={cn(
            'absolute bottom-full left-0 mb-2 w-[min(22rem,calc(100vw-2rem))]',
            'rounded-2xl border border-border/50 bg-popover/90 p-3 shadow-lg ring-1 ring-border/40 backdrop-blur-xl backdrop-saturate-150',
          )}
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">
              {t('agentMesh:workspace.popoverTitle', { defaultValue: '关联本地项目目录' })}
            </span>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              aria-label={t('common:actions.close', { defaultValue: 'Close' })}
              onClick={() => setOpen(false)}
              className="!h-5 !w-5 !p-0 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </DsButton>
          </div>

          <p className="mb-2.5 text-2xs leading-relaxed text-muted-foreground">
            {t('agentMesh:workspace.popoverDesc', {
              defaultValue: '默认在原目录直接修改，每轮自动生成无侵入隐藏快照以便随时回退。',
            })}
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void applyBinding(draftPath, isolatedBranch);
            }}
            className="space-y-2.5"
          >
            <Input
              ref={inputRef}
              type="text"
              value={draftPath}
              onChange={(e) => setDraftPath(e.target.value)}
              placeholder={t('agentMesh:workspace.pathPlaceholder', {
                defaultValue: '输入或粘贴本地项目路径，如 ~/projects/app',
              })}
              data-testid="workspace-folder-path-input"
              className="h-8 text-xs"
            />

            <div className="flex items-center justify-between gap-2 px-0.5 py-0.5">
              <span id={switchLabelId} className="text-xs text-muted-foreground">
                {t('agentMesh:workspace.isolatedBranch', {
                  defaultValue: '使用独立 Git 工作树',
                })}
              </span>
              <Switch
                checked={isolatedBranch}
                onCheckedChange={setIsolatedBranch}
                aria-labelledby={switchLabelId}
                data-testid="workspace-isolated-branch-checkbox"
              />
            </div>

            <div className="flex items-center justify-between gap-1.5 pt-0.5">
              <DsButton
                variant="outline"
                size="sm"
                data-testid="workspace-folder-browse-btn"
                onClick={() => void handleBrowseNative()}
                className="!h-7 !px-2.5 text-xs"
              >
                <FolderOpen size={13} className="mr-1 shrink-0" />
                <span>
                  {t('agentMesh:workspace.browseNative', { defaultValue: '选择文件夹…' })}
                </span>
              </DsButton>

              <div className="flex items-center gap-1.5">
                {binding?.rootPath && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    data-testid="workspace-folder-clear-btn"
                    onClick={() => void applyBinding('', false)}
                    className="!h-7 !px-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t('agentMesh:workspace.clearBinding', { defaultValue: '清除' })}
                  </DsButton>
                )}
                <DsButton
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={!draftPath.trim()}
                  data-testid="workspace-folder-apply-btn"
                  className="!h-7 !px-3 text-xs"
                >
                  <Check size={12} className="mr-1 shrink-0" />
                  <span>{t('agentMesh:workspace.applyPath', { defaultValue: '确定' })}</span>
                </DsButton>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

WorkspaceFolderPill.displayName = 'WorkspaceFolderPill';

export default WorkspaceFolderPill;
