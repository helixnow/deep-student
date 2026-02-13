/**
 * NoteContentView - 笔记内容视图
 *
 * 统一应用面板中的笔记编辑视图。
 * 通过 DSTU 协议获取笔记数据，直接传递给编辑器组件。
 * 
 * 改造后移除了对 NotesProvider/NotesContext 的依赖，
 * 所有数据通过 DSTU 节点和 API 获取。
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RotateCcw, History } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotesCrepeEditor } from '@/components/notes/NotesCrepeEditor';
import { reportError, type VfsError, VfsErrorCode } from '@/shared/result';
import { dstu } from '@/dstu';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ContentViewProps } from '../UnifiedAppPanel';

/**
 * 笔记内容视图
 * 
 * 直接使用 DSTU 协议获取和保存笔记数据，
 * 不再依赖 NotesProvider/NotesContext。
 */
const NoteContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
  onTitleChange,
  readOnly = false,
}) => {
  const { t } = useTranslation(['notes', 'common']);

  // ========== 状态 ==========
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<VfsError | null>(null);
  
  // 笔记内容状态
  // 🔧 修复：使用 null 表示"未加载"，空字符串表示"已加载但内容为空"
  const [content, setContent] = useState<string | null>(null);
  const [title, setTitle] = useState<string>(node.name || '');
  
  // 🔧 追踪当前加载的笔记 ID，用于防止竞态条件
  const loadingNoteIdRef = React.useRef<string | null>(null);

  const noteId = node.id;

  // ========== 加载笔记内容（提取为可复用函数，支持重试） ==========
  const loadNoteContent = useCallback(async () => {
    // 🔧 修复：记录当前加载的笔记 ID
    const currentNoteId = node.id;
    loadingNoteIdRef.current = currentNoteId;
    
    setIsLoading(true);
    setError(null);
    // 🔧 修复：切换笔记时重置 content 为 null（而不是保留旧值）
    setContent(null);

    // 通过 DSTU 获取笔记内容
    const result = await dstu.getContent(node.path);

    // 🔧 修复：检查是否仍在加载同一笔记（防止竞态条件）
    if (loadingNoteIdRef.current !== currentNoteId) {
      return;
    }

    if (!result.ok) {
      console.error('[NoteContentView] ❌ 加载笔记内容失败:', result.error);
      if (result.error.code !== VfsErrorCode.NOT_FOUND) {
        reportError(result.error, '加载笔记内容');
      }
      setError(result.error);
      setIsLoading(false);
      return;
    }

    const contentStr = typeof result.value === 'string' ? result.value : '';
    
    setContent(contentStr);
    setTitle(node.name || '');
    setIsLoading(false);
  }, [node.id, node.path, node.name]);

  useEffect(() => {
    void loadNoteContent();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]); // 只依赖 node.id，避免对象引用变化导致无限循环

  // ========== 保存回调 ==========
  // 内容保存
  const handleSave = useCallback(async (newContent: string) => {
    if (readOnly) return;
    // S-003: 维护模式拦截，防止 Learning Hub 入口绕过写入
    if (useSystemStatusStore.getState().maintenanceMode) {
      showGlobalNotification('warning', t('common:maintenance.blocked_note_save', '维护模式下无法保存笔记'));
      return;
    }
    const result = await dstu.update(node.path, newContent, node.type);
    if (!result.ok) {
      console.error('[NoteContentView] ❌ 保存笔记失败:', result.error);
      reportError(result.error, '保存笔记');
      throw new Error(result.error.toUserMessage());
    }
    setContent(newContent);
  }, [node.path, node.type, readOnly, t]);

  // 标题变更
  const handleTitleChange = useCallback(async (newTitle: string) => {
    if (readOnly) return;
    // S-003: 维护模式拦截
    if (useSystemStatusStore.getState().maintenanceMode) {
      showGlobalNotification('warning', t('common:maintenance.blocked_note_save', '维护模式下无法保存笔记'));
      return;
    }
    const result = await dstu.setMetadata(node.path, { title: newTitle });
    if (!result.ok) {
      console.error('[NoteContentView] Failed to update title:', result.error);
      reportError(result.error, '更新标题');
      throw new Error(result.error.toUserMessage());
    }
    setTitle(newTitle);
    // 通知父级面板标题已更新
    onTitleChange?.(newTitle);
  }, [node.path, readOnly, onTitleChange, t]);

  // ========== 渲染 ==========
  // 🔧 修复：只有在加载中或内容尚未获取时才显示加载状态
  // content === null 表示内容尚未加载，content === '' 表示内容已加载但为空
  
  if (isLoading || content === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading', '加载中...')}
        </span>
      </div>
    );
  }

  if (error) {
    const message = error.code === VfsErrorCode.NOT_FOUND
      ? t('notes:error.notFound', '笔记不存在或已被删除')
      : error.toUserMessage();
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <AlertCircle className="w-8 h-8 text-destructive mb-2" />
        <span className="text-destructive">{message}</span>
        <div className="flex gap-2 mt-3">
          <NotionButton variant="primary" onClick={() => loadNoteContent()}>
            {t('common:retry', '重试')}
          </NotionButton>
          {onClose && (
            <NotionButton variant="ghost" onClick={onClose}>
              {t('common:close', '关闭')}
            </NotionButton>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-4">
          <History className="w-3.5 h-3.5 text-muted-foreground/60" />
          <span className="text-xs text-muted-foreground/60">
            {t('notes:tips.versionHistory', '版本历史可在笔记面板中查看和回滚')}
          </span>
        </div>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-full bg-background">
      <NotesCrepeEditor
        initialContent={content}
        initialTitle={title}
        onSave={readOnly ? undefined : handleSave}
        onTitleChange={readOnly ? undefined : handleTitleChange}
        noteId={noteId}
        className="flex-1 min-h-0"
        readOnly={readOnly}
      />
      {/* TODO [M-005]: 添加版本历史/回滚入口按钮。
          后端已有 VfsNoteVersion 表和 notes_versions 存储，但前端 Learning Hub 尚未暴露
          版本浏览和回滚 UI。需要：
          1. 添加"查看版本历史"按钮，打开版本列表面板
          2. 版本列表调用 dstu.listVersions(noteId)
          3. 选中版本后可预览 diff 并一键回滚
          参考：src-tauri/src/vfs/types.rs - VfsNoteVersion 结构体 */}
      <div className="flex-shrink-0 flex items-center gap-1.5 px-4 py-1.5 border-t border-border/40">
        <History className="w-3.5 h-3.5 text-muted-foreground/60" />
        <span className="text-xs text-muted-foreground/60">
          {t('notes:tips.versionHistory', '版本历史可在笔记面板中查看和回滚')}
        </span>
      </div>
    </div>
  );
};

export default NoteContentView;
