/**
 * 学习桌面（Workbench）Agent 工具组 — R1-08
 *
 * 负责查看窗口、打开/聚焦应用、发送窗口指令、关窗与查询状态。
 * 修改笔记/导图/待办等数据请用对应领域工具；本组只负责查看、导航与窗口指令。
 *
 * @see docs/dev/acr/DESIGN.md §3
 * @see docs/dev/acr/STANDARDS.md §3
 */

import type { SkillDefinition } from '../types';

const DIVISION =
  '修改笔记、导图、待办、题库、闪卡等数据请用对应领域工具；本组只负责查看、导航与窗口指令。';

const WORKBENCH_TYPE_IDS = [
  'chat',
  'note',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
  'mindmap',
  'files',
  'todo',
  'skills',
  'templates',
  'taskDashboard',
  'flashcards',
  'browser',
  'settings',
  'pomodoro',
  'sandbox',
] as const;

export const workbenchToolsSkill: SkillDefinition = {
  id: 'workbench-tools',
  name: 'workbench-tools',
  description:
    '学习桌面窗口操控：列出窗口、打开/聚焦应用、发送窗口指令、关闭窗口、查询焦点/指定窗状态。用户要求“展示/演示/让我看你操作”等可见操作时必须使用本组，并与 canvas-note 等领域工具配合完成真实窗口演出。受 tools.workbench_agent 与 desktop.workbenchAgentControl 双闸约束。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://workbench-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 学习桌面（Workbench）技能

在 OS 模式（学习桌面）下查看与导航窗口。受 \`tools.workbench_agent\` 与设置项 \`desktop.workbenchAgentControl\`（off / background / follow）双闸约束。

**三档语义**：
- \`off\`：\`list_windows\` / \`query_state\` **只读允许**；\`open_app\` / \`app_command\` / \`close_window\` 拒绝（\`WORKBENCH_DISABLED\`）
- \`background\`：允许操控，**不抢焦点**
- \`follow\`：允许操控，**自动聚焦**目标窗
- flag \`tools.workbench_agent\` 关：全部工具拒绝（含 list/query）

**分工铁律**：修改笔记、导图、待办、题库、闪卡等内容请用对应领域工具（canvas-note / mindmap-tools / user-todo-tools 等）。本组工具负责**看见、打开、聚焦、发窗口指令、关窗**。当用户要求可见操作时，两类工具必须配合：不要只调用后台领域工具，也不要只开窗后就宣称内容修改完成。

## 推荐剧本

1. **侦察**：先调用 \`builtin-workbench_list_windows\`，确认已有窗口、焦点窗、dirty 状态，避免盲目开窗。
2. **操作**：
   - 需要新窗或聚焦已有资源 → \`builtin-workbench_open_app\`
   - 对已开窗发一次性指令（滚动、导航、开始复习等）→ \`builtin-workbench_app_command\`
   - 需要应用内部状态摘要 → \`builtin-workbench_query_state\`
   - 关窗（High 审批）→ \`builtin-workbench_close_window\`
3. **确认**：用工具回执中的 windowId / handled / status 确认结果；不要假设开窗成功。

## 可见笔记演示

用户说“展示一下操作笔记的能力”“演示笔记操作”“让我看你改笔记”等时，按以下顺序执行：

1. 调用 \`builtin-workbench_list_windows\` 侦察当前桌面，避免重复开窗或打断 dirty 窗口。
2. 若用户未指定目标，配合 canvas-note 的 \`builtin-note_list\` 选择已有笔记；不得自行创建演示笔记，也不得编造笔记 id。
3. 调用 \`builtin-workbench_open_app\`，传入 \`typeId: "note"\`、目标笔记 id 作为 \`instanceKey\`、\`focus: true\`，打开或聚焦笔记窗口。
4. 仅展示导航且未获写入授权时，可调用 \`builtin-workbench_app_command\` 滚动到已有标题，再用 \`builtin-workbench_query_state\` 确认；不要修改数据。
5. 用户明确指定修改内容后，调用 canvas-note 的 \`builtin-note_append\` / \`builtin-note_replace\`。窗口已打开时，领域工具会通过 ACR \`probe -> apply_ops\` 在前端真实演出 AgentStrip、AI 光标/高亮、节奏与进度；不要用 Workbench 指令伪造内容编辑。
6. 最后读取笔记或查询窗口状态确认结果。若 ACR 降级到后台数据面，要如实告诉用户这次没有发生可见演出。

**安全边界**：单纯“展示能力”不等于授权创建、覆盖或改写用户内容。只有用户明确要求创建新笔记时才调用 \`builtin-note_create\`；只有用户明确要求完整重写时才调用 \`builtin-note_set\`。

## open_app payload 字典

| typeId | instanceKey | payload |
|--------|-------------|---------|
| note / mindmap / textbook / exam / … | = 资源 id | 通常省略 |
| files | 可选 | \`{ folderId }\` |
| flashcards | 可选 | \`{ screen, mode, cardIds }\` |
| todo | 可选 | \`{ todoListId }\` |
| browser | 可选 | \`{ url }\` |
| chat / settings / pomodoro / sandbox | single 应用多为 null | 按需 |

## 降级说明

若工具返回错误码 \`WORKBENCH_UNAVAILABLE\` / \`WORKBENCH_DISABLED\`（桌面未开启、桥未挂载、闸门关闭、control=off 拒写导航）：
- **不要重试**本组导航工具（\`off\` 时 list/query 仍可用）
- 改用对应**领域工具**直接读写数据（笔记/导图/待办等）
- 向用户说明「桌面模式未就绪或操控已关，已改走数据面」

## 何时不用

- 只需后台改笔记正文、用户不要求看见操作 → canvas-note
- 只需改导图节点 → mindmap-tools
- 只需改用户待办 → user-todo-tools
- 静态网页只读 → web-fetch（交互浏览再用 browser 领域工具）
`,
  allowedTools: [
    'builtin-workbench_list_windows',
    'builtin-workbench_open_app',
    'builtin-workbench_app_command',
    'builtin-workbench_close_window',
    'builtin-workbench_query_state',
  ],
  embeddedTools: [
    {
      name: 'builtin-workbench_list_windows',
      description: [
        '【目的】列出学习桌面当前所有窗口摘要（标题、typeId、lifecycle、焦点、dirty）。',
        '【何时用】操作前侦察桌面状态；确认目标窗是否已开、是否有未保存编辑。',
        '【何时不用】已知 windowId 且只需单窗状态时用 query_state；不要用本工具代替领域数据查询。',
        '【副作用】只读，不开窗、不改数据。',
        `【分工】${DIVISION}`,
        '【成功返回】{ windows: WindowSummary[], focused?: windowId }。',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'builtin-workbench_open_app',
      description: [
        '【目的】打开或聚焦指定应用窗口；已存在同 typeId+instanceKey 时聚焦而非重复创建。',
        '【何时用】需要用户看见某个应用/资源，或为后续 app_command 准备目标窗。',
        '【何时不用】只需改数据且不必开窗时用领域工具；不要用本工具写入笔记/导图内容。',
        '【副作用】可能创建新窗口并（follow 档）抢焦点；background 档可能不抢焦点。',
        '【payload 字典】files→{folderId}；flashcards→{screen,mode,cardIds}；todo→{todoListId}；browser→{url}；note/mindmap 等 content 类用 instanceKey=资源 id。',
        `【分工】${DIVISION}`,
        '【成功返回】{ windowId, created: boolean }。闸门关闭时返回 WORKBENCH_DISABLED。',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['typeId'],
        properties: {
          typeId: {
            type: 'string',
            enum: [...WORKBENCH_TYPE_IDS],
            description: '【必填】应用类型 id',
          },
          instanceKey: {
            type: 'string',
            description: '可选：资源/会话 id（note/mindmap 等 = 资源 id；single 应用可省略）',
          },
          payload: {
            type: 'object',
            additionalProperties: true,
            description:
              '可选：启动载荷。files→{folderId}；flashcards→{screen,mode,cardIds}；todo→{todoListId}；browser→{url}',
          },
          focus: {
            type: 'boolean',
            description: '可选：是否请求聚焦该窗（受 follow/background 档约束）',
          },
        },
      },
    },
    {
      name: 'builtin-workbench_app_command',
      description: [
        '【目的】向已打开（或可兜底打开）的应用窗口发送一次性指令（= activate action）。',
        '【何时用】滚动到消息/标题、浏览器导航、导图聚焦节点、开始复习、番茄钟控制等导航类操作。',
        '【何时不用】增删改笔记/导图/待办条目等内容——请用领域工具。',
        '【副作用】可能聚焦目标窗并改变其 UI 状态（滚动位置、当前列表等）；不直接改持久化业务数据（除非该 action 本身触发应用内逻辑）。',
        '【action 清单】workbench: focusWindow/minimizeWindow/unminimizeWindow/maximizeWindow/restoreWindow/tileLeft/tileRight/tileTopLeft/tileTopRight/tileBottomLeft/tileBottomRight/tileAll/showDesktop；chat: setInput/focusInput/scrollToMessage；browser: navigate/focusAddress/takeOver/showContent；mindmap: focusNode/setView；note: scrollToHeading；exam: focusQuestion/nextQuestion/previousQuestion/setFilters/resetFilters/setPracticeMode/setFocusMode/showSettings；todo: showList/focusItem/showView/search/setFilters；files: openFolder/reveal/goBack/goForward/goUp/search/setViewMode/setSorting/select/selectAll/clearSelection/refresh；flashcards: startReview/showScreen/startDueReview/flipCard/endReview；pomodoro: start/pause/resume/stop；sandbox: refresh/setViewport/setInspector/setMode/closeSession；textbook/file: scrollToHeading（需 payload.page）。',
        `【分工】${DIVISION}`,
        '【成功返回】{ handled: boolean }；未处理时看 message/hint。',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['typeId', 'action'],
        properties: {
          typeId: {
            type: 'string',
            enum: ['workbench', ...WORKBENCH_TYPE_IDS],
            description: '【必填】目标应用类型 id',
          },
          instanceKey: {
            type: 'string',
            description: '可选：目标实例/资源 id',
          },
          action: {
            type: 'string',
            description:
              '【必填】语义指令名。窗口布局使用 focusWindow/minimizeWindow/unminimizeWindow/maximizeWindow/restoreWindow/tileLeft/tileRight/tileTopLeft/tileTopRight/tileBottomLeft/tileBottomRight/tileAll/showDesktop',
          },
          payload: {
            type: 'object',
            additionalProperties: true,
            description: '可选：指令参数（如 {messageId}、{nodeId}、{url}、{heading} 等）',
          },
        },
      },
    },
    {
      name: 'builtin-workbench_close_window',
      description: [
        '【目的】关闭指定窗口（走 canClose；有未保存编辑可能被拦截）。',
        '【何时用】用户明确要求关窗，或确认任务结束且窗内无未保存重要编辑。',
        '【何时不用】仅想切走焦点时用 open_app/focus，不要关窗；不确定 dirty 时先 list_windows。',
        '【副作用】⚠️ High 敏感度，需用户审批。关闭后窗口销毁；若 canClose 拒绝则 closed:false。可能丢失未保存编辑（若用户批准且应用未拦截）。',
        `【分工】${DIVISION}`,
        '【成功返回】{ closed: boolean }。',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['windowId'],
        properties: {
          windowId: {
            type: 'string',
            description: '【必填】要关闭的窗口 id（来自 list_windows）',
          },
        },
      },
    },
    {
      name: 'builtin-workbench_query_state',
      description: [
        '【目的】查询焦点窗或指定窗的应用状态摘要（typeId/title/instanceKey/lifecycle，及 driver 扩展字段）。',
        '【何时用】需要比 list_windows 更细的单窗状态，或确认焦点落在哪类应用上。',
        '【何时不用】需要全桌面清单时用 list_windows；需要笔记正文/导图节点内容时用领域 read 工具。',
        '【副作用】只读，不改窗口与数据。',
        `【分工】${DIVISION}`,
        '【成功返回】{ typeId, title, instanceKey, lifecycle, ...driverExt }；无焦点/找不到窗时带可行动错误。',
      ].join(' '),
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['scope'],
        properties: {
          scope: {
            type: 'string',
            enum: ['focused', 'window'],
            description: '【必填】focused=当前焦点窗；window=指定 windowId',
          },
          windowId: {
            type: 'string',
            description: 'scope=window 时【必填】目标窗口 id',
          },
        },
      },
    },
  ],
};
