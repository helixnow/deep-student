/**
 * 智能题目集技能组
 *
 * 支持题目管理、刷题练习、进度追踪
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const qbankToolsSkill: SkillDefinition = {
  id: 'qbank-tools',
  name: 'qbank-tools',
  description: '智能题目集完整能力组：建题与编辑、刷题与错题、限时练习和模拟考、检索分析、每日练习、收藏与组卷。当用户需要管理题目、练习、考试、分析薄弱知识点或生成试卷时使用。',
  version: '2.2.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://qbank-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 智能题目集技能

## 完整工作流

1. **建题**：单题使用 \`builtin-qbank_create_question\`；批量或文档使用
   \`builtin-qbank_batch_import\` / \`builtin-qbank_import_document\`。选择题的选项必须放在
   \`options\`，不得混入题干。
2. **练习**：普通练习先用 \`builtin-qbank_get_next_question\` 取题；错题复习传
   \`review_only=true\`。限时、模拟考、每日一练分别使用
   \`builtin-qbank_start_timed_practice\`、\`builtin-qbank_generate_mock_exam\`、
   \`builtin-qbank_get_daily_practice\`。
3. **用户作答**：\`agentCanAnswer=false\`。Agent 不得代替用户生成、猜测或提交答案。
   普通题的 \`builtin-qbank_submit_answer\` 只能提交用户明确给出的答案；限时练习和模拟考
   必须由用户在题库 UI 作答和交卷。交卷后如需分析成绩，加载 \`workbench-tools\` 并读取
   题库 Workbench observation 中的 \`scoreSummary\`；它是 UI 权威的脱敏成绩摘要，绝不包含答案或逐题判定。
4. **错题闭环**：读取作答/交卷回执中的错题 ID；需要去重时先搜索并逐题读取版本。
   收藏难题用 \`builtin-qbank_toggle_favorite\`，书签标记用 \`builtin-qbank_toggle_bookmark\`
   （两个独立标记位）。回看一道题的完整作答记录用 \`builtin-qbank_get_submissions\`，
   查看题目被修改的历史用 \`builtin-qbank_get_question_history\`。删除重复题是 High 且
   不可恢复：每次调用 \`builtin-qbank_delete_questions\` 前都必须加载 \`ask-user\`，使用
   \`builtin-ask_user\` 列明本次准确题目与数量并取得明确确认；授权永不记忆，禁止复用，
   无人值守/headless 场景不得执行。
5. **分析**：用 \`builtin-qbank_search_questions\`、\`builtin-qbank_get_stats\`、
   \`builtin-qbank_get_learning_trend\`、\`builtin-qbank_get_activity_heatmap\` 和
   \`builtin-qbank_get_knowledge_stats\` 找出薄弱知识点。分页读取直到 \`has_more=false\`，
   单页最多 20 条，不得把截断结果说成完整结果。
6. **批量整理**：批量改难度/状态/标签用 \`builtin-qbank_batch_update_questions\`
   （最多 20 题，逐题 OCC，非原子；冲突题不会被修改，按 \`results\` 重新规划）。
   题干/答案等内容修改仍须逐题 \`builtin-qbank_update_question\`。
7. **组卷**：\`builtin-qbank_generate_paper\` 的 \`preview\` 只返回内存预览，
   \`export_path=null\` 且不会创建文件；\`markdown\` 才在应用数据目录
   \`exports/qbank/*.md\` 创建真实文件并返回路径。不得请求或声称已生成 PDF/Word。

## UI 混合模式

限时练习、模拟考、每日一练依赖题库 UI。工具返回版本化 \`handoff\`；它随当前 Chat
工具结果持久保存（\`handoff_persisted=true\`、\`handoff_durability="chat_tool_result"\`），
但题库领域 session 在 UI 水合前仍为 \`session_persisted=false\`。返回
\`requires_user_interaction=true\`、\`agentCanAnswer=false\` 和 \`workbenchAction\`，
**不代表 UI 已经打开**。需要用户作答时加载 \`workbench-tools\`，
调用 \`workbenchAction.tool\`，并只把 \`workbenchAction.arguments\` 原样作为工具参数；
只有 Workbench 返回 authoritative ACK 后才能说题目集已打开且会话已注入。
\`workbenchAction.executed=false\`、\`payloadHydrationSupported=true\`；动作会严格校验 exam/session、
拒绝预填答案或进度，并把 timed/mock/daily session 注入题库 store。跨轮可从原工具结果重放
同一 handoff；任何作答和交卷仍必须由用户在 UI 完成。

## 并发与撤销

- 更新、收藏、删除前先用 \`builtin-qbank_get_question\` 读取最新 \`updated_at\`；冲突后
  重新读取并重新规划，禁止盲重试。
- 创建返回 \`reversible=false/reversibleWithApproval=true\`：其 undo 指向 High 批删，仍须
  针对准确题目重新 ask_user。更新返回 \`reversible=false/reversibleWithOcc=true\`，须基于
  \`previous\` 和最新 OCC 版本人工构造反向更新；可空字段不保证自动清空。收藏切换才返回
  \`reversible=true\` 和可直接使用的精确 undo。任何撤销都只能使用最新回执参数。
- 批量删除虽为软删除，但当前没有 Agent 恢复工具，因此 \`reversible=false\`，不得宣称可撤销。
- 新增工具返回的题目对象是安全预览；content/answer/explanation/option content 单字段最多
  2000 字符并带 \`truncated\` 标记。需要全文时按精确 ID 重新读取，禁止把截断预览当全文。

## 主观题批改

先 \`builtin-qbank_submit_answer\` 提交用户明确提供的答案并读取 \`submission_id\`，再调用
\`builtin-qbank_ai_grade\`。评判工具会真实调用模型并持久化 grade 结果；没有工具回执时
不得自行宣称已完成 AI 批改。

## 引用格式

创建或导入题目集后，**必须**在回复中使用引用让用户可以直接点击打开：

- \`[题目集:session_id]\` — 基本引用
- \`[题目集:session_id:名称]\` — 带名称的引用（推荐）

**示例回复**：
> 我已为你创建了 [题目集:abc123:高等数学期中练习]，共导入了 25 道题目。点击可直接开始练习。

## 出题格式要求

使用 \`qbank_batch_import\` 创建题目时，必须正确设置题型和选项：

- **选择题**：\`question_type\` 设为 \`"single_choice"\` 或 \`"multiple_choice"\`，提供 \`options\` 数组（\`[{"key":"A","content":"..."}, ...]\`），\`answer\` 填选项字母（如 \`"A"\` 或 \`"ABD"\`）。不要把选项写在 content 题干里。
- **填空题**：\`question_type\` 设为 \`"fill_blank"\`，题干中用 \`____\` 表示空位；多空或多个可接受答案时提供
  \`structured_data\`：\`{"blanks":[{"answers":["答案1","备选答案"],"case_sensitive":false,"trim":true}]}\`（blanks 顺序与空位一一对应）
- **判断题**：\`question_type\` 设为 \`"true_false"\`，\`answer\` 只能是小写 \`"true"\` 或 \`"false"\`
- **匹配题**：\`question_type\` 设为 \`"matching"\`，**必须**提供 \`structured_data\`：
  \`{"left":[{"key":"L1","content":"..."}],"right":[{"key":"R1","content":"..."}],"pairs":[{"left":"L1","right":"R1"}]}\`
- **排序题**：\`question_type\` 设为 \`"ordering"\`，**必须**提供 \`structured_data\`：
  \`{"items":[{"key":"S1","content":"..."},{"key":"S2","content":"..."}],"correct_order":["S2","S1"]}\`（correct_order 是 items key 的一个排列）
- **数值题**：\`question_type\` 设为 \`"numeric"\`，**必须**提供 \`structured_data\`：
  \`{"answer_value":3.14,"tolerance":0.01,"unit":"m","tolerance_mode":"absolute"}\`（tolerance_mode 可选 absolute/relative）
- **简答/计算/证明题**：分别设 \`"short_answer"\`/\`"calculation"\`/\`"proof"\`
- **禁止**：如果题目明显有 A/B/C/D 选项，不要设为 \`"other"\`；structured_data 只允许用于 fill_blank/matching/ordering/numeric

## 新题型 user_answer 序列化格式

\`qbank_submit_answer\` 的 \`user_answer\` 统一为字符串：判断题 \`"true"\`/\`"false"\`；
数值题数字串如 \`"3.14"\`；多空填空 JSON 数组串 \`"[\\"答案1\\",\\"答案2\\"]"\`；
匹配题 \`"{\\"pairs\\":[{\\"left\\":\\"L1\\",\\"right\\":\\"R1\\"}]}"\`；排序题 JSON 数组串 \`"[\\"S2\\",\\"S1\\"]"\`。
判分由后端完成，Agent 不得自行判定新题型对错。

## 注意事项

- 创建/导入题目集后，工具返回的 \`session_id\` 用于引用格式中的 ID
- 批量导入和文档导入都会返回 \`session_id\` 和 \`name\`，请务必在回复中渲染引用
- 引用格式会被渲染为可点击的跳转徽章，用户点击后直接打开对应题目集
`,
  allowedTools: [
    'builtin-qbank_list',
    'builtin-qbank_list_questions',
    'builtin-qbank_get_question',
    'builtin-qbank_submit_answer',
    'builtin-qbank_update_question',
    'builtin-qbank_get_stats',
    'builtin-qbank_get_next_question',
    'builtin-qbank_generate_variant',
    'builtin-qbank_batch_import',
    'builtin-qbank_reset_progress',
    'builtin-qbank_export',
    'builtin-qbank_import_document',
    'builtin-qbank_ai_grade',
    'builtin-qbank_create_question',
    'builtin-qbank_delete_questions',
    'builtin-qbank_toggle_favorite',
    'builtin-qbank_toggle_bookmark',
    'builtin-qbank_get_submissions',
    'builtin-qbank_get_question_history',
    'builtin-qbank_batch_update_questions',
    'builtin-qbank_list_source_images',
    'builtin-qbank_start_timed_practice',
    'builtin-qbank_generate_mock_exam',
    'builtin-qbank_get_daily_practice',
    'builtin-qbank_get_check_in_calendar',
    'builtin-qbank_generate_paper',
    'builtin-qbank_search_questions',
    'builtin-qbank_get_learning_trend',
    'builtin-qbank_get_activity_heatmap',
    'builtin-qbank_get_knowledge_stats',
  ],
  embeddedTools: [
    {
      name: 'builtin-qbank_list',
      description: '分页列出用户的题目集（Low，只读），返回基本信息、可选学习统计以及 total、limit、offset、has_more、truncated。无需 session_id；单次最多 20 条，按 has_more 继续读取。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 20, description: '返回数量限制；单次最多 20 条' },
          offset: { type: 'integer', default: 0, minimum: 0, description: '偏移量（用于分页）' },
          search: { type: 'string', description: '搜索关键词（匹配题目集名称）' },
          include_stats: { type: 'boolean', default: true, description: '是否包含统计信息' },
        },
      },
    },
    {
      name: 'builtin-qbank_list_questions',
      description: '分页列出题目集中的题目（Low，只读）。支持按状态、难度、标签筛选，返回 total、page、page_size、questions、has_more、truncated。必须提供 session_id；单页最多 20 条。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          status: { type: 'string', enum: ['new', 'in_progress', 'mastered', 'review'], description: '筛选状态' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'], description: '筛选难度' },
          tags: { type: 'array', items: { type: 'string' }, description: '筛选标签' },
          page: { type: 'integer', default: 1, minimum: 1, description: '页码' },
          page_size: { type: 'integer', default: 20, minimum: 1, maximum: 20, description: '每页数量；单页最多 20 条' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_get_question',
      description: '获取单个题目的详细信息和 updated_at OCC 基线。update_question 前必须读取并原样传入该版本。必须提供 session_id 和 card_id。questions 表来源时额外返回 question_id（delete_questions/batch_update_questions 的版本映射以它为键）、structured_data（新题型判分数据）、is_favorite/is_bookmarked 和最近 5 条 recent_submissions（完整历史用 qbank_get_submissions）。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_id: { type: 'string', description: '【必填】题目卡片 ID' },
        },
        required: ['session_id', 'card_id'],
      },
    },
    {
      name: 'builtin-qbank_submit_answer',
      description: '提交用户明确提供的答案并判断正误（写操作）。Agent 不得生成、猜测或代替用户作答；必须提供 session_id、card_id 和 user_answer。自动更新题目状态和统计。判分由后端按题型完成（含 true_false/numeric/fill_blank 多空/matching/ordering）。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_id: { type: 'string', description: '【必填】题目卡片 ID' },
          user_answer: {
            type: 'string',
            description:
              '【必填】用户提交的答案（字符串）。按题型序列化：选择题选项字母（"A"/"ABD"）；true_false 为 "true"/"false"；numeric 为数字串（"3.14"）；fill_blank 多空为 JSON 数组串（"[\\"答案1\\",\\"答案2\\"]"）；matching 为 "{\\"pairs\\":[{\\"left\\":\\"L1\\",\\"right\\":\\"R1\\"}]}"；ordering 为 JSON 数组串（"[\\"S2\\",\\"S1\\"]"）',
          },
          is_correct: { type: 'boolean', description: '是否正确（可选，如果不提供则自动判断）' },
        },
        required: ['session_id', 'card_id', 'user_answer'],
      },
    },
    {
      name: 'builtin-qbank_update_question',
      description: '更新题目信息（Medium，OCC 反向更新）。支持题干、选项、题型和 structured_data（切换到 matching/ordering/numeric 必须同调用提供对应 structured_data）。必须先调用 qbank_get_question 取得最新 updated_at，并原样作为 expected_updated_at 传入；冲突后重新读取，禁止盲重试。成功返回 bounded question、bounded previous、changed_fields、updated_at、reversible=false、reversibleWithOcc=true 与 undo 提示；两份题目中长字段用 <field>_truncated、options[i].content_truncated 和 fieldsTruncated 标明截断，previous 的可空字段不保证能自动清空。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_id: { type: 'string', description: '【必填】题目卡片 ID' },
          content: { type: 'string', minLength: 1, maxLength: 50000, description: '更新题干' },
          question_type: {
            type: 'string',
            enum: ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'true_false', 'matching', 'ordering', 'numeric', 'short_answer', 'essay', 'calculation', 'proof', 'other'],
            description: '更新题型；选择题必须同时提供结构化 options；切换到 matching/ordering/numeric 必须同调用提供 structured_data',
          },
          structured_data: {
            type: 'object',
            description:
              '新题型结构化数据（仅 fill_blank/matching/ordering/numeric 允许）。fill_blank：{"blanks":[{"answers":["答案1","备选"],"case_sensitive":false,"trim":true}]}；matching：{"left":[{"key":"L1","content":"..."}],"right":[{"key":"R1","content":"..."}],"pairs":[{"left":"L1","right":"R1"}]}；ordering：{"items":[{"key":"S1","content":"..."}],"correct_order":["S2","S1"]}（correct_order 是 items key 的排列）；numeric：{"answer_value":3.14,"tolerance":0.01,"unit":"m","tolerance_mode":"absolute"}（tolerance_mode 可选 absolute/relative）',
          },
          options: {
            type: 'array',
            maxItems: 26,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', minLength: 1, description: '选项标识，如 A' },
                content: { type: 'string', minLength: 1, description: '选项内容' },
              },
              required: ['key', 'content'],
            },
            description: '更新结构化选项；传空数组表示清空（选择题不得为空）',
          },
          answer: { type: 'string', maxLength: 50000, description: '更新答案' },
          explanation: { type: 'string', maxLength: 100000, description: '更新解析' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'], description: '更新难度' },
          tags: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 100 },
            description: '更新完整标签列表；最多 50 个',
          },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', minLength: 1, description: 'VFS 附件 ID' },
                name: { type: 'string', description: '原始文件名' },
                mime: { type: 'string', description: 'MIME 类型' },
                hash: { type: 'string', description: '内容 SHA-256' },
              },
              required: ['id'],
            },
            description: '更新关联图片（结构化附件列表）。传空数组表示清空。',
          },
          user_note: { type: 'string', maxLength: 50000, description: '更新用户笔记' },
          status: { type: 'string', enum: ['new', 'in_progress', 'mastered', 'review'], description: '更新学习状态' },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description: '【必填】qbank_get_question 返回的 updated_at OCC 基线',
          },
        },
        required: ['session_id', 'card_id', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-qbank_get_stats',
      description: '获取题目集的学习统计信息，包括总题数、各状态数量、正确率等。必须提供 session_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_get_next_question',
      description: '获取下一道推荐题目（Low，只读）。支持顺序、随机、错题优先、知识点聚焦；review_only=true 时只从错题/待复习题中选择。必须提供 session_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          mode: {
            type: 'string',
            enum: ['sequential', 'random', 'review_first', 'by_tag'],
            default: 'sequential',
            description: '推题模式',
          },
          tag: { type: 'string', description: '当 mode=by_tag 时，指定要练习的标签' },
          current_card_id: { type: 'string', description: '当前题目 ID（用于顺序模式获取下一题）' },
          review_only: { type: 'boolean', default: false, description: '只选择 status=review 的错题/待复习题' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_generate_variant',
      description: '基于原题生成变式题。AI 会保持题目结构和考点，但改变具体数值或情境。必须提供 session_id 和 card_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_id: { type: 'string', description: '【必填】原题卡片 ID' },
          variant_type: {
            type: 'string',
            enum: ['similar', 'harder', 'easier', 'different_context'],
            default: 'similar',
            description: '变式类型',
          },
          parent_card_id: { type: 'string', description: '父题目的 card_id，用于关联变式题' },
        },
        required: ['session_id', 'card_id'],
      },
    },
    {
      name: 'builtin-qbank_batch_import',
      description: '批量导入题目到题目集（单次最多 200 道，校验失败整批不写入）。支持 JSON 格式的题目数据。必须提供 questions 数组。导入成功后，在回复中使用 [题目集:返回的session_id:名称] 格式让用户可点击查看。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '目标题目集 ID（可选，不提供则创建新题目集）' },
          name: { type: 'string', description: '新题目集名称（创建新题目集时使用）' },
          parent_card_id: { type: 'string', description: '默认父题 card_id（所有题目通用，可被题目内 parent_card_id 覆盖）' },
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '【必填】题干内容（不要把选项写在题干里，选项放 options 数组）' },
                answer: { type: 'string', description: '答案。选择题填选项字母（如 "A" 或 "ABD"），填空题填答案文本，true_false 填小写 "true"/"false"' },
                explanation: { type: 'string', description: '解析' },
                question_type: {
                  type: 'string',
                  enum: ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'true_false', 'matching', 'ordering', 'numeric', 'short_answer', 'essay', 'calculation', 'proof', 'other'],
                  description: '【重要】题型。有 A/B/C/D 选项的必须设为 single_choice 或 multiple_choice，不要设为 other；matching/ordering/numeric 必须同时提供 structured_data',
                },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string', description: '选项标识，如 A、B、C、D' },
                      content: { type: 'string', description: '选项内容' },
                    },
                    required: ['key', 'content'],
                  },
                  description: '选择题选项（question_type 为 single_choice/multiple_choice/indefinite_choice 时必填且不得为空）',
                },
                structured_data: {
                  type: 'object',
                  description:
                    '新题型结构化数据（仅 fill_blank/matching/ordering/numeric 允许；matching/ordering/numeric 必填）。fill_blank：{"blanks":[{"answers":["答案1","备选"],"case_sensitive":false,"trim":true}]}；matching：{"left":[{"key","content"}],"right":[...],"pairs":[{"left":"L1","right":"R1"}]}；ordering：{"items":[{"key","content"}],"correct_order":["S2","S1"]}；numeric：{"answer_value":3.14,"tolerance":0.01,"unit":"m","tolerance_mode":"absolute"}',
                },
                difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'] },
                tags: { type: 'array', items: { type: 'string' } },
                parent_card_id: { type: 'string', description: '父题目的 card_id，用于关联变式题' },
              },
              required: ['content'],
            },
            description: '要导入的题目列表（1-200 道）',
          },
        },
        required: ['questions'],
      },
    },
    {
      name: 'builtin-qbank_reset_progress',
      description: '重置题目集的学习进度（Medium，写操作）。可以重置全部或指定题目；必须提供 session_id。指定 card_ids 时返回 reset_count 与 missing_card_ids（不存在的题目不会被静默忽略；全部不存在则报错）。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_ids: { type: 'array', items: { type: 'string' }, description: '要重置的题目 ID 列表（可选，不提供则重置全部）' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_export',
      description: '导出题目集为 JSON、Markdown 或 DOCX 文件。必须提供 session_id。文件真实写入应用数据目录并返回 exportPath、fileSize 与最多 20 道题的截断预览；不会把完整 Markdown、JSON 或 DOCX base64 注入对话上下文。DOCX 含标题/粗体/斜体。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          format: { type: 'string', enum: ['json', 'markdown', 'docx'], default: 'json', description: '导出格式。docx 会生成 Word 文档。' },
          include_stats: { type: 'boolean', default: true, description: '是否包含学习统计' },
          filter_status: { type: 'string', enum: ['new', 'in_progress', 'mastered', 'review'], description: '只导出指定状态的题目' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_import_document',
      description:
        '从文档导入题目到题目集。支持 DOCX、TXT、MD、CSV 格式。超长文档将自动分块处理，每块独立调用 AI 解析，最后合并结果。当用户上传题目文档、想要批量导入题目时使用。导入成功后，在回复中使用 [题目集:返回的session_id:名称] 格式让用户可点击查看。',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '【必填】文档内容（纯文本或 base64 编码；csv 直接传文本）' },
          format: { type: 'string', enum: ['txt', 'md', 'docx', 'json', 'csv'], default: 'txt', description: '文档格式。csv 走与 txt/md 相同的 AI 结构化解析路径。' },
          name: { type: 'string', description: '题目集名称（可选，不提供则自动生成）' },
          session_id: { type: 'string', description: '目标题目集 ID（可选，不提供则创建新题目集）' },
          folder_id: { type: 'string', description: '目标文件夹 ID（创建新题目集时使用）' },
        },
        required: ['content'],
      },
    },
    {
      name: 'builtin-qbank_ai_grade',
      description: '对已经提交的题目执行真实 AI 评判（grade）或解析（analyze），返回完整反馈；grade 会持久化 verdict/score 并更新题目统计。先调用 qbank_submit_answer 获取 submission_id。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        anyOf: [
          { required: ['question_id'] },
          { required: ['session_id', 'card_id'] },
        ],
        properties: {
          question_id: { type: 'string', description: 'questions 表题目 ID；与 session_id+card_id 二选一' },
          session_id: { type: 'string', description: '题目集 ID；与 card_id 同时提供' },
          card_id: { type: 'string', description: '题目卡片 ID；与 session_id 同时提供' },
          submission_id: { type: 'string', minLength: 1, description: '【必填】qbank_submit_answer 返回的提交记录 ID' },
          mode: {
            type: 'string',
            enum: ['grade', 'analyze'],
            default: 'grade',
            description: 'grade 判定正误并评分；analyze 只生成解析',
          },
          model_config_id: { type: 'string', description: '可选模型配置 ID；省略则使用题库 AI 评判分配模型' },
        },
        required: ['submission_id'],
      },
    },
    {
      name: 'builtin-qbank_create_question',
      description: '在现有题目集中创建一道题（Medium）。session_id 即题目集 exam_id；返回 success、bounded question、previous=null、reversible=false、reversibleWithApproval=true 和精确 undo。question 的 content/answer/explanation/user_note/ai_feedback 单字段最多 2000 字符，以 <field>_truncated 和 fieldsTruncated 标明；options[i] 用 content_truncated。undo 指向 High 批删，仍须重新 ask_user 审批，并非无条件撤销。选择题必须传非空结构化 options。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '【必填】目标题目集 ID（exam_id）' },
          content: { type: 'string', minLength: 1, maxLength: 50000, description: '【必填】题干' },
          question_label: { type: 'string', maxLength: 120, description: '题号或短标签' },
          question_type: {
            type: 'string',
            enum: ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'true_false', 'matching', 'ordering', 'numeric', 'short_answer', 'essay', 'calculation', 'proof', 'other'],
            default: 'other',
            description: '题型；三种选择题必须提供非空 options；matching/ordering/numeric 必须提供 structured_data；true_false 的 answer 只能是小写 "true"/"false"',
          },
          structured_data: {
            type: 'object',
            description:
              '新题型结构化数据（仅 fill_blank/matching/ordering/numeric 允许；matching/ordering/numeric 必填）。fill_blank：{"blanks":[{"answers":["答案1","备选"],"case_sensitive":false,"trim":true}]}（blanks 与题干 ____ 空位一一对应）；matching：{"left":[{"key":"L1","content":"..."}],"right":[{"key":"R1","content":"..."}],"pairs":[{"left":"L1","right":"R1"}]}；ordering：{"items":[{"key":"S1","content":"..."}],"correct_order":["S2","S1"]}（correct_order 是 items key 的排列）；numeric：{"answer_value":3.14,"tolerance":0.01,"unit":"m","tolerance_mode":"absolute"}（tolerance_mode 可选 absolute/relative）',
          },
          options: {
            type: 'array',
            maxItems: 26,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', minLength: 1, description: '选项标识，如 A' },
                content: { type: 'string', minLength: 1, description: '选项内容' },
              },
              required: ['key', 'content'],
            },
            description: '结构化选项；选择题必填且不得为空',
          },
          answer: { type: 'string', maxLength: 50000, description: '标准答案' },
          explanation: { type: 'string', maxLength: 100000, description: '解析' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'], description: '难度' },
          tags: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 100 },
            description: '标签，最多 50 个',
          },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', minLength: 1, description: 'VFS 附件 ID' },
                name: { type: 'string', description: '原始文件名' },
                mime: { type: 'string', description: 'MIME 类型' },
                hash: { type: 'string', description: '内容 SHA-256' },
              },
              required: ['id'],
            },
            description: '结构化图片附件',
          },
          parent_id: { type: 'string', maxLength: 200, description: '父题的 questions 表 ID；与 parent_card_id 二选一' },
          parent_card_id: { type: 'string', maxLength: 200, description: '同一题目集内父题 card_id；与 parent_id 二选一' },
          source_ref: { type: 'string', maxLength: 1000, description: '可选来源引用' },
        },
        required: ['session_id', 'content'],
      },
    },
    {
      name: 'builtin-qbank_delete_questions',
      description: '批量软删除 1-20 道题（High，当前 Agent 不可恢复，reversible=false）。每次调用前都必须加载 ask-user 并用 builtin-ask_user 列明准确题目与数量取得确认；授权永不记忆、不得复用，无人值守/headless 不得执行。逐题先读取 updated_at，并以 questions 表 question_id 为键传入完整版本映射；原子 OCC 冲突时整批不删除。返回 deleted_count、deleted、soft_deleted 与 recovery。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'string', minLength: 1, maxLength: 200 },
            description: '【必填】questions 表题目 ID，精确列明本次删除范围',
          },
          expected_updated_at_by_id: {
            type: 'object',
            minProperties: 1,
            additionalProperties: { type: 'string', minLength: 1 },
            properties: {},
            description: '【必填】question_id 到最近一次 qbank_get_question.updated_at 的完整映射',
          },
        },
        required: ['question_ids', 'expected_updated_at_by_id'],
      },
    },
    {
      name: 'builtin-qbank_toggle_favorite',
      description: '切换一道题的收藏状态（Medium，OCC，可撤销）。用 question_id，或用同一题目集的 session_id+card_id 定位；先读最新 updated_at。返回 bounded question、previous.is_favorite、reversible=true 与精确 undo；长字段以 <field>_truncated、options[i].content_truncated 和 fieldsTruncated 标明 2000 字符截断。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        anyOf: [{ required: ['question_id'] }, { required: ['session_id', 'card_id'] }],
        properties: {
          question_id: { type: 'string', minLength: 1, description: 'questions 表题目 ID；与 session_id+card_id 二选一' },
          session_id: { type: 'string', minLength: 1, description: '题目集 ID；与 card_id 同时提供' },
          card_id: { type: 'string', minLength: 1, description: '题目卡片 ID；与 session_id 同时提供' },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】最近一次 qbank_get_question 返回的 updated_at' },
        },
        required: ['expected_updated_at'],
      },
    },
    {
      name: 'builtin-qbank_toggle_bookmark',
      description: '切换一道题的书签状态（Medium，OCC，可撤销）。书签与收藏是两个独立标记位。用 question_id，或用同一题目集的 session_id+card_id 定位；先读最新 updated_at。返回 bounded question、previous.is_bookmarked、reversible=true 与精确 undo；长字段以 <field>_truncated 和 fieldsTruncated 标明 2000 字符截断。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        anyOf: [{ required: ['question_id'] }, { required: ['session_id', 'card_id'] }],
        properties: {
          question_id: { type: 'string', minLength: 1, description: 'questions 表题目 ID；与 session_id+card_id 二选一' },
          session_id: { type: 'string', minLength: 1, description: '题目集 ID；与 card_id 同时提供' },
          card_id: { type: 'string', minLength: 1, description: '题目卡片 ID；与 session_id 同时提供' },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】最近一次 qbank_get_question 返回的 updated_at' },
        },
        required: ['expected_updated_at'],
      },
    },
    {
      name: 'builtin-qbank_get_submissions',
      description: '读取一道题的完整作答历史（Low，只读）。qbank_get_question 只带最近 5 条；本工具最多一次 20 条，按 submitted_at 倒序。返回 submissions（含 submission_id、user_answer、is_correct、grading_method、submitted_at）；user_answer 超 2000 字符时以 user_answer_truncated 标明；count 等于 limit 时可能还有更早记录（has_more=true 为近似值）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        anyOf: [{ required: ['question_id'] }, { required: ['session_id', 'card_id'] }],
        properties: {
          question_id: { type: 'string', minLength: 1, description: 'questions 表题目 ID；与 session_id+card_id 二选一' },
          session_id: { type: 'string', minLength: 1, description: '题目集 ID；与 card_id 同时提供' },
          card_id: { type: 'string', minLength: 1, description: '题目卡片 ID；与 session_id 同时提供' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: '返回条数，最多 20' },
        },
      },
    },
    {
      name: 'builtin-qbank_get_question_history',
      description: '读取一道题的字段变更历史（Low，只读），按时间倒序最多 20 条。返回 history（field_name、old_value/new_value 为 {text,truncated} 或 null、operator、reason、changed_at）；count 等于 limit 时可能还有更早记录。用于回答"这道题被改过什么"。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        anyOf: [{ required: ['question_id'] }, { required: ['session_id', 'card_id'] }],
        properties: {
          question_id: { type: 'string', minLength: 1, description: 'questions 表题目 ID；与 session_id+card_id 二选一' },
          session_id: { type: 'string', minLength: 1, description: '题目集 ID；与 card_id 同时提供' },
          card_id: { type: 'string', minLength: 1, description: '题目卡片 ID；与 session_id 同时提供' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: '返回条数，最多 20' },
        },
      },
    },
    {
      name: 'builtin-qbank_batch_update_questions',
      description: '批量更新 1-20 道题的学习元数据（Medium，逐题 OCC，非原子）。只支持 updates.difficulty/status/tags（tags 为完整替换）；题干/答案等内容修改请逐题用 qbank_update_question。必须以 question_id 为键传入完整 expected_updated_at_by_id。逐题独立提交：返回 updated_count/conflict_count/failed_count 与逐题 results；冲突题未被修改并附 current，须重新读取后规划，禁止盲重试。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'string', minLength: 1, maxLength: 200 },
            description: '【必填】questions 表题目 ID 列表（1-20 个）',
          },
          expected_updated_at_by_id: {
            type: 'object',
            minProperties: 1,
            additionalProperties: { type: 'string', minLength: 1 },
            properties: {},
            description: '【必填】question_id 到最近一次 qbank_get_question.updated_at 的完整映射',
          },
          updates: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'], description: '统一设置难度' },
              status: { type: 'string', enum: ['new', 'in_progress', 'mastered', 'review'], description: '统一设置学习状态' },
              tags: {
                type: 'array',
                maxItems: 50,
                items: { type: 'string', minLength: 1, maxLength: 100 },
                description: '统一替换完整标签列表（不是追加）',
              },
            },
            description: '【必填】要统一应用到所有题目的字段，至少一项',
          },
        },
        required: ['question_ids', 'expected_updated_at_by_id', 'updates'],
      },
    },
    {
      name: 'builtin-qbank_list_source_images',
      description: '分页列出题目集原始导入图片的元数据（Low，只读）。只返回 blob_hash 与 page_index，不含 base64 图片正文（data_included=false）；需要查看图片时引导用户在题库 UI 打开。返回 total/page/page_size/has_more/truncated，单页最多 20 条。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '【必填】题目集 ID' },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '单页最多 20 条' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_start_timed_practice',
      description: '选出一组限时练习题（Low，UI 混合模式）。返回随 Chat 工具结果持久保存的版本化 handoff 和尚未执行的 workbenchAction；不会自动打开 UI。返回 handoff_persisted=true、session_persisted=false、requires_user_interaction=true、agentCanAnswer=false、workbenchAction.executed=false/payloadHydrationSupported=true。Workbench authoritative ACK 后会话已注入，必须由用户作答。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '【必填】题目集 ID' },
          duration_minutes: { type: 'integer', minimum: 1, maximum: 480, default: 30, description: '限时分钟数' },
          question_count: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '抽取题数' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_generate_mock_exam',
      description: '按配置选出模拟考题目（Low，UI 混合模式）。返回随 Chat 工具结果持久保存的版本化 handoff 与尚未执行的 workbenchAction，不会自动打开 UI；handoff_persisted=true、session_persisted=false、requires_user_interaction=true、agentCanAnswer=false、workbenchAction.executed=false/payloadHydrationSupported=true。Workbench authoritative ACK 后会话已注入，作答必须由用户完成。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '【必填】题目集 ID' },
          config: {
            type: 'object',
            additionalProperties: false,
            properties: {
              duration_minutes: { type: 'integer', minimum: 1, maximum: 480, default: 60, description: '考试时长（分钟）' },
              total_count: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '总题数' },
              type_distribution: {
                type: 'object',
                properties: {},
                additionalProperties: { type: 'integer', minimum: 1, maximum: 100 },
                description: '题型到题数的映射，总和最多 100；键限 single_choice/multiple_choice/indefinite_choice/fill_blank/true_false/matching/ordering/numeric/short_answer/essay/calculation/proof/other',
              },
              difficulty_distribution: {
                type: 'object',
                properties: {},
                additionalProperties: { type: 'integer', minimum: 1, maximum: 100 },
                description: '难度到题数的映射，总和最多 100；键限 easy/medium/hard/very_hard',
              },
              shuffle: { type: 'boolean', default: true, description: '是否打乱题目' },
              include_mistakes: { type: 'boolean', default: true, description: '是否允许选入错题' },
              tags: {
                type: 'array',
                maxItems: 20,
                items: { type: 'string', minLength: 1, maxLength: 100 },
                description: '可选标签筛选，最多 20 个',
              },
            },
          },
        },
        required: ['session_id', 'config'],
      },
    },
    {
      name: 'builtin-qbank_get_daily_practice',
      description: '按错题、新题、复习题优先级选出每日一练（Low，UI 混合模式）。返回随 Chat 工具结果持久保存的版本化 handoff 和未执行的 workbenchAction；不会自动打开 UI，handoff_persisted=true、session_persisted=false、requires_user_interaction=true、agentCanAnswer=false、payloadHydrationSupported=true。Workbench authoritative ACK 后会话已注入，作答必须由用户完成。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '【必填】题目集 ID' },
          count: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: '每日练习题数，最多 20' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_get_check_in_calendar',
      description: '分页读取指定月份的做题打卡日历（Low，只读）。可限定题目集；返回 days、连续打卡/月统计以及 total/page/page_size/has_more/truncated，单页最多 20 天。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '可选题目集 ID；省略为全局' },
          year: { type: 'integer', minimum: 1970, maximum: 9999, description: '【必填】年份' },
          month: { type: 'integer', minimum: 1, maximum: 12, description: '【必填】月份' },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '单页最多 20 条' },
        },
        required: ['year', 'month'],
      },
    },
    {
      name: 'builtin-qbank_generate_paper',
      description: '按题型/难度/标签生成试卷（Medium）。preview 只返回内存预览，export_path=null、file_created=false；markdown 才真实写入应用数据目录 exports/qbank/*.md 并返回路径。仅支持 preview|markdown，PDF/Word 会被拒绝。返回 questions 最多 20 条并用 questions_truncated 标记题数截断；每个 bounded question 的长字段以 <field>_truncated、options[i].content_truncated 和 fieldsTruncated 标明 2000 字符截断。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '【必填】题目集 ID' },
          config: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', maxLength: 120, default: '练习试卷', description: '试卷标题' },
              type_selection: {
                type: 'object',
                properties: {},
                additionalProperties: { type: 'integer', minimum: 1, maximum: 100 },
                description: '题型到题数的映射，总和最多 100；键限 single_choice/multiple_choice/indefinite_choice/fill_blank/true_false/matching/ordering/numeric/short_answer/essay/calculation/proof/other',
              },
              question_count: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'type_selection 为空时随机选题并截断到此数量' },
              difficulty_filter: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'] }, description: '难度筛选' },
              tags_filter: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 }, description: '标签筛选，最多 20 个' },
              shuffle: { type: 'boolean', default: true, description: '是否打乱' },
              include_answers: { type: 'boolean', default: true, description: '是否包含答案' },
              include_explanations: { type: 'boolean', default: true, description: '是否包含解析' },
              export_format: { type: 'string', enum: ['preview', 'markdown'], default: 'preview', description: 'preview 不创建文件；markdown 创建 .md 文件' },
            },
          },
        },
        required: ['session_id', 'config'],
      },
    },
    {
      name: 'builtin-qbank_search_questions',
      description: '全文检索题干、答案和解析（Low，只读）。支持题目集/状态/难度/题型/标签/收藏筛选与排序；返回 results、total、page、page_size、has_more、search_time_ms、truncated。单页最多 20 条；每项 question 的长字段以 <field>_truncated、options[i].content_truncated 和 fieldsTruncated 标明 2000 字符截断；highlight_content/highlight_answer/highlight_explanation 为 {text,truncated} 或 null，不能把预览当全文。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keyword: { type: 'string', minLength: 1, maxLength: 200, description: '【必填】全文检索关键词' },
          session_id: { type: 'string', minLength: 1, description: '可选题目集 ID；省略为跨题目集检索' },
          status: { type: 'string', enum: ['new', 'in_progress', 'mastered', 'review'], description: '学习状态' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'], description: '难度' },
          question_type: { type: 'string', enum: ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'true_false', 'matching', 'ordering', 'numeric', 'short_answer', 'essay', 'calculation', 'proof', 'other'], description: '题型' },
          tags: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 }, description: '标签筛选' },
          is_favorite: { type: 'boolean', description: '是否只看收藏/未收藏' },
          sort_by: { type: 'string', enum: ['relevance', 'created_desc', 'created_asc', 'updated_desc'], default: 'relevance', description: '排序方式' },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '单页最多 20 条' },
        },
        required: ['keyword'],
      },
    },
    {
      name: 'builtin-qbank_get_learning_trend',
      description: '分页读取日期范围内的每日做题次数、正确数与正确率（Low，只读）。日期必须 YYYY-MM-DD、正序且跨度不超过 367 天；返回 points/total/page/page_size/has_more/truncated，单页最多 20 天。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '可选题目集 ID；省略为全局' },
          start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '【必填】开始日期 YYYY-MM-DD' },
          end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '【必填】结束日期 YYYY-MM-DD；跨度最多 367 天' },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '单页最多 20 条' },
        },
        required: ['start_date', 'end_date'],
      },
    },
    {
      name: 'builtin-qbank_get_activity_heatmap',
      description: '分页读取指定年份的学习活跃度热力图（Low，只读）。可限定题目集；返回 year、points、total、page、page_size、has_more、truncated，单页最多 20 天。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '可选题目集 ID；省略为全局' },
          year: { type: 'integer', minimum: 1970, maximum: 9999, description: '【必填】年份' },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '单页最多 20 条' },
        },
        required: ['year'],
      },
    },
    {
      name: 'builtin-qbank_get_knowledge_stats',
      description: '分页读取知识点掌握统计（Low，只读）。可限定题目集；返回 knowledge_points、total、page、page_size、has_more、truncated，单页最多 20 个知识点。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', minLength: 1, description: '可选题目集 ID；省略为全局' },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '单页最多 20 条' },
        },
      },
    },
  ],
};
