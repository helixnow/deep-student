/**
 * 统一右侧栏的「属性」页：以工作区级数据驱动 NotesContextPanel。
 *
 * 与 NoteContentView 内嵌属性浮层的差异：宿主是 NotesWorkspaceApp，
 * 数据来自 DstuNode（名称/时间/标签）+ 一次内容读取（供大纲初始解析）。
 * 编辑中的实时大纲更新由 NotesContextPanel 自己监听
 * `notes:content-changed` 事件完成（按 noteId 过滤），无需宿主转发。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from '@phosphor-icons/react';
import { dstu, type DstuNode } from '@/dstu';
import { NotesContextPanel } from '@/features/notes/NotesContextPanel';

export interface NotesPropertiesTabProps {
  /** 当前活跃资源；非笔记类型显示占位提示 */
  activeResource: DstuNode | null;
  /** 是否只读（禁用标签编辑） */
  readOnly?: boolean;
  /** 标签写回成功后的宿主刷新钩子（同步工作区资源缓存） */
  onRefresh?: () => void;
}

export const NotesPropertiesTab: React.FC<NotesPropertiesTabProps> = ({
  activeResource,
  readOnly = false,
  onRefresh,
}) => {
  const { t } = useTranslation('workbench');
  const note = activeResource?.type === 'note' ? activeResource : null;
  const noteId = note?.id ?? null;

  const [tags, setTags] = useState<string[]>(
    () => ((note?.metadata?.tags as string[] | undefined) ?? []),
  );
  const [content, setContent] = useState('');

  // 切换笔记 / 资源元数据刷新时同步标签
  useEffect(() => {
    setTags(((note?.metadata?.tags as string[] | undefined) ?? []));
  }, [noteId, note?.metadata?.tags]);

  // 读取一次内容供大纲初始解析；后续实时更新走 notes:content-changed 事件
  useEffect(() => {
    if (!note) {
      setContent('');
      return;
    }
    let cancelled = false;
    setContent('');
    void (async () => {
      const result = await dstu.getContent(note.path);
      if (cancelled || !result.ok) return;
      const text = typeof result.value === 'string'
        ? result.value
        : await result.value.text();
      if (!cancelled) setContent(text);
    })();
    return () => {
      cancelled = true;
    };
    // note.updatedAt：外部更新（保存/Agent 修改）后重读，保证大纲基线不过期
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, note?.updatedAt]);

  const handleTagsChange = useCallback(async (newTags: string[]) => {
    if (!note || readOnly) return;
    const result = await dstu.setMetadata(note.path, { tags: newTags });
    if (!result.ok) {
      throw new Error(result.error.toUserMessage());
    }
    setTags(newTags);
    onRefresh?.();
  }, [note, readOnly, onRefresh]);

  if (!note) {
    return (
      <div className="notes-backlinks-panel-message">
        <FileText size={22} aria-hidden="true" />
        {t('notesWorkspace.backlinks.noActiveNoteProperties', {
          defaultValue: '选择一篇笔记以查看属性。',
        })}
      </div>
    );
  }

  return (
    <NotesContextPanel
      noteId={note.id}
      title={note.name}
      createdAt={note.createdAt}
      updatedAt={note.updatedAt}
      tags={tags}
      content={content}
      onTagsChange={readOnly ? undefined : handleTagsChange}
    />
  );
};

export default NotesPropertiesTab;
