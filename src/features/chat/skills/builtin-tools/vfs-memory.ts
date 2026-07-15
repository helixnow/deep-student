/**
 * VFS 记忆技能组
 *
 * 包含记忆读取、写入、列表、更新、删除等工具
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const vfsMemorySkill: SkillDefinition = {
  id: 'vfs-memory',
  name: 'vfs-memory',
  description: 'VFS 记忆管理能力组，包含记忆读取、写入、列表、更新、删除等工具。你应主动使用这些工具：回答前检索相关记忆以个性化回复，发现用户偏好/背景/目标时主动保存，用户纠正信息时更新旧记忆。',
  version: '2.1.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://vfs-memory',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  dependencies: ['knowledge-retrieval'],
  content: `# VFS 记忆管理技能

你拥有持久记忆能力，可以跨对话记住用户信息。**主动使用记忆**是提供优质个性化服务的关键。

## 三种记忆类型

### 1. 原子事实（fact，默认）
每条是关于用户的**一个简短陈述句**（≤ 50 字）。
✅ "高三理科生" / "数学是弱项" / "偏好表格形式总结" / "高考在2026年6月7日"
❌ 写一篇知识点总结 / 罗列错题分析

### 2. 学习记忆（study，仅用户明确要求时）——偏**客观知识/资料**
用户明确说"保存这些词汇/知识点/错题要点/复习内容"时，使用 \`memory_type: "study"\`。
- 保存**客观性学习资料**：词汇释义、知识点、错题要点、复习提纲等（≤ 4000 字）
- 判断标准：内容本身是**可查证的知识/资料**，换一个人看也成立
- 不参与用户画像自动提取，但会进入记忆库供检索/复习/Anki 导出
- 批量学习内容优先用 \`builtin-memory_write_batch\`

✅ study 示例：用户说"把这些单词存进记忆系统" → \`memory_type: "study"\`

### 3. 经验笔记（note，仅用户明确要求时）——偏**主观经验/方法论**
用户明确说"记住/保存这个方法/技巧/经验"时，使用 \`memory_type: "note"\`。
- 保存**主观性经验内容**：方法论、解题技巧、学习经验、个人总结等（≤ 2000 字）
- 判断标准：内容包含**个人视角/策略/技巧**，换一个人不一定适用
- 不受"原子事实"限制，不受"禁止学科知识"限制
- 触发前提：**用户明确要求保存**，不要自作主张存 note

✅ note 示例：用户说"帮我记住这个解题方法" → \`memory_type: "note"\`
❌ 错误使用：自动把对话中的知识内容存为 note（用户没有要求时不用 note）

## 何时应主动使用记忆

### 主动读取（每次对话都应考虑）
- 回答涉及用户个人情况的问题前，先搜索相关记忆
- 需要做个性化决策时（推荐、规划、格式选择），先查看用户偏好
- 用户提到"之前/上次/老规矩"时，检索历史记忆

### 主动写入
**系统已内置自动记忆提取 pipeline，会自动从对话中提取用户事实（fact）。** 手动写入场景：
- 用户**明确要求**"记住"某些信息 → 按内容类型选择 fact、study 或 note
- 用户**纠正**了你的理解 → fact 类型更新旧记忆
- 用户要求**保存词汇/知识点/复习资料** → study 类型
- 用户要求**保存方法论/经验/技巧** → note 类型
- 自动提取可能遗漏的**隐含偏好** → fact 类型

## 工具选择指南

### 查询记忆
- **builtin-unified_search**: 搜索记忆内容（推荐首选，同时搜索知识库和记忆）
- **builtin-memory_read**: 读取指定记忆的完整内容
- **builtin-memory_list**: 列出记忆目录结构

### 写入记忆
- **builtin-memory_write_smart**: 智能写入（推荐首选），自动判断新增/更新/追加
- **builtin-memory_write**: 创建新记忆或更新现有记忆
- **builtin-memory_update_by_id**: 按 ID 精确更新记忆
- **builtin-memory_update_tags**: 用 OCC 版本替换用户标签，保留系统标签
- **builtin-memory_add_relation** / **builtin-memory_remove_relation**: 用两个 OCC 版本原子维护双向关联
- **builtin-memory_batch_move**: 最多 20 条、逐条 OCC 地移动记忆
- **builtin-memory_export_all**: High 敏感分页导出，每页最多 20 条

### 删除记忆
- **builtin-memory_delete**: 删除指定记忆（用户要求忘记时使用）

### 学习者画像（长期策展层）
- **builtin-learner_profile_get**: 读取学习者画像（薄弱知识点/学习偏好/学习目标/近期状态）
- **builtin-learner_profile_update**: 结构化增量更新画像（merge 语义，非整体覆盖）

画像与普通记忆的分工：画像是**策展的长期层**（随会话自动注入，总量 ≤4000 字符，宁精勿滥）；
普通记忆是可检索的事实库。发现**反复出现**的错误模式、明确的偏好/目标变化时才更新画像；
单次做题流水不要写画像（系统会自动记入每日学习日志，可用 memory_search 检索"学习日志"）。

## 记忆分类

记忆按文件夹分类存储：

### fact 类型文件夹
- **偏好**: 用户的个人偏好和习惯（格式偏好、风格偏好、负面偏好等）
- **偏好/个人背景**: 身份、年级、学校、专业方向
- **经历**: 用户的重要经历、计划和进度
- **经历/时间节点**: 考试日期、截止日期等时间约束
- **经历/学科状态**: 强项/弱项、成绩记录、学习进度

### study 类型文件夹（客观知识/资料）
- **知识**: study 类型的默认根文件夹
- **知识/英语词汇**: 单词、短语、例句等
- **知识/学科知识点**: 数学公式、物理定律、化学方程式等
- **知识/错题要点**: 错题记录、易错点汇总等
- **知识/复习提纲**: 复习大纲、章节要点等

### note 类型文件夹（主观经验/方法论）
- **经验**: note 类型的默认根文件夹
- **经验/解题方法**: 解题策略、思路模板等
- **经验/学习技巧**: 记忆法、笔记法、时间管理等
- **经验/易错总结**: 个人总结的易错规律、避坑经验等

## 使用建议

1. 写入前先用 builtin-unified_search 搜索是否有相关记忆，避免重复
2. 优先使用 memory_write_smart，它能自动处理新增/更新逻辑
3. **更新记忆 SOP**：先用 builtin-unified_search 查出目标记忆的 note_id，再用 builtin-memory_update_by_id 按 ID 精准更新。**严禁在未查询 ID 的情况下盲目更新**
4. 写入后简短告知用户即可，如"（已记住你的 XX 偏好）"
5. **fact 类型**：每条 ≤ 50 字，一条记忆 = 一个事实。study/note 类型不受此限制，按各自字数上限执行
6. **OCC 规则**：移动、标签和关系写入前必须用 memory_read/list 获取最新 \`updated_at\`；冲突后重新读取，禁止盲目重试。双向关系必须分别提供 A、B 两条记忆的版本
7. **批量移动**：每次最多 20 条，\`expected_updated_at_by_id\` 的键必须与 \`note_ids\` 完全一致；允许部分成功，按 \`results\` 逐项核对
8. **导出**：memory_export_all 是 High 敏感隐私导出，必须由用户批准；每页最多 20 条，内容字段超过 2000 字符会标记 \`content_truncated=true\`，仅在确有需要时继续下一页
9. 写操作成功后后端发出 \`memory://changed\`，打开中的记忆视图应据此刷新
`,
  allowedTools: [
    'builtin-memory_read',
    'builtin-memory_write',
    'builtin-memory_update_by_id',
    'builtin-memory_delete',
    'builtin-memory_write_smart',
    'builtin-memory_write_batch',
    'builtin-memory_list',
    'builtin-memory_batch_move',
    'builtin-memory_add_relation',
    'builtin-memory_remove_relation',
    'builtin-memory_update_tags',
    'builtin-memory_export_all',
    'builtin-learner_profile_get',
    'builtin-learner_profile_update',
  ],
  embeddedTools: [
    {
      name: 'builtin-memory_read',
      description: '读取指定记忆的完整内容与真实当前位置、标签、双向关联 ID、updated_at。当 unified_search 返回记忆摘要不够详细，或关系/标签/移动写入需要 OCC 基线时使用；note_id 从 unified_search 或 memory_list 获取。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: {
            type: 'string',
            description: '【必填】记忆笔记 ID（从 unified_search 的记忆结果或 memory_list 中获取）',
          },
        },
        required: ['note_id'],
      },
    },
    {
      name: 'builtin-memory_write',
      description: '创建或更新用户记忆（仅用于 fact 类型）。记忆只存储关于用户的原子事实（≤50字的短句），禁止存入学科知识/题目分析/文档摘要。study/note 类型请用 memory_write_smart。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: {
            type: 'string',
            description: '可选：指定 note_id 则按 ID 更新/追加该记忆',
          },
          folder: {
            type: 'string',
            description: '记忆分类文件夹路径，如 "偏好"、"偏好/个人背景"、"经历"、"经历/时间节点"、"经历/学科状态"。留空表示存储在记忆根目录。',
          },
          title: {
            type: 'string',
            description: '【必填】记忆标题（事实的关键词概括，如"数学弱项"、"高考日期"、"格式偏好-表格"）',
          },
          content: {
            type: 'string',
            description: '【必填】一个关于用户的简短陈述句，≤50字。示例："高三理科生" / "数学是弱项科目" / "偏好表格形式的总结"。禁止写入学科知识、解题过程、知识点总结。',
          },
          mode: {
            type: 'string',
            description: '写入模式：create=新建, update=替换同名记忆, append=追加',
            enum: ['create', 'update', 'append'],
          },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'builtin-memory_update_by_id',
      description: '按 note_id 精确更新记忆。必须先用 builtin-unified_search 查出 note_id，再调用此工具。严禁未查询 ID 直接更新。用于用户纠正信息、偏好变化、补充已有记忆等场景。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: {
            type: 'string',
            description: '【必填】记忆笔记 ID（从 unified_search 的记忆结果或 memory_list 获取）',
          },
          title: { type: 'string', description: '可选：新的记忆标题' },
          content: {
            type: 'string',
            description: '可选：新的记忆内容（Markdown 格式）',
          },
        },
        required: ['note_id'],
        anyOf: [{ required: ['title'] }, { required: ['content'] }],
      },
    },
    {
      name: 'builtin-memory_delete',
      description: '删除指定记忆（软删除）。当用户明确要求"忘掉"、"不要记"、"删除这条记忆"时立即执行。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: {
            type: 'string',
            description: '【必填】记忆笔记 ID（从 unified_search 的记忆结果或 memory_list 获取）',
          },
        },
        required: ['note_id'],
      },
    },
    {
      name: 'builtin-memory_write_smart',
      description: '智能写入记忆（推荐首选）。支持三种类型：fact（默认，用户事实）、study（用户明确要求保存的学习内容）和 note（用户明确要求保存的经验/方法论/技巧）。fact 类型自动去重；study/note 走显式保存路径。',
      inputSchema: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: '记忆分类文件夹路径。fact: "偏好/..."、"经历/..."；study: "知识/..."；note: "经验/..."。留空表示存储在记忆根目录。',
          },
          title: {
            type: 'string',
            description: '【必填】记忆标题（fact: 事实关键词；study: 知识点/词汇名；note: 方法论概括）',
          },
          content: {
            type: 'string',
            description: '【必填】记忆内容。fact：关于用户的简短陈述句。study：用户要求保存的学习内容。note：用户要求保存的经验、方法论、技巧。',
          },
          memory_type: {
            type: 'string',
            enum: ['fact', 'study', 'note'],
            description: '记忆类型。fact（默认）：关于用户的原子事实。study：用户明确要求保存的学习内容（词汇/知识点/错题要点）。note：用户明确要求保存的经验笔记/方法论/学习技巧。',
          },
          memory_purpose: {
            type: 'string',
            enum: ['internalized', 'memorized', 'supplementary', 'systemic'],
            description: '记忆目的。internalized：用户需要理解并内化的核心内容（最高优先级）。memorized（默认）：需要单独记忆的事实。supplementary：辅助理解的补充知识。systemic：系统用于理解用户的元信息。',
          },
          idempotency_key: {
            type: 'string',
            description: '可选：幂等键。重试同一次写入时复用该键，避免重复写入。',
          },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'builtin-memory_write_batch',
      description: '批量写入记忆。适合用户明确要求一次性保存多条词汇/知识点/要点。默认 memory_type=study。',
      inputSchema: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: '默认文件夹路径，单条 item 未指定时使用。',
          },
          memory_type: {
            type: 'string',
            enum: ['fact', 'study', 'note'],
            description: '默认记忆类型；批量保存学习内容时建议用 study。',
            default: 'study',
          },
          memory_purpose: {
            type: 'string',
            enum: ['internalized', 'memorized', 'supplementary', 'systemic'],
            description: '默认记忆目的。',
          },
          items: {
            type: 'array',
            description: '要保存的记忆项列表。',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                content: { type: 'string' },
                folder: { type: 'string' },
                memory_type: {
                  type: 'string',
                  enum: ['fact', 'study', 'note'],
                },
                memory_purpose: {
                  type: 'string',
                  enum: ['internalized', 'memorized', 'supplementary', 'systemic'],
                },
              },
              required: ['title', 'content'],
            },
          },
        },
        required: ['items'],
      },
    },
    {
      name: 'builtin-memory_list',
      description: '分页列出记忆目录结构和笔记列表。当需要了解用户已有哪些记忆、或浏览特定分类下的记忆时使用。返回 items、count、limit、offset、has_more 与 next_offset；需要正文时再用 memory_read。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          folder: {
            type: 'string',
            description: '相对于记忆根目录的文件夹路径，留空表示根目录',
          },
          limit: {
            type: 'integer',
            description: '返回数量限制，默认及最多20条',
            default: 20,
            minimum: 1,
            maximum: 20,
          },
          offset: {
            type: 'integer',
            description: '分页偏移量，默认0',
            default: 0,
            minimum: 0,
          },
        },
      },
    },
    {
      name: 'builtin-memory_batch_move',
      description: '批量移动 1–20 条记忆到记忆根目录内的目标文件夹（Medium）。逐条执行并返回真实成功/失败结果；每条都必须提供 memory_read/list 返回的 updated_at OCC 基线。成功项返回新版本与可执行的逐项撤销调用。',
      inputSchema: {
        type: 'object',
        properties: {
          note_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
            items: { type: 'string', minLength: 1 },
            description: '【必填】要移动的记忆 ID，最多 20 条且不得重复',
          },
          target_folder_path: {
            type: 'string',
            maxLength: 1000,
            description: '【必填】相对于记忆根目录的目标路径；空字符串表示记忆根目录',
          },
          expected_updated_at_by_id: {
            type: 'object',
            minProperties: 1,
            additionalProperties: { type: 'string', minLength: 1 },
            description: '【必填】以 note_id 为键、最新 updated_at 为值的完整 OCC 映射，键必须与 note_ids 完全一致',
          },
        },
        required: ['note_ids', 'target_folder_path', 'expected_updated_at_by_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-memory_add_relation',
      description: '原子添加两条记忆的双向关联（Medium）。必须先读取 A、B 当前 updated_at；成功返回两端真实关联列表、新版本及 remove_relation 撤销调用。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id_a: {
            type: 'string',
            minLength: 1,
            description: '【必填】关联端点 A 的记忆 ID',
          },
          note_id_b: {
            type: 'string',
            minLength: 1,
            description: '【必填】关联端点 B 的记忆 ID，必须与 A 不同',
          },
          expected_updated_at_a: {
            type: 'string',
            minLength: 1,
            description: '【必填】A 最新的 updated_at OCC 基线',
          },
          expected_updated_at_b: {
            type: 'string',
            minLength: 1,
            description: '【必填】B 最新的 updated_at OCC 基线',
          },
        },
        required: ['note_id_a', 'note_id_b', 'expected_updated_at_a', 'expected_updated_at_b'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-memory_remove_relation',
      description: '原子移除两条记忆的双向关联（Medium）。必须先读取 A、B 当前 updated_at；成功返回两端真实关联列表、新版本及 add_relation 撤销调用。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id_a: {
            type: 'string',
            minLength: 1,
            description: '【必填】关联端点 A 的记忆 ID',
          },
          note_id_b: {
            type: 'string',
            minLength: 1,
            description: '【必填】关联端点 B 的记忆 ID，必须与 A 不同',
          },
          expected_updated_at_a: {
            type: 'string',
            minLength: 1,
            description: '【必填】A 最新的 updated_at OCC 基线',
          },
          expected_updated_at_b: {
            type: 'string',
            minLength: 1,
            description: '【必填】B 最新的 updated_at OCC 基线',
          },
        },
        required: ['note_id_a', 'note_id_b', 'expected_updated_at_a', 'expected_updated_at_b'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-memory_update_tags',
      description: '替换一条记忆的用户标签（Medium），以下划线开头的系统标签始终保留且不能由 Agent 注入。必须传最新 updated_at；返回实际写后标签、新版本及撤销调用。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: {
            type: 'string',
            minLength: 1,
            description: '【必填】记忆 ID',
          },
          tags: {
            type: 'array',
            maxItems: 50,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 200 },
            description: '【必填】完整用户标签列表；空数组表示清除所有用户标签，系统标签不受影响',
          },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description: '【必填】memory_read/list 返回的最新 updated_at OCC 基线',
          },
        },
        required: ['note_id', 'tags', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-memory_export_all',
      description: '分页导出用户全部记忆（High，涉及大规模隐私读取，必须逐次审批）。每页最多 20 条，返回标题、内容、路径、标签、类型、目的和 updated_at；单条内容最多返回 2000 字符并用 content_truncated 标记。',
      inputSchema: {
        type: 'object',
        properties: {
          page: {
            type: 'integer',
            minimum: 1,
            default: 1,
            description: '页码，从 1 开始',
          },
          page_size: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            default: 20,
            description: '每页数量，最大 20',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-learner_profile_get',
      description: '读取学习者画像（长期策展层）：薄弱知识点（科目/知识点/错误模式/证据计数）、学习偏好、学习目标、近期状态。返回结构化 JSON 与渲染后的 Markdown。画像已随会话自动注入 system prompt，仅在需要完整结构（如更新前核对）时调用。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'builtin-learner_profile_update',
      description: '结构化增量更新学习者画像（merge 语义，非整体覆盖）。仅在发现反复出现的错误模式、明确的偏好/目标变化时使用；单次做题流水不要写入画像。画像总量硬上限 4000 字符，超限会被拒绝并要求精炼。',
      inputSchema: {
        type: 'object',
        properties: {
          weak_points_add: {
            type: 'array',
            description: '新增/强化薄弱知识点（按 科目+知识点 upsert，证据计数累加）',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string', description: '科目，如"数学"' },
                knowledge_point: {
                  type: 'string',
                  description: '知识点，如"二次函数"',
                },
                error_pattern: {
                  type: 'string',
                  description: '错误模式一句话概括，如"配方时符号处理错误"',
                },
                evidence_count: {
                  type: 'integer',
                  description: '本次观察到的证据次数（默认 1）',
                  minimum: 1,
                },
                last_seen: {
                  type: 'string',
                  description: '最近观察日期 YYYY-MM-DD（可选）',
                },
              },
              required: ['subject', 'knowledge_point', 'error_pattern'],
            },
          },
          weak_points_remove: {
            type: 'array',
            description: '移除已克服的薄弱知识点（按 科目+知识点 匹配）',
            items: {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                knowledge_point: { type: 'string' },
              },
              required: ['subject', 'knowledge_point'],
            },
          },
          preferences: {
            type: 'object',
            description: '学习偏好字段级补丁（仅覆盖提供的字段）',
            properties: {
              explanation_style: {
                type: 'string',
                description: '讲解风格，如"先结论后推导"',
              },
              language: { type: 'string', description: '语言偏好' },
              pace: { type: 'string', description: '学习节奏' },
              others_add: {
                type: 'array',
                items: { type: 'string' },
                description: '追加的其他偏好（去重）',
              },
              others_remove: {
                type: 'array',
                items: { type: 'string' },
                description: '移除的其他偏好（精确匹配）',
              },
            },
          },
          goals_add: {
            type: 'array',
            description: '新增学习目标（按目标文本去重）',
            items: {
              type: 'object',
              properties: {
                goal: {
                  type: 'string',
                  description: '目标描述，如"高考数学 130+"',
                },
                deadline: {
                  type: 'string',
                  description: '期限 YYYY-MM-DD（可选）',
                },
              },
              required: ['goal'],
            },
          },
          goals_remove: {
            type: 'array',
            items: { type: 'string' },
            description: '移除学习目标（按目标文本匹配）',
          },
          recent_status: {
            type: 'string',
            description: '覆盖近期状态摘要（1-2 句话，可选）',
          },
        },
      },
    },
  ],
};
