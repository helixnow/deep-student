/**
 * 对话窗口 + 右侧原文窗格。
 *
 * 学习桌面里点 PDF 页码徽章 / 附件 chip，由 WorkbenchEventBridge 开出一扇资源窗口并跳页；
 * 单应用演示只有一扇对话窗口，这里接住同样的事件（pdf-ref:open、context-ref:preview、
 * CHAT_OPEN_ATTACHMENT_PREVIEW），
 * 在右侧开出同一份内容窗口组件（createContentWindowComponent('file')），再派发 pdf-ref:focus 跳页。
 *
 * 本模块只经 load() 动态导入，可以静态依赖 app 代码。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from '@phosphor-icons/react';
import type { AppWindowProps } from '@/features/workbench/core/types';
import { ChatSessionWindowFrame } from '@/features/workbench/apps/chat/ChatSessionWindowFrame';
import { createContentWindowComponent } from '@/features/workbench/apps/content/ContentAppWindow';
import { tr } from '../../../lang';

const FileWindow = createContentWindowComponent('file');

function dispatchPdfFocus(sourceId: string, pageNumber: number, quote?: string): void {
  const fire = () =>
    document.dispatchEvent(
      new CustomEvent('pdf-ref:focus', { detail: { sourceId, pageNumber, quote, path: `/${sourceId}` } }),
    );
  // 窗格首次打开时 PDF 还在加载：与学习桌面同样补发两次
  fire();
  window.setTimeout(fire, 250);
  window.setTimeout(fire, 800);
  window.setTimeout(fire, 1600);
}

export const ChatWithSourcePane: React.FC<AppWindowProps> = (props) => {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onPdfRefOpen = (event: Event) => {
      const { sourceId: id, pageNumber, quote } =
        (event as CustomEvent<{ sourceId?: string; pageNumber?: number; quote?: string }>).detail ?? {};
      if (!id) return;
      setSourceId(id);
      if (Number.isFinite(pageNumber) && (pageNumber as number) > 0) dispatchPdfFocus(id, pageNumber as number, quote);
    };
    const onContextRefPreview = (event: Event) => {
      const { resourceId, typeId } = (event as CustomEvent<{ resourceId?: string; typeId?: string }>).detail ?? {};
      if (!resourceId || typeId !== 'file') return;
      void invoke<{ sourceId?: string } | null>('vfs_get_resource', { resourceId }).then((resource) => {
        if (resource?.sourceId) setSourceId(resource.sourceId);
      });
    };
    // 消息上的文件 chip（学习桌面里开资源窗口；经典布局开右侧附件预览）
    const onAttachmentPreview = (event: Event) => {
      const { id, type } = (event as CustomEvent<{ id?: string; type?: string }>).detail ?? {};
      if (id && (!type || type === 'file')) setSourceId(id);
    };
    window.addEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onAttachmentPreview);
    document.addEventListener('pdf-ref:open', onPdfRefOpen);
    document.addEventListener('context-ref:preview', onContextRefPreview);
    return () => {
      window.removeEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW', onAttachmentPreview);
      document.removeEventListener('pdf-ref:open', onPdfRefOpen);
      document.removeEventListener('context-ref:preview', onContextRefPreview);
    };
  }, []);

  const close = useCallback(() => setSourceId(null), []);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <div className="h-full min-w-0 flex-1">
        <ChatSessionWindowFrame {...props} />
      </div>
      {sourceId && (
        <div
          data-demo-source-pane={sourceId}
          className={
            narrow
              ? 'absolute inset-0 z-30 flex flex-col bg-background'
              : 'flex h-full w-[46%] min-w-[360px] flex-col border-l border-border bg-background'
          }
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
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
          <div className="relative min-h-0 flex-1">
            <FileWindow
              windowId={`demo-source-${sourceId}`}
              instanceKey={sourceId}
              launchPayload={null}
              isActive
              isVisible
              renderThrottleMs={0}
              isSuspended={false}
              onTitleChange={setTitle}
              requestClose={close}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatWithSourcePane;
