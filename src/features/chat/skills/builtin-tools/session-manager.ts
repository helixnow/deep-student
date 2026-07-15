/**
 * 会话管理元技能
 *
 * 让 AI 具备管理自身会话的完整能力闭环：
 * - 查询：列表、搜索、统计
 * - 阅读：分页读取消息正文与块摘要
 * - 组织：分组、打标、重命名
 * - 维护：导出、归档、批量操作
 *
 * 安全设计：
 * - 读操作：直接执行
 * - 写操作：Medium 敏感度
 * - 破坏性操作（归档/批量移动）：High 敏感度 + 指令强制要求 ask_user 确认
 * - 硬性禁止：不暴露删除工具，只允许归档
 */

import type { SkillDefinition } from '../types';

const SESSION_MANAGER_TOOL_NAMES = [
  'builtin-session_list',
  'builtin-session_search',
  'builtin-session_get',
  'builtin-session_get_messages',
  'builtin-session_export',
  'builtin-group_list',
  'builtin-tag_list_all',
  'builtin-session_stats',
  'builtin-session_tag_add',
  'builtin-session_tag_remove',
  'builtin-session_move',
  'builtin-session_rename',
  'builtin-group_create',
  'builtin-group_update',
  'builtin-session_archive',
  'builtin-session_restore',
  'builtin-session_batch_move',
  'builtin-session_batch_tag',
  'builtin-session_batch_ops',
] as const;

