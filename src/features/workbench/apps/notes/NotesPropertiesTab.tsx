/**
 * 统一右侧栏的「属性」页：以工作区级数据驱动 NotesContextPanel。
 *
 * 与 NoteContentView 内嵌属性浮层的差异：宿主是 NotesWorkspaceApp，
 * 数据来自 DstuNode（名称/时间/标签/自定义属性）+ 一次内容读取（供大纲
 * 初始解析）。编辑中的实时大纲更新由 NotesContextPanel 自己监听
 * `notes:content-changed` 事件完成（按 noteId 过滤），无需宿主转发。
 *
 * 纯内容保存的时效性：NotesWorkspaceApp 对 content-only 保存刻意不替换
 * resources 里的节点对象（避免整棵文件树重渲染），所以本页自己订阅
 * dstu.watch —— 保存/外部修改产生 updated 事件时，用事件携带的新节点
 * 覆盖本地基线，让 updatedAt 展示与大纲重读跟上磁盘。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from '@phosphor-icons/react';
import { dstu, type DstuNode } from '@/dstu';
import { NotesContextPanel } from '@/features/notes/NotesContextPanel';
import { NoteCustomPropsEditor } from './NoteCustomPropsEditor';
import { getNodeProps } from './parseTagQuery';
import './NoteCustomPropsEditor.css';

export interface NotesPropertiesTabProps {
  /** 当前活跃资源；非笔记类型显示占位提示 */
  activeResource: DstuNode | null;
  /** 是否只读（禁用标签/属性编辑） */
  readOnly?: boolean;
  /** 标签/属性写回成功后的宿主刷新钩子（同步工作区资源缓存） */
  onRefresh?: () => void;
}

export const NotesPropertiesTab: React.FC<NotesPropertiesTabProps> = ({
  activeResource,
  readOnly = false,
  onRefresh,
}) => {
  const { t } = useTranslation('workbench');
  const propNote = activeResource?.type === 'note' ? activeResource : null;
  const noteId = propNote?.id ?? null;

  // dstu.watch 带来的更新基线：content-only 保存不会替换 resources 节点，
  // 这里用事件节点覆盖，updatedAt / metadata 才能跟上磁盘。
  const [liveNode, setLiveNode] = useState<DstuNode | null>(null);
  const note = liveNode && liveNode.id === noteId ? liveNode : propNote;

  const [tags, setTags] = useState<string[]>(
    () => ((note?.metadata?.tags as string[] | undefined) ?? []),
  );
  const [customProps, setCustomProps] = useState<Record<string, unknown>>(
    () => getNodeProps(note?.metadata),
  );
  const [content, setContent] = useState('');

  // 切换笔记时丢弃上一篇的实时基线
  useEffect(() => {
    setLiveNode(null);
  }, [noteId]);

  // 订阅当前笔记的 updated 事件（保存 / Agent 修改 / 元数据写回）
  useEffect(() => {
    if (!noteId) return undefined;
    return dstu.watch('*', (event) => {
      if (event.type !== 'updated') return;
      const changed = event.node;
      if (!changed || changed.id !== noteId || changed.type !== 'note') return;
      setLiveNode((current) => {
        if (current && current.updatedAt >= changed.updatedAt) return current;
        return changed;
      });
    });
  }, [noteId]);

  const noteUpdatedAt = note?.updatedAt ?? 0;
  const noteMetadata = note?.metadata;

  // 元数据基线变化（切换笔记 / watch 更新 / 宿主刷新）时同步标签与属性
  useEffect(() => {
    setTags(((noteMetadata?.tags as string[] | undefined) ?? []));
    setCustomProps(getNodeProps(noteMetadata));
  }, [noteId, noteMetadata]);

  // 读取一次内容供大纲初始解析；后续实时更新走 notes:content-changed 事件。
  // noteUpdatedAt 变化（保存/外部修改）时重读，保证大纲基线不过期。
  useEffect(() => {
    if (!note) {
      setContent('');
      return undefined;
    }
    let cancelled = false;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, noteUpdatedAt]);

  const handleTagsChange = useCallback(async (newTags: string[]) => {
    if (!note || readOnly) return;
    const result = await dstu.setMetadata(note.path, { tags: newTags });
    if (!result.ok) {
      throw new Error(result.error.toUserMessage());
    }
    setTags(newTags);
    onRefresh?.();
  }, [note, readOnly, onRefresh]);

  const handleCustomPropsChange = useCallback(async (next: Record<string, unknown>) => {
    if (!note || readOnly) return;
    const result = await dstu.setMetadata(note.path, { props: next });
    if (!result.ok) {
      throw new Error(result.error.toUserMessage());
    }
    setCustomProps(next);
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
      beforeOutline={(
        <NoteCustomPropsEditor
          value={customProps}
          readOnly={readOnly}
          onChange={readOnly ? undefined : handleCustomPropsChange}
        />
      )}
    />
  );
};

export default NotesPropertiesTab;
