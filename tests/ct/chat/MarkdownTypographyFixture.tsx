import React from 'react';
import '@/styles/tailwind.css';
import '@/styles/shadcn-variables.css';
import '@/styles/theme-colors.css';
import '@/styles/typography.css';
import '@/features/chat/styles/chat.css';
import '@/features/chat/styles/chat-beautify.css';
import '@/features/chat/styles/markdown.css';
import '@/features/chat/components/renderers/ThinkingChain.css';
import '@/features/chat/components/ActivityTimeline/ActivityTimeline.css';
import './markdownTypographyVisual.css';

const LONG_CHINESE_COPY =
  '这是一段较长的中文会话正文，用来确认在桌面和移动端宽度变化时，普通段落、列表和用户气泡都能自然换行，并且不会因为局部排版类而缩回较小字号。';

function MarkdownSample({ streaming }: { streaming: boolean }) {
  return (
    <div
      className="markdown-content"
      data-streaming={streaming ? 'true' : 'false'}
      data-sample="markdown"
    >
      <p data-sample="paragraph">
        普通段落保持稳定的阅读基线，包含 <strong data-sample="strong">强调文字</strong> 和{' '}
        <code className="inline-code" data-sample="inline-code">inlineCode()</code>。
      </p>
      <h2 data-sample="heading">二级标题</h2>
      <ul data-sample="list">
        <li>第一项列表内容，继承会话正文的字号和字重。</li>
        <li>第二项列表内容，包含较长的中文换行样本。</li>
      </ul>
      <blockquote data-sample="blockquote">
        <p>引用内容保持正文阅读尺寸，不随代码或工具面板的紧凑字号变化。</p>
      </blockquote>
      <p className="chat-typography-fixture__long-copy" data-sample="long-copy">
        {LONG_CHINESE_COPY}
      </p>
      <div className="code-block-wrapper" data-sample="code-block">
        <pre className="code-block code-block-inner">
          <code>{'const body = 16;\nconst weight = 400;'}</code>
        </pre>
      </div>
      <div className="chain-of-thought" data-sample="thinking">
        <div className="chain-header">
          <span className="chain-title">思考过程</span>
        </div>
        <div className="thinking-content">思考详情与正文保持同一阅读节奏。</div>
      </div>
      <div className="activity-timeline" data-sample="timeline">
        <div className="activity-timeline__node chat-typography-fixture__timeline-node">
          <span className="timeline-node-dot" aria-hidden="true" />
          <div className="min-w-0">
            <button type="button" className="activity-timeline-thinking-trigger activity-timeline-summary">
              已思考 8 秒
            </button>
            <div className="activity-timeline-thinking-content" data-sample="thinking-detail">
              思考展开后保留正文的字号、行距和中文换行节奏。
            </div>
            <button type="button" className="activity-timeline-tool-trigger activity-timeline-summary">
              搜索资料 <span className="activity-timeline-status">已完成</span>
            </button>
            <div className="activity-timeline-tool-details" data-sample="tool-detail">
              输入和结果摘要保持可扫描的紧凑层级，不压缩成难读的小字。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MarkdownTypographyFixture() {
  return (
    <div className="chat-v2 chat-typography-fixture" data-theme="light">
      <div className="chat-typography-fixture__grid">
        <section className="chat-typography-fixture__state" data-state="completed">
          <h1 className="chat-typography-fixture__state-title">完成态</h1>
          <div className="chat-typography-fixture__message message assistant">
            <div className="message-content">
              <div className="chat-message-body chat-message-body--markdown">
                <MarkdownSample streaming={false} />
              </div>
            </div>
          </div>
          <div className="chat-typography-fixture__message chat-message-failure" data-sample="failure">
            请求失败后显示的提示文字也沿用会话正文基线。
          </div>
          <div className="chat-typography-fixture__message chat-typography-fixture__user-row chat-message-user">
            <div className="user-message-bubble">
              <div className="user-message-bubble__content">
                <div className="chat-message-body chat-message-body--markdown">
                  <div className="markdown-content">
                    <p data-sample="user-paragraph">用户气泡同样是 16px / 400。</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="chat-typography-fixture__state" data-state="streaming">
          <h1 className="chat-typography-fixture__state-title">流式态</h1>
          <div className="chat-typography-fixture__message message assistant">
            <div className="message-content">
              <div className="chat-message-body chat-message-body--markdown">
                <MarkdownSample streaming />
              </div>
            </div>
          </div>
          <div className="chat-typography-fixture__message chat-message-status" data-sample="reconnect">
            正在重连，已收到的内容会保留。
          </div>
          <div className="chat-typography-fixture__message chat-typography-fixture__user-row chat-message-user">
            <div className="user-message-bubble">
              <div className="user-message-bubble__content">
                <div className="chat-message-body chat-message-body--markdown">
                  <div className="markdown-content">
                    <p>长中文用户消息在窄屏中自然换行。</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
