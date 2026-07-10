/**
 * 内置浏览器 Agent 工具组
 *
 * 操控 Workbench 共享浏览器会话（BrowserService + 注入桥）。
 * 静态只读页优先用 web_fetch；本技能仅用于交互 / JS 渲染 / 共视场景。
 *
 * @see docs/dev/workbench-browser-design.md
 */

import type { SkillDefinition } from '../types';

const PREFER_FETCH =
  'Prefer builtin-web_fetch for read-only public/static pages; use this only when interaction or JS-rendered UI is required.';

export const browserToolsSkill: SkillDefinition = {
  id: 'browser-tools',
  name: 'browser-tools',
  description:
    '内置浏览器操控：在用户可见的共享网页会话中打开、导航、快照、点击、输入与滚动。静态只读内容请优先用 web-fetch；登录密码由用户接管，Agent 不得代填。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://browser-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 内置浏览器技能

在用户可见的共享浏览器会话中操作网页（与用户共视）。受 \`tools.browser_agent\` 与设置项 \`desktop.workbenchBrowserAgentControl\` 双闸约束。

## 何时用 web_fetch vs browser_*

优先 **builtin-web_fetch**：
- 公开文章、文档、静态 HTML，只需阅读
- 不需要登录、点击、翻页或执行前端 JS
- 需要省 token、更快（web_fetch 为 Low + ReadOnly）

使用 **browser_*** 工具当：
- 页面是 SPA / 强依赖 JS 渲染，fetch 得到空壳
- 需要点击、输入、翻页、展开折叠
- 需要登录后内容（由用户在浏览器中完成登录；Agent 不得代填密码）
- 需要确认交互后的页面状态

禁止：
- 用 browser 代替 web_search
- 对同一静态 URL 先 open 再全文阅读（应 web_fetch）
- 在未 snapshot 的情况下猜测 ref
- 向密码 / OTP 框输入（硬拒，交还用户接管）

## 推荐循环

1. \`builtin-browser_open\`（High 审批）→ 自动带 snapshot
2. \`builtin-browser_click\` / \`builtin-browser_type\`（用最新 snapshot 的 \`ref=eN\`）
3. 需要时 \`builtin-browser_snapshot\` / \`builtin-browser_scroll\` / \`builtin-browser_back\`
4. 结束时 \`builtin-browser_close\`

## 定位规则

- **只**使用 snapshot 返回的 \`ref\`（如 \`e12\`）；禁止坐标点击
- ref 仅对**最近一次** snapshot 有效；页面变化后必须重新 snapshot
`,
  embeddedTools: [
    {
      name: 'builtin-browser_open',
      description: `${PREFER_FETCH} 打开内置浏览器并导航到 URL（High 审批）。成功后返回页面 accessibility snapshot。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', description: '【必填】http(s) URL' },
          new_context: {
            type: 'boolean',
            default: false,
            description: 'true 时关闭现有会话并新建（再次触发 High 审批）',
          },
        },
      },
    },
    {
      name: 'builtin-browser_navigate',
      description: `${PREFER_FETCH} 在已打开的浏览器中导航到 URL；完成后返回精简 accessibility snapshot。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', description: '【必填】目标 http(s) URL' },
        },
      },
    },
    {
      name: 'builtin-browser_snapshot',
      description: `${PREFER_FETCH} 获取当前页 accessibility snapshot（含 ref）。点击/输入前应确认页面状态。默认只含可交互元素以节省 token。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          interactive_only: {
            type: 'boolean',
            default: true,
            description: 'true=仅可交互节点带 ref；false=更完整树（更耗 token）',
          },
          max_chars: {
            type: 'integer',
            default: 8000,
            minimum: 500,
            maximum: 40000,
            description: '返回文本上限；超限截断并提示续读',
          },
          start_index: {
            type: 'integer',
            default: 0,
            minimum: 0,
            description: '分页起点（字符偏移）',
          },
        },
      },
    },
    {
      name: 'builtin-browser_click',
      description: `${PREFER_FETCH} 点击 snapshot 中的元素。必须使用最近一次 snapshot 的 ref（如 e12）；禁止坐标。成功后默认附带新 snapshot。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'element'],
        properties: {
          ref: {
            type: 'string',
            pattern: '^e[0-9]+$',
            description: '【必填】snapshot 中的 ref，如 e5',
          },
          element: {
            type: 'string',
            description: '【必填】人类可读目标描述（审批/日志用），例如「下一页按钮」',
          },
          include_snapshot: {
            type: 'boolean',
            default: true,
            description: '成功后是否附带新 snapshot',
          },
        },
      },
    },
    {
      name: 'builtin-browser_type',
      description: `${PREFER_FETCH} 向 ref 指定的输入框填入文本。密码/OTP 框会被硬拒，需用户接管。submit=true 时随后按 Enter。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'element', 'text'],
        properties: {
          ref: { type: 'string', pattern: '^e[0-9]+$' },
          element: { type: 'string', description: '【必填】人类可读目标描述' },
          text: { type: 'string', description: '【必填】要输入的文本' },
          submit: { type: 'boolean', default: false },
          slowly: {
            type: 'boolean',
            default: false,
            description: '逐字输入（页面依赖 key 事件时）',
          },
          include_snapshot: { type: 'boolean', default: true },
        },
      },
    },
    {
      name: 'builtin-browser_scroll',
      description: `${PREFER_FETCH} 滚动页面或将元素滚入视口。需要视口外内容时使用，之后再 snapshot。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: {
            type: 'string',
            pattern: '^e[0-9]+$',
            description: '若提供：将该元素 scrollIntoView',
          },
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: '无 ref 时的页面滚动方向',
          },
          amount: {
            type: 'integer',
            default: 600,
            minimum: 50,
            maximum: 4000,
            description: '滚动像素（无 ref 时）',
          },
          include_snapshot: { type: 'boolean', default: true },
        },
      },
    },
    {
      name: 'builtin-browser_back',
      description: `${PREFER_FETCH} 浏览器历史后退；成功后返回新页面 snapshot。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'builtin-browser_close',
      description: `${PREFER_FETCH} 关闭本会话浏览器并释放资源。任务完成或用户要求停止浏览时调用。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  ],
};
