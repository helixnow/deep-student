/**
 * Web 演示壳 - 浮动徽章
 *
 * 全屏真实 App 之上唯一的"演示"标识：右下角浮动徽章，
 * 点击展开说明卡片（语义词 WorkBuddy 的 Mock 徽章）：
 * 说明当前为剧本数据，并提供"回到演示会话"入口。
 */

import React, { useEffect, useRef, useState } from 'react';
import { Sparkle, X } from '@phosphor-icons/react';
import { dispatchAppEvent, APP_EVENTS } from '@/events/app';
import { DEMO_SESSIONS } from './fixtures';

export const DemoBadge: React.FC = () => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={rootRef} className="demo-badge-root">
      {open && (
        <div className="demo-badge-popover" role="dialog" aria-label="演示环境说明">
          <div className="demo-badge-popover-header">
            <strong>演示环境</strong>
            <button
              type="button"
              className="demo-badge-close"
              aria-label="关闭"
              onClick={() => setOpen(false)}
            >
              <X size={13} />
            </button>
          </div>
          <p>
            当前页面运行的是与桌面版<strong>完全一致的前端界面与事件链路</strong>，
            会话内容来自内置剧本，不会连接真实模型或写入本地数据。
          </p>
          <div className="demo-badge-sessions">
            {DEMO_SESSIONS.map((s) => (
              <button
                key={s.meta.id}
                type="button"
                onClick={() => {
                  dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_SESSION, { sessionId: s.meta.id });
                  setOpen(false);
                }}
              >
                {s.meta.title}
              </button>
            ))}
          </div>
          <p className="demo-badge-tip">在输入框发送任意消息，可观看流式回复的完整过程。</p>
        </div>
      )}
      <button
        type="button"
        className="demo-badge-fab"
        onClick={() => setOpen((v) => !v)}
        title="演示环境说明"
      >
        <Sparkle size={13} weight="fill" />
        演示数据
      </button>

      <style>{`
        .demo-badge-root {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 9999;
          font-family: inherit;
        }
        .demo-badge-fab {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 12px;
          padding: 6px 12px;
          border-radius: 999px;
          border: 1px solid hsl(45 93% 47% / 0.35);
          background: hsl(45 93% 47% / 0.14);
          color: hsl(45 93% 32%);
          cursor: pointer;
          user-select: none;
          backdrop-filter: blur(6px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
        }
        html.dark .demo-badge-fab {
          color: hsl(45 93% 62%);
        }
        .demo-badge-popover {
          position: absolute;
          right: 0;
          bottom: calc(100% + 10px);
          width: 300px;
          padding: 12px 14px;
          border-radius: 12px;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--popover));
          color: hsl(var(--popover-foreground));
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
          font-size: 12px;
          line-height: 1.6;
        }
        .demo-badge-popover-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
          font-size: 13px;
        }
        .demo-badge-close {
          display: inline-flex;
          border: none;
          background: transparent;
          color: hsl(var(--muted-foreground));
          cursor: pointer;
          padding: 2px;
        }
        .demo-badge-popover p {
          margin: 0 0 8px;
          color: hsl(var(--muted-foreground));
        }
        .demo-badge-popover p strong {
          color: hsl(var(--foreground));
        }
        .demo-badge-sessions {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 8px;
        }
        .demo-badge-sessions button {
          text-align: left;
          font-size: 12px;
          padding: 6px 8px;
          border-radius: 8px;
          border: 1px solid hsl(var(--border));
          background: transparent;
          color: hsl(var(--foreground));
          cursor: pointer;
        }
        .demo-badge-sessions button:hover {
          background: hsl(var(--muted));
        }
        .demo-badge-tip {
          font-size: 11px;
        }
      `}</style>
    </div>
  );
};

export default DemoBadge;
