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
    '学习桌面窗口操控：列出窗口、打开/聚焦应用、发送窗口指令、关闭窗口、查询焦点/指定窗状态。受 tools.workbench_agent 与 desktop.workbenchAgentControl 双闸约束。数据修改请用领域工具；本组只管看见与导航。',
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

**分工铁律**：修改笔记、导图、待办、题库、闪卡等内容请用对应领域工具（canvas-note / mindmap-tools / user-todo-tools 等）。本组工具只负责**看见、打开、聚焦、发窗口指令、关窗**。

## 推荐剧本

1. **侦察**：先调用 \`builtin-workbench_list_windows\`，确认已有窗口、焦点窗、dirty 状态，避免盲目开窗。
2. **操作**：
   - 需要新窗或聚焦已有资源 → \`builtin-workbench_open_app\`
   - 对已开窗发一次性指令（滚动、导航、开始复习等）→ \`builtin-workbench_app_command\`
   - 需要应用内部状态摘要 → \`builtin-workbench_query_state\`
   - 关窗（High 审批）→ \`builtin-workbench_close_window\`
3. **确认**：用工具回执中的 windowId / handled / status 确认结果；不要假设开窗成功。

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

- 只需改笔记正文 → canvas-note
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
        '【v1 action 清单】chat: setInput/focusInput/scrollToMessage；browser: navigate/focusAddress/takeOver/showContent；mindmap: focusNode/setView；note: scrollToHeading；exam: focusQuestion；todo: showList/focusItem；files: openFolder/reveal；flashcards: startReview；pomodoro: start/pause/resume/stop；textbook/file: scrollToHeading（需 payload.page）。',
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
            enum: [...WORKBENCH_TYPE_IDS],
            description: '【必填】目标应用类型 id',
          },
          instanceKey: {
            type: 'string',
            description: '可选：目标实例/资源 id',
          },
          action: {
            type: 'string',
            description:
              '【必填】指令名。v1：setInput/focusInput/scrollToMessage/navigate/focusAddress/takeOver/showContent/focusNode/setView/scrollToHeading/showList/focusItem/openFolder/reveal/startReview/focusQuestion/start/pause/resume/stop',
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
