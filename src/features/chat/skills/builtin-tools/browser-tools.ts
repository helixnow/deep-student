/**
 * 内置浏览器 Agent 工具组
 *
 * 操控 Workbench 共享浏览器会话（BrowserService + CDP / 原生桥）。
 * 静态只读页优先用 web_fetch；本技能用于交互 / JS 渲染 / 需登录内容 / 多标签页共视场景。
 */

import type { SkillDefinition } from '../types';

const PREFER_FETCH =
  'Prefer builtin-web_fetch for static read-only pages.';

export const browserToolsSkill: SkillDefinition = {
  id: 'browser-tools',
  name: 'browser-tools',
  description:
    '内置浏览器操控：在用户可见的共享网页会话中打开、导航、AXTree 快照、正文提取、按需截图、点击、输入、悬停、按键、下拉选择、等待、滚动、多标签页管理与日志观测。静态只读内容请优先用 web-fetch；登录密码由用户接管，Agent 不得代填。',
  version: '2.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://browser-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 内置浏览器技能

在用户可见的共享浏览器会话中操作网页（与用户共视，桌面端支持内嵌/独立窗口，WebUI/远程模式支持 CDP 画面流式交互）。受 \`tools.browser_agent\` 与设置项 \`desktop.workbenchBrowserAgentControl\` 双闸约束。

## 何时用 web_fetch vs browser_*

优先 **builtin-web_fetch**：
- 公开文章、文档、静态 HTML，只需阅读
- 不需要登录、点击、翻页或执行前端 JS
- 更省 token、更快（web_fetch 为 Low + ReadOnly）

使用 **browser_*** 工具当：
- 页面是 SPA / 强依赖 JS 渲染，fetch 得到空壳
- 需要点击、输入、悬停、按键、下拉选择、翻页、展开折叠或多标签页协作
- 需要登录后内容（由用户在浏览器中完成登录；Agent 不得代填密码）
- 需要视觉核验图表、画布、公式或复杂排版

长链路浏览与网页调研建议：
- 当任务涉及多步网页探索、跨页检索或复杂表单流程时，优先委派给专用 \`browser\` 子代理（\`profile_id: "browser"\`），保持主对话上下文干净且隔离。

禁止：
- 用 browser 代替 web_search
- 对同一公开静态 URL 先 open 再全文阅读（应 web_fetch）
- 在未 snapshot 的情况下猜测 ref
- 向密码 / OTP / 验证码输入框填入任何内容（收到 \`BROWSER_PASSWORD_BLOCKED\` 或 \`USER_TAKEOVER\` 时立即暂停并交还用户接管）

## 推荐循环与最佳实践

1. **先读 AXTree 快照，再动作**：\`builtin-browser_open\`（High 审批）后默认附带 \`builtin-browser_snapshot\`；多步连续操作中优先开启 \`diff: true\` / \`diff_snapshot: true\`，仅返回增量变化以显著节省 token。
2. **阅读长文与论文**：对已打开（含需登录）的文章、论文或文档页，优先调用 \`builtin-browser_extract_content\` 提取干净 Markdown 正文；需要沉淀到知识库时配合 \`builtin-webpage_save\`（index-webpage）入库 VFS。
3. **按需视觉截图**：仅在需要确认图表、Canvas、数学公式或视觉排版时调用 \`builtin-browser_screenshot\`（可设 \`annotate: true\` 叠加 ref 标注）；常规交互坚持使用 snapshot \`ref\`，仅在无可用语义节点时以 \`builtin-browser_click({ x, y })\` 作为视觉兜底。
4. **显式等待，禁止盲目重试**：页面异步渲染或请求未完成时，使用 \`builtin-browser_wait_for\`（支持 \`text\`、\`selector\`、\`load_state\`）替代空转重试。
5. **交互与诊断**：支持 \`builtin-browser_hover\`、\`builtin-browser_press_key\`、\`builtin-browser_select_option\`、\`builtin-browser_scroll\`、\`builtin-browser_back\`、\`builtin-browser_tabs\`（多标签页）以及 \`builtin-browser_observe\`（控制台与网络日志诊断）。
6. **下载与上传**：下载后用 \`builtin-browser_downloads\` 等待完成并取得受控 runtime locator/hash；上传只用 \`builtin-browser_file_upload\`，文件必须来自已授权 runtime root 或本任务 artifacts（不会自动提交表单）。
7. **结束清理**：任务完成后调用 \`builtin-browser_close\` 释放浏览器资源。

## 定位规则

- 默认**优先**使用最新 snapshot 返回的 \`ref\`（如 \`e12\`）；仅在 Canvas/图标等缺少语义节点且已通过 \`builtin-browser_screenshot\` 确认位置时使用 \`x\`/\`y\` 坐标兜底。
- \`ref\` 仅对最近一次 snapshot 有效；页面跳变后必须重新 snapshot。
`,
  embeddedTools: [
    {
      name: 'builtin-browser_open',
      description: `${PREFER_FETCH} 打开内置浏览器并导航到 URL（High 审批）。成功后返回页面 accessibility snapshot。`,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target http/https URL to open.' },
          new_context: { type: 'boolean', description: 'Close any existing session and start fresh.' },
          headless: { type: 'boolean', description: 'Prefer headless execution mode when supported.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_navigate',
      description: `${PREFER_FETCH} 在已打开的浏览器中导航到 URL；完成后返回精简 accessibility snapshot。`,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target http/https URL to navigate to.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_snapshot',
      description: `${PREFER_FETCH} 获取当前页 accessibility/DOM 快照（含 e 前缀 ref）。支持 diff 增量模式与 selector 局部限定，默认仅含可交互元素以节省 token。`,
      inputSchema: {
        type: 'object',
        properties: {
          interactive_only: {
            type: 'boolean',
            description: 'Include primarily interactive controls and landmarks (default true).',
          },
          max_chars: {
            type: 'integer',
            minimum: 500,
            maximum: 24000,
            description: 'Maximum characters to return.',
          },
          start_index: {
            type: 'integer',
            minimum: 0,
            description: 'Character offset for paging long snapshots.',
          },
          diff: {
            type: 'boolean',
            description: 'Return only line-level changes relative to the previous snapshot.',
          },
          selector: {
            type: 'string',
            description: 'Optional CSS selector to scope the snapshot.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_screenshot',
      description:
        '捕获当前 WebView 真实像素截图并写入任务产物，支持 full_page 与 annotate ref 标注。平台无截图 API 时返回 available=false 与 reasonCode，绝不伪造或用 accessibility snapshot 代替。',
      inputSchema: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: 'Capture beyond the current viewport when supported.' },
          annotate: { type: 'boolean', description: 'Overlay interactive element ref labels on the screenshot.' },
          max_width: {
            type: 'integer',
            minimum: 200,
            maximum: 4096,
            description: 'Optional target maximum width in pixels.',
          },
          quality: {
            type: 'integer',
            minimum: 10,
            maximum: 100,
            description: 'Optional image quality (uses JPEG when below 100).',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_click',
      description: `${PREFER_FETCH} 按最新 snapshot 的 ref（如 e12）或视口坐标 (x, y) 点击元素，支持双击与右键。成功后默认附带新 snapshot（可开启 diff_snapshot）。`,
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. e12).' },
          x: { type: 'number', description: 'Viewport X coordinate when clicking by coordinates.' },
          y: { type: 'number', description: 'Viewport Y coordinate when clicking by coordinates.' },
          element: { type: 'string', description: 'Human-readable description of the target element.' },
          double_click: { type: 'boolean', description: 'Perform a double-click instead of a single click.' },
          button: {
            type: 'string',
            enum: ['left', 'middle', 'right'],
            description: 'Mouse button to click (default left).',
          },
          include_snapshot: {
            type: 'boolean',
            description: 'Include an updated page snapshot after clicking (default true).',
          },
          diff_snapshot: {
            type: 'boolean',
            description: 'Use diff mode for the post-action snapshot.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_type',
      description: `${PREFER_FETCH} 向 ref 指定的输入框填入文本。密码/OTP 框会被硬拒，需用户接管。支持 clear 清空与 submit 回车提交。`,
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. e5).' },
          element: { type: 'string', description: 'Human-readable description of the input element.' },
          text: { type: 'string', description: 'Text to type into the element.' },
          clear: { type: 'boolean', description: 'Clear existing text before typing.' },
          submit: { type: 'boolean', description: 'Press Enter after typing to submit.' },
          include_snapshot: {
            type: 'boolean',
            description: 'Include an updated page snapshot after typing (default true).',
          },
          diff_snapshot: {
            type: 'boolean',
            description: 'Use diff mode for the post-action snapshot.',
          },
        },
        required: ['ref', 'text'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_hover',
      description: '将指针悬停到指定 snapshot ref 或视口坐标 (x, y) 上（用于触发下拉菜单或提示浮层）。',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from the latest snapshot.' },
          x: { type: 'number', description: 'Viewport X coordinate.' },
          y: { type: 'number', description: 'Viewport Y coordinate.' },
          element: { type: 'string', description: 'Human-readable description of the target element.' },
          include_snapshot: {
            type: 'boolean',
            description: 'Include an updated page snapshot after hovering.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_press_key',
      description: '向页面发送键盘按键事件（如 Enter、Escape、Tab、ArrowDown），支持组合修饰键。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name to press (e.g. Enter, Escape, Tab, ArrowDown, a).' },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
            description: 'Optional modifier keys held during the key press.',
          },
          include_snapshot: {
            type: 'boolean',
            description: 'Include an updated page snapshot after pressing the key.',
          },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_select_option',
      description: '按 snapshot ref 在 <select> 下拉框中选择一个或多个选项。',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref of the select element.' },
          values: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Option values or labels to select.',
          },
          element: { type: 'string', description: 'Human-readable description of the select element.' },
          include_snapshot: {
            type: 'boolean',
            description: 'Include an updated page snapshot after selection.',
          },
        },
        required: ['ref', 'values'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_wait_for',
      description: '等待页面出现指定文本、匹配 CSS 选择器或达到目标加载状态（load / domcontentloaded / networkidle）。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Substring to wait for in visible page text.' },
          selector: { type: 'string', description: 'CSS selector to wait for in the DOM.' },
          load_state: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
            description: 'Page lifecycle state to wait for.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 100,
            maximum: 30000,
            description: 'Maximum time to wait in milliseconds.',
          },
          include_snapshot: {
            type: 'boolean',
            description: 'Include an updated page snapshot once condition is met.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_extract_content',
      description: '将当前页面的主要可读正文提取为干净的 Markdown 文本，适合阅读文章、论文与登录后文档。',
      inputSchema: {
        type: 'object',
        properties: {
          max_chars: {
            type: 'integer',
            minimum: 500,
            maximum: 24000,
            description: 'Maximum characters to return.',
          },
          start_index: {
            type: 'integer',
            minimum: 0,
            description: 'Character offset for paging long extracts.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_file_upload',
      description:
        '将已授权 runtime root 或本任务 artifacts 中的文件设置到网页 file input。只接受 root_id + relative_path，不接受裸主机路径；不会自动提交表单。High 审批。',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref of the file input.' },
          files: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                root_id: {
                  type: 'string',
                  description: 'Runtime root identifier (workspace, authorized root, or artifacts).',
                },
                relative_path: {
                  type: 'string',
                  description: 'Relative path inside the runtime root.',
                },
              },
              required: ['root_id', 'relative_path'],
            },
            description: 'Authorized files to attach.',
          },
          element: { type: 'string', description: 'Human-readable description of the file input.' },
          include_snapshot: {
            type: 'boolean',
            description: 'Include an updated page snapshot after attaching files.',
          },
        },
        required: ['ref', 'files'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_downloads',
      description:
        '观察当前浏览器会话的下载开始/处理/完成/失败状态。Agent 下载被强制写入本任务 artifacts，并在完成后返回 runtime locator、SHA-256 与字节数。',
      inputSchema: {
        type: 'object',
        properties: {
          wait_for_terminal: {
            type: 'boolean',
            description: 'Wait until in-progress downloads reach a terminal state (default true).',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 0,
            maximum: 30000,
            description: 'Maximum wait time in milliseconds.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_scroll',
      description: `${PREFER_FETCH} 滚动页面或将元素滚入视口。需要视口外内容时使用，之后可附带 diff_snapshot。`,
      inputSchema: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Scroll direction (default down).',
          },
          amount: { type: 'number', description: 'Scroll amount in pixels or step units.' },
          ref: { type: 'string', description: 'Optional element ref to scroll into view or scroll within.' },
          include_snapshot: {
            type: 'boolean',
            description: 'Include an updated page snapshot after scrolling (default true).',
          },
          diff_snapshot: {
            type: 'boolean',
            description: 'Use diff mode for the post-action snapshot.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_back',
      description: `${PREFER_FETCH} 浏览器历史后退；成功后返回新页面 snapshot。`,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_close',
      description: `${PREFER_FETCH} 关闭本会话浏览器并释放资源。任务完成或用户要求停止浏览时调用。`,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_tabs',
      description: '管理当前浏览器会话的多标签页：列出、打开新标签页、切换或关闭标签页。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'new', 'switch', 'close'],
            description: 'Tab management operation.',
          },
          url: { type: 'string', description: 'Target URL when action is new.' },
          tab_id: { type: 'string', description: 'Target tab identifier when action is switch or close.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-browser_observe',
      description: '读取当前浏览器会话最近的控制台日志与网络请求记录，用于排查页面报错与接口异常。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['console', 'network', 'both'],
            description: 'Log stream to inspect.',
          },
          level: {
            type: 'string',
            description: 'Optional console log level filter (e.g. error, warn, log).',
          },
          status_min: {
            type: 'integer',
            minimum: 100,
            maximum: 599,
            description: 'Optional minimum HTTP status code filter for network logs.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Maximum number of entries to return.',
          },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
  ],
};
