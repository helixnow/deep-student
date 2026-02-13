/**
 * NoteEditorPortal - 笔记编辑器 Portal 组件
 * 
 * 在 App 级别渲染，用于将编辑器 Portal 到白板节点
 * 实现真正的远程桌面模式：编辑器实例唯一，由此组件维护
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CrepeEditor, type CrepeEditorApi } from '../crepe';
import { CustomScrollArea } from '../custom-scroll-area';
import { useNotesOptional } from './NotesContext';
import { NotesEditorToolbar } from './components/NotesEditorToolbar';

const AUTO_SAVE_DEBOUNCE_MS = 1500;

export const NoteEditorPortal: React.FC = () => {
  const { t } = useTranslation(['notes']);
  
  // 使用 useNotesOptional，在没有 NotesProvider 时返回 null
  // 这样 DSTU 模式下此组件会静默不渲染
  const notesContext = useNotesOptional();
  
  // 从 Context 解构（可能为 null）
  const notes = notesContext?.notes ?? [];
  const loadedContentIds = notesContext?.loadedContentIds ?? new Set<string>();
  const saveNoteContent = notesContext?.saveNoteContent;
  const ensureNoteContent = notesContext?.ensureNoteContent;
  const editorPortalNoteId = notesContext?.editorPortalNoteId;

  // 白板功能已移除，此组件不再使用 Portal
  // 保留组件结构以便将来可能恢复功能

  const [editorApi, setEditorApi] = useState<CrepeEditorApi | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const contentRef = useRef<string>();
  const isUnmountedRef = useRef(false);

  // 获取目标笔记
  const note = editorPortalNoteId ? notes.find(n => n.id === editorPortalNoteId) : null;
  const isContentLoaded = editorPortalNoteId ? loadedContentIds.has(editorPortalNoteId) : false;
  const initialValue = note?.content_md || '';

  // 确保内容已加载
  useEffect(() => {
    if (editorPortalNoteId && !isContentLoaded && ensureNoteContent) {
      void ensureNoteContent(editorPortalNoteId);
    }
  }, [editorPortalNoteId, isContentLoaded, ensureNoteContent]);

  // 清理定时器和标记卸载状态
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
      }
    };
  }, []);

  // 内容变化处理（防抖保存）
  const handleContentChange = useCallback((newContent: string) => {
    // 如果组件已卸载，不创建新定时器
    if (isUnmountedRef.current) return;
    
    contentRef.current = newContent;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      // 双重检查：定时器回调时再次确认组件未卸载
      if (isUnmountedRef.current) return;
      if (editorPortalNoteId && saveNoteContent) {
        void saveNoteContent(editorPortalNoteId, newContent);
      }
    }, AUTO_SAVE_DEBOUNCE_MS);
  }, [editorPortalNoteId, saveNoteContent]);

  // 编辑器就绪回调
  const handleEditorReady = useCallback((api: CrepeEditorApi) => {
    setEditorApi(api);
  }, []);

  // 阻止事件冒泡到其他节点
  const stopPropagation = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  // 白板功能已移除，此组件不再渲染
  // 保留组件以兼容 App.tsx 中的引用
  if (!notesContext || !editorPortalNoteId || !isContentLoaded || !note) {
    return null;
  }

  // 白板 Portal 功能已禁用
  return null;
};

export default NoteEditorPortal;
