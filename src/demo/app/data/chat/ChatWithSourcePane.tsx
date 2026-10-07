/**
 * 对话窗口 + 右侧原文窗格。
 *
 * 学习桌面里点 PDF 页码徽章 / 附件 chip / 笔记与记忆来源，由 WorkbenchEventBridge 开出资源窗口；
 * 单应用演示只有一扇对话窗口，这里接住同样的事件，在右侧打开原文：
 *   - PDF（pdf-ref:open、context-ref:preview、CHAT_OPEN_ATTACHMENT_PREVIEW type=file）：
 *     同一份内容窗口组件（createContentWindowComponent('file')），再派发 pdf-ref:focus 跳页；
 *   - 笔记 / 记忆（DSTU_OPEN_NOTE、CHAT_OPEN_ATTACHMENT_PREVIEW type=note、DSTU_NAVIGATE_TO_KNOWLEDGE_BASE）：
 *     包里登记过的笔记（setDemoPaneNotes）以只读 Markdown 打开；没登记的不响应。
 *
 * 本模块只经 load() 动态导入，可以静态依赖 app 代码。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { NotePencil, X } from '@phosphor-icons/react';
import type { AppWindowProps } from '@/features/workbench/core/types';
import { ChatSessionWindowFrame } from '@/features/workbench/apps/chat/ChatSessionWindowFrame';
import { createContentWindowComponent } from '@/features/workbench/apps/content/ContentAppWindow';
import { MarkdownRenderer } from '@/features/chat/components/renderers/MarkdownRenderer';
import { tr } from '../../../lang';

export interface DemoPaneNote {
  title: string;
  /** 所在位置（面包屑），如「AI 记忆 / 偏好」 */
  folder: string;
  content: string;
}

let paneNotes: Record<string, DemoPaneNote> = {};

/** 包在 load() 里登记右侧可打开的笔记 */
export function setDemoPaneNotes(notes: Record<string, DemoPaneNote>): void {
  paneNotes = notes;
}

const FileWindow = createContentWindowComponent('file');

type Opened = { kind: 'file'; id: string } | { kind: 'note'; id: string };

function dispatchPdfFocus(sourceId: string, pageNumber: number, quote?: string): void {
  const fire = () =>
    document.dispatchEvent(
      new CustomEvent('pdf-ref:focus', { detail: { sourceId, pageNumber, quote, path: `/${sourceId}` } }),
    );
  // 窗格首次打开时 PDF 还在加载：与学习桌面同样补发几次
  fire();
  window.setTimeout(fire, 250);
  window.setTimeout(fire, 800);
  window.setTimeout(fire, 1600);
}

export const ChatWithSourcePane: React.FC<AppWindowProps> = (props) => {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [fileTitle, setFileTitle] = useState('');
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const openNote = (id: string | undefined) => {
      if (id && paneNotes[id]) setOpened({ kind: 'note', id });
    };
    const onPdfRefOpen = (event: Event) => {
      const { sourceId, pageNumber, quote } =
        (event as CustomEvent<{ sourceId?: string; pageNumber?: number; quote?: string }>).detail ?? {};
      if (!sourceId) return;
      setOpened({ kind: 'file', id: sourceId });
      if (Number.isFinite(pageNumber) && (pageNumber as number) > 0) dispatchPdfFocus(sourceId, pageNumber as number, quote);
    };
    const onContextRefPreview = (event: Event) => {
      const { resourceId, typeId } = (event as CustomEvent<{ resourceId?: string; typeId?: string }>).detail ?? {};
      if (!resourceId || typeId !== 'file') return;
      void invoke<{ sourceId?: string } | null>('vfs_get_resource', { resourceId }).then((resource) => {
        if (resource?.sourceId) setOpened({ kind: 'file', id: resource.sourceId });
      });
    };
    // 消息上的文件 chip、来源面板里的笔记来源（经典布局开右侧附件预览）
    const onAttachmentPreview = (event: Event) => {
      const { id, type } = (event as CustomEvent<{ id?: string; type?: string }>).detail ?? {};
      if (!id) return;
      if (type === 'note') openNote(id);
      else if (!type || type === 'file') setOpened({ kind: 'file', id });
    };
    const onOpenNote = (event: Event) => openNote((event as CustomEvent<{ noteId?: string }>).detail?.noteId);
    // 来源面板「在用户记忆中打开」
    const onNavigateKnowledgeBase = (event: Event) => {
      const locator = (event as CustomEvent<{ locator?: { sourceId?: string; resourceId?: string } }>).detail?.locator;
      openNote(locator?.sourceId ?? locator?.resourceId);
    };
    window.addEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onAttachmentPreview);
    window.addEventListener('DSTU_OPEN_NOTE', onOpenNote);
    window.addEventListener('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE', onNavigateKnowledgeBase);
    document.addEventListener('pdf-ref:open', onPdfRefOpen);
    document.addEventListener('context-ref:preview', onContextRefPreview);
    return () => {
      window.removeEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onAttachmentPreview);
      window.removeEventListener('DSTU_OPEN_NOTE', onOpenNote);
      window.removeEventListener('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE', onNavigateKnowledgeBase);
      document.removeEventListener('pdf-ref:open', onPdfRefOpen);
      document.removeEventListener('context-ref:preview', onContextRefPreview);
    };
  }, []);

  const close = useCallback(() => setOpened(null), []);
  const note = opened?.kind === 'note' ? paneNotes[opened.id] : null;

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <div className="h-full min-w-0 flex-1">
        <ChatSessionWindowFrame {...props} />
      </div>
      {opened && (
        <div
          data-demo-source-pane={opened.id}
          className={
            narrow
              ? 'absolute inset-0 z-30 flex flex-col bg-background'
              : 'flex h-full w-[46%] min-w-[360px] flex-col border-l border-border bg-background'
          }
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            {note && <NotePencil size={15} className="shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {note ? note.title : fileTitle}
            </span>
            <button
              type="button"
              onClick={close}
              aria-label={tr('关闭原文', 'Close source')}
              title={tr('关闭原文', 'Close source')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
          <div className={`relative min-h-0 flex-1 ${opened.kind === 'note' ? 'overflow-y-auto' : ''}`}>
            {opened.kind === 'file' ? (
              <FileWindow
                windowId={`demo-source-${opened.id}`}
                instanceKey={opened.id}
                launchPayload={null}
                isActive
                isVisible
                renderThrottleMs={0}
                isSuspended={false}
                onTitleChange={setFileTitle}
                requestClose={close}
              />
            ) : note ? (
              <article className="px-6 py-5 text-sm leading-relaxed [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_table]:my-2 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1">
                <p className="mb-3 text-xs text-muted-foreground">{note.folder}</p>
                <MarkdownRenderer content={note.content} />
              </article>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatWithSourcePane;