export const sessionManagerSkill: SkillDefinition = {
  id: 'session-manager',
  name: 'session-manager',
  description:
    '会话管理能力组，让 AI 具备查询、阅读、导出、组织和维护用户会话的能力。当用户需要整理会话、搜索或总结历史对话、导出会话、批量打标签、查看会话统计时使用。',
  version: '1.1.0',
  author: 'Deep Student',
  priority: 5,
  location: 'builtin',
  sourcePath: 'builtin://session-manager',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  dependencies: ['ask-user'],
  relatedSkills: ['learning-resource', 'dstu-tools', 'canvas-note'],
  content: `# 会话管理技能

## 角色
你是用户的会话管理助手，帮助用户查询、组织和维护他们的聊天会话。

## 核心能力
1. **查询与阅读** — 列出会话、按日期搜索、读取消息全文、查看统计
2. **导出** — 返回单会话 Markdown，或把单会话原文创建为资源库笔记
3. **组织** — 创建分组、移动会话、打标签、重命名
4. **维护** — 归档旧会话、批量整理

## 安全规则（必须严格遵守）

### 🔴 绝对禁止
- 永远不要硬删除会话，只能归档；不暴露会话硬删除工具
- 不编辑消息，也不创建、切换或删除消息变体；这些操作当前没有 Agent 工具
- 不要修改当前正在进行的会话
- 不要在没有用户明确同意的情况下执行批量操作

### 🟡 需要确认（使用 ask_user 工具）
以下操作**必须**先调用 \`builtin-ask_user\` 获取用户确认后再执行：
- **归档会话**（session_archive）
- **批量移动**（session_batch_move，涉及 3 个以上会话时）
- **批量打标**（session_batch_tag，涉及 5 个以上会话时）
- **统一批量操作**（session_batch_ops，涉及 3 个以上会话或包含 archive 时）

确认后，调用 \`session_batch_ops\` 时应显式传入 \`confirmed=true\`。
同理，\`session_batch_move\`（>3）和 \`session_batch_tag\`（>5）也应传 \`confirmed=true\`。

确认时，清晰展示将要执行的操作和影响范围。

### 🟢 可直接执行
- 所有 Low 读操作（列表、搜索、统计、获取元数据、分页读取消息）
- 单个会话的标签添加/移除
- 单个会话的移动/重命名
- 创建新分组

## 工具与敏感度
- \`session_list\`、\`session_search\`、\`session_get\`、\`session_get_messages\`、\`group_list\`、\`tag_list_all\`、\`session_stats\`：Low，只读。
- \`session_export\`：Medium。即使 \`format=markdown\` 只返回文本，该工具按统一后端策略仍为 Medium；\`format=note\` 会创建资源库笔记。
- 单项组织写操作与恢复操作：Medium；归档和达到阈值的批量操作按上面的确认规则执行。

## 工作流程

### 1. 会话整理流程（用户说"帮我整理会话"）
\`\`\`
1. session_stats → 了解整体情况
2. session_list → 查看所有活跃会话
3. tag_list_all → 查看现有标签体系
4. group_list → 查看现有分组
5. 分析会话标题/描述，提出分组方案
6. ask_user → 确认方案
7. 按方案执行：group_create → session_batch_move
\`\`\`

### 2. 搜索流程（用户说"我之前聊过XXX"）
\`\`\`
1. session_search(query, date_from?, date_to?) → 全文搜索，可按会话更新时间过滤
2. 展示搜索结果，包含会话标题和内容片段
3. session_get 只补充标题、标签、分组和时间等元数据，不返回消息全文
4. 需要深入阅读时，对命中的 session_id 调用 session_get_messages，从 page=1 开始逐页读取，直到 hasMore=false
\`\`\`

### 3. 总结上周问题并保存
\`\`\`
1. 根据当前日期计算上周的 date_from/date_to
2. session_search(query, date_from, date_to) → 搜索上周内容，并对 sessionId 去重
3. session_get_messages(session_id, page=1, page_size=20, role_filter=user) → 按 hasMore 逐页读取用户问题
4. 汇总多个会话中的问题；不得把搜索片段当成完整消息
5. 用户只需单会话原文时，session_export(format=markdown|note, range?)；format=note 可指定 folder_id/title
6. 用户要把“跨会话汇总正文”保存为一篇笔记时，调用 load_skills(["learning-resource", "dstu-tools", "canvas-note"])；用 builtin-folder_list 查找目标文件夹，不存在时用 builtin-dstu_folder_create 创建，再用 builtin-note_create(content, folder_id, title) 写入已经生成的汇总
7. session_export(note) 只导出一个会话的原文，不能冒充保存跨会话汇总正文
\`\`\`

### 4. 清理流程（用户说"帮我清理旧会话"）
\`\`\`
1. session_list(status=active) → 获取所有活跃会话
2. 分析哪些会话较旧且可能不再需要
3. 列出建议归档的会话清单
4. ask_user → 确认归档列表
5. 逐个 session_archive
\`\`\`

## 输出格式
- 列表结果使用表格形式展示（标题 | 时间 | 分组 | 标签）
- 统计信息使用结构化摘要
- 操作结果简洁明了地反馈

## 注意事项
- 当前会话的 session_id 可以从上下文中获取，但不要对当前会话执行归档操作
- 会话 ID 格式为 \`sess_xxx\`，分组 ID 格式为 \`group_xxx\`
- \`session_get\` 仅返回元数据；消息正文必须使用 \`session_get_messages\`
- \`session_get_messages\` 返回正文、时间戳和块摘要；工具输出块只返回摘要，长字段可能截断，应检查 truncated 标记
- 标签是自由文本，推荐使用简短的中文标签
- 分组数量建议控制在 10 个以内，保持简洁
- 归档操作可通过 session_restore 撤销，告知用户操作是可逆的
`,
  allowedTools: [...SESSION_MANAGER_TOOL_NAMES],
  embeddedTools: [
    // ====================================================================
    // 读操作
    // ====================================================================
    {
      name: 'builtin-session_list',
      description:
        '列出会话列表。支持按状态（active/archived/deleted）和分组筛选，带分页。返回会话的 ID、标题、模式、分组、创建/更新时间。',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'archived', 'deleted'],
            description: '按状态筛选，不传则返回所有状态',
          },
          group_id: {
            type: 'string',
            description:
              '按分组 ID 筛选。传空字符串 "" 筛选未分组的会话，传 "*" 筛选所有已分组的会话',
          },
          include_tags: {
            type: 'boolean',
            description: '是否在结果中包含每个会话的标签，默认 false。整理会话时建议设为 true。',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            default: 20,
            description: '返回数量限制，默认 20，最大 20',
          },
          offset: {
            type: 'integer',
            description: '分页偏移量，默认 0',
          },
        },
      },
    },
    {
      name: 'builtin-session_search',
      description:
        '跨会话全文搜索消息内容（Low，只读），可按会话 updated_at 日期范围过滤。返回 results、count、query、dateFrom、dateTo；每条结果含 sessionId、sessionTitle、messageId、role、snippet、updatedAt。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            description: '【必填】搜索关键词',
          },
          date_from: {
            type: 'string',
            minLength: 1,
            description: '可选：会话更新时间下界（含），格式为 YYYY-MM-DD 或 RFC3339。',
          },
          date_to: {
            type: 'string',
            minLength: 1,
            description: '可选：会话更新时间上界（含），格式为 YYYY-MM-DD 或 RFC3339；不得早于 date_from。',
          },
          limit: {
            type: 'integer',
            default: 20,
            minimum: 1,
            maximum: 50,
            description: '返回数量限制，默认 20，最大 50。',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'builtin-session_get',
      description: '仅获取单个会话的元数据（Low，只读），包括标题、描述、标签、分组名称和时间；不返回消息正文，不能用于深入阅读会话内容。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: '【必填】会话 ID（sess_xxx 格式）',
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-session_get_messages',
      description:
        '分页读取单个会话的消息正文、时间戳、附件元数据和块摘要（Low，只读）。工具输出块仅返回摘要以限制体积；返回 sessionId、sessionTitle、messages、page、pageSize、roleFilter、total、hasMore，长字段可能带 truncated=true。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: {
            type: 'string',
            minLength: 1,
            description: '【必填】会话 ID（sess_xxx 格式）。',
          },
          page: {
            type: 'integer',
            minimum: 1,
            default: 1,
            description: '【必填】1-based 页码，从 1 开始。',
          },
          page_size: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            default: 20,
            description: '【必填】每页消息数，范围 1-20。',
          },
          role_filter: {
            type: 'string',
            enum: ['user', 'assistant'],
            description: '可选：只返回用户消息或助手消息。',
          },
        },
        required: ['session_id', 'page', 'page_size'],
      },
    },
    {
      name: 'builtin-session_export',
      description:
        '导出一个会话或其消息区间（Medium）。format=markdown 返回 success、format、sessionId、title、range、messageCount、markdown、totalChars和truncated；markdown 最多返回 2000 字符预览，完整内容需用 format=note 无损写入资源库。format=note 返回 folderId、noteId、resourceId、path，不返回跨会话汇总正文。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: {
            type: 'string',
            minLength: 1,
            description: '【必填】要导出的单个会话 ID（sess_xxx 格式）。',
          },
          format: {
            type: 'string',
            enum: ['markdown', 'note'],
            description: '【必填】markdown 仅返回文本；note 将原会话内容创建为资源库笔记。',
          },
          range: {
            type: 'object',
            additionalProperties: false,
            description: '可选：按消息 ID 指定闭区间；省略边界表示从会话开头或直到会话结尾。',
            properties: {
              start_message_id: {
                type: 'string',
                minLength: 1,
                description: '可选：区间第一条消息 ID（包含）。',
              },
              end_message_id: {
                type: 'string',
                minLength: 1,
                description: '可选：区间最后一条消息 ID（包含）。',
              },
            },
          },
          folder_id: {
            type: 'string',
            minLength: 1,
            description: 'format=note 时可选：目标资源库文件夹 ID；省略则使用默认笔记文件夹。',
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            description: '可选：导出标题；省略时使用会话标题。',
          },
        },
        required: ['session_id', 'format'],
      },
    },
    {
      name: 'builtin-group_list',
      description: '列出所有活跃的会话分组，包括名称、描述、图标、颜色、默认技能等信息。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'builtin-tag_list_all',
      description: '列出所有标签及其使用次数，了解当前的标签体系。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'builtin-session_stats',
      description:
        '获取会话统计信息：总数、各状态数量、分组分布、标签 Top 10。用于快速了解用户的会话全局情况。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },

    // ====================================================================
    // 写操作
    // ====================================================================
    {
      name: 'builtin-session_tag_add',
      description: '给指定会话添加一个标签。标签为自由文本，推荐简短中文。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: '【必填】会话 ID',
          },
          tag: {
            type: 'string',
            description: '【必填】要添加的标签文本',
          },
        },
        required: ['session_id', 'tag'],
      },
    },
    {
      name: 'builtin-session_tag_remove',
      description: '移除指定会话的一个标签。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: '【必填】会话 ID',
          },
          tag: {
            type: 'string',
            description: '【必填】要移除的标签文本',
          },
        },
        required: ['session_id', 'tag'],
      },
    },
    {
      name: 'builtin-session_move',
      description: '将会话移入指定分组，或移出分组（group_id 不传则移出）。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: '【必填】会话 ID',
          },
          group_id: {
            type: 'string',
            description: '目标分组 ID。不传或传空字符串则将会话移出分组。',
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-session_rename',
      description: '重命名会话标题。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: '【必填】会话 ID',
          },
          title: {
            type: 'string',
            description: '【必填】新标题',
          },
        },
        required: ['session_id', 'title'],
      },
    },
    {
      name: 'builtin-group_create',
      description: '创建新的会话分组。',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '【必填】分组名称',
          },
          description: {
            type: 'string',
            description: '分组描述',
          },
          icon: {
            type: 'string',
            description: '分组图标（emoji）',
          },
          color: {
            type: 'string',
            description: '分组颜色（hex，如 #FF6B6B）',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'builtin-group_update',
      description: '更新分组信息（名称、描述、图标、颜色）。只传需要更新的字段。',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: {
            type: 'string',
            description: '【必填】分组 ID',
          },
          name: {
            type: 'string',
            description: '新名称',
          },
          description: {
            type: 'string',
            description: '新描述',
          },
          icon: {
            type: 'string',
            description: '新图标',
          },
          color: {
            type: 'string',
            description: '新颜色',
          },
        },
        required: ['group_id'],
      },
    },

    // ====================================================================
    // 危险操作（skill 指令要求先 ask_user 确认）
    // ====================================================================
    {
      name: 'builtin-session_archive',
      description:
        '归档一个活跃会话。⚠️ 必须先使用 ask_user 向用户确认。不能归档当前正在使用的会话，只能归档 active 状态的会话。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: '【必填】要归档的会话 ID（不能是当前会话，必须是 active 状态）',
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-session_restore',
      description:
        '恢复一个已归档或已删除的会话为活跃状态。用于撤销误归档操作。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: '【必填】要恢复的会话 ID（必须是 archived 或 deleted 状态）',
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-session_batch_move',
      description:
        '批量移动多个会话到指定分组。⚠️ 超过 3 个会话时必须先使用 ask_user 确认，并传 confirmed=true。单次最多 50 个。',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: {
            type: 'boolean',
            description: '超过 3 个会话时必须为 true，表示已获得用户确认。',
          },
          session_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '【必填】会话 ID 列表',
          },
          group_id: {
            type: 'string',
            description: '目标分组 ID。不传则移出分组。',
          },
        },
        required: ['session_ids'],
      },
    },
    {
      name: 'builtin-session_batch_tag',
      description:
        '批量给多个会话添加同一标签。⚠️ 超过 5 个会话时必须先使用 ask_user 确认，并传 confirmed=true。单次最多 50 个。',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: {
            type: 'boolean',
            description: '超过 5 个会话时必须为 true，表示已获得用户确认。',
          },
          session_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '【必填】会话 ID 列表',
          },
          tag: {
            type: 'string',
            description: '【必填】要添加的标签',
          },
        },
        required: ['session_ids', 'tag'],
      },
    },
    {
      name: 'builtin-session_batch_ops',
      description:
        '统一批量会话操作。一次请求可混合执行 move/tag_add/tag_remove/rename/archive/restore 等动作，按 operations 顺序执行。最多涉及 50 个不同会话，且 operations 最多 200 条。⚠️ 涉及 3 个以上会话或包含 archive 时必须先 ask_user 确认，并在调用时传 confirmed=true。',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: {
            type: 'boolean',
            description:
              '高风险批量操作的显式确认标记。涉及 3 个以上会话或包含 archive 时必须为 true。',
          },
          operations: {
            type: 'array',
            description: '【必填】批量操作列表，按顺序执行',
            items: {
              type: 'object',
              properties: {
                session_id: {
                  type: 'string',
                  description: '【必填】目标会话 ID',
                },
                action: {
                  type: 'string',
                  enum: ['move', 'tag_add', 'tag_remove', 'rename', 'archive', 'restore'],
                  description: '【必填】操作类型',
                },
                group_id: {
                  type: 'string',
                  description: 'action=move 时使用。不传或传空字符串表示移出分组。',
                },
                tag: {
                  type: 'string',
                  description: 'action=tag_add/tag_remove 时必填。',
                },
                title: {
                  type: 'string',
                  description: 'action=rename 时必填。',
                },
              },
              required: ['session_id', 'action'],
            },
          },
        },
        required: ['operations'],
      },
    },
  ],
};
