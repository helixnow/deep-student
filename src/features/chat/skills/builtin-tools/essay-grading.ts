/**
 * 作文批改技能组
 *
 * 调用后端作文批改流水线（essay_grading），支持发起批改、等待结果、查询历史。
 * 是"批改 → 错题入库 → 安排复习"学习闭环的入口环节。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const essayGradingSkill: SkillDefinition = {
  id: 'essay-grading',
  name: 'essay-grading',
  description:
    '作文批改能力组：提交作文全文调用专业批改流水线（支持高考/中考/雅思/托福/考研/四六级等内置与自定义批阅模式），可选指定已启用模型，返回总分、维度分与逐段批注；支持同一会话多轮修改对比与历史批改查询。当用户要求"批改作文/帮我看看这篇作文/作文打分"时使用。批改结果中的错误点可衔接 qbank-tools 入错题本，再用 review-planning 安排间隔复习，形成完整学习闭环。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://essay-grading',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 作文批改技能

调用后端专业作文批改流水线，对用户提交的作文给出总分、维度评分、逐段批注与改进建议。

## 标准工作流（必须遵守）

批改是**异步任务**（LLM 流式批改可能耗时 1-3 分钟），调用顺序：

1. \`builtin-essay_grade\` 发起批改 → 立即返回 \`task_id\` / \`session_id\` / \`round_number\`
2. **下一轮**调用 \`builtin-essay_grade_wait\`（传 task_id）等待完成
   - 返回 \`status=timeout\` 时**不是失败**，再次调用 wait 继续等待即可
   - 返回 \`status=completed\` 时附带完整批改结果
3. 向用户呈现批改结果（总分、维度分、主要问题、改进建议）

## 工具选择指南

### 发起与等待
- **builtin-essay_grade**: 提交作文文本发起批改（可选批阅模式/文体/学段/题目要求）
- **builtin-essay_grade_wait**: 等待批改任务完成并取回结果
- **builtin-essay_grade_status**: 非阻塞查询任务状态

### 模式与历史
- **builtin-essay_list_modes**: 列出内置模式、用户自定义模式和内置模式覆盖（gaokao/zhongkao/ielts/toefl/kaoyan/cet/practice 等），不确定用哪个模式时先调用
- **builtin-essay_list_sessions**: 列出历史批改会话
- **builtin-essay_list_results**: 列出某会话的所有批改轮次摘要
- **builtin-essay_get_result**: 获取某轮完整批改结果（原文 + 批改 + 评分）

## 多轮修改批改

用户修改作文后再次批改时，**传入上次返回的 session_id**：流水线会自动带上上一轮
批改结果与原文做对比，指出进步与仍存在的问题。

## 自定义模式与模型

- \`essay_list_modes\` 会从当前应用数据目录实时读取 CustomModeManager 保存的模式；自定义模式 ID 可直接传给 \`essay_grade.mode_id\`，内置模式覆盖也会优先使用用户保存的评分维度和提示词。
- \`essay_grade.model_config_id\` 可选，必须传 \`essay_grading_get_models\`/模型设置中真实存在且已启用的非嵌入模型配置 ID；省略时使用系统默认作文模型。不要猜测模型 ID。

## 图片作文的标准 OCR 链路

图片或扫描作文不能直接声称已经识别。按以下真实工具链执行，逐步传递上一步返回的 ID：

1. 加载 \`attachment-tools\`、\`dstu-tools\`、\`document-processing\`、\`learning-resource\`。
2. 用 \`builtin-attachment_stage\`（\`message_id\` + \`attachment_id\`）把附件物化到会话临时目录。
3. 将返回的 \`root_id\` + \`relative_path\` 原样交给 \`builtin-dstu_upload_file\`，取得真实资源 ID。
4. 对该资源调用 \`builtin-document_parse\`，再用 \`builtin-document_parse_status\` 轮询，直到明确 \`stage=completed\` 或报告错误。
5. 用 \`builtin-resource_read\` 读取解析后的全文；将返回的文本作为 \`builtin-essay_grade.text\` 输入。解析失败时停止并向用户报告，不得编造 OCR 文本。

此链路只使用实际存在的 \`attachment_stage → dstu_upload_file → document_parse/status → resource_read → essay_grade\` 工具，不使用不存在的 OCR 工具名。

## FSRS / ChatAnki 路由边界

- 作文错误点整理成卡片并经用户明确同意后，加载 \`chatanki\`，复用 \`builtin-chatanki_enqueue_review\` 入队；查询库级到期量或近期复习统计时使用只读的 \`builtin-chatanki_review_stats\`。
- Agent 不暴露也不调用 \`fsrs_rate\`，不得替用户选择 Again/Hard/Good/Easy；评分仍由用户在复习界面完成。作文专属的 SM-2 \`review-planning\` 与 ChatAnki 的 FSRS 队列不是同一套数据，不能混用。

## 🔗 杀手级链路：批改 → 错题入库 → 安排复习（强烈建议主动引导）

批改完成后，**主动建议**用户把批改指出的薄弱点沉淀为可复习的资产：

1. **提取错误点**：从批改结果中归纳语法错误、用词不当、结构问题等具体错误
2. **入错题本**：\`load_skills(["qbank-tools"])\` 后用 \`builtin-qbank_batch_import\` 把错误点
   转成题目（如"改错题：<原句>"，answer 填正确写法，explanation 填批改依据），
   记下返回的 \`session_id\` 与 \`new_card_ids\`
3. **安排复习**：\`load_skills(["review-planning"])\` 后用 \`builtin-review_schedule\`
   （exam_id=上一步的 session_id，card_ids=new_card_ids）安排间隔复习，
   SM-2 算法会自动排期（首次复习为次日）

这样一次批改就变成了"可追踪、可复习"的长期学习计划。

## 注意事项

- 作文正文上限 50000 字符；空文本会被拒绝
- 批阅模式支持 \`essay_list_modes\` 返回的内置、自定义和覆盖模式；不要猜测未列出的 ID
- 不要在发起 essay_grade 的同一轮并发调用 essay_grade_wait
- 批改结果已由系统持久化，随时可用 essay_get_result 重新取回
`,
  allowedTools: [
    'builtin-essay_grade',
    'builtin-essay_grade_wait',
    'builtin-essay_grade_status',
    'builtin-essay_list_modes',
    'builtin-essay_list_sessions',
    'builtin-essay_list_results',
    'builtin-essay_get_result',
  ],
  embeddedTools: [
    {
      name: 'builtin-essay_grade',
      description:
        '提交作文发起异步批改，立即返回 task_id，下一轮用 essay_grade_wait 等待。传 session_id 可多轮对比批改。完成后建议按技能说明走「错题入库 → 安排复习」链路。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '作文全文（纯文本，上限 50000 字符）' },
          topic: { type: 'string', description: '作文题目/题干，提供后核对是否切题' },
          mode_id: {
            type: 'string',
            description: '批阅模式 ID，必须来自 essay_list_modes（含自定义模式）；不传用默认通用模式',
          },
          model_config_id: {
            type: 'string',
            description:
              '模型配置 ID，须为设置或 essay_grading_get_models 中已启用的非嵌入模型；不传用系统默认',
          },
          essay_type: { type: 'string', description: '文体，如 议论文/记叙文/说明文' },
          grade_level: { type: 'string', description: '学段，如 middle_school/high_school/college' },
          custom_prompt: { type: 'string', description: '自定义批改要求，追加到批阅模式提示词后' },
          session_id: {
            type: 'string',
            description: '批改会话 ID；传入则作为该会话新一轮并自动与上一轮对比，不传新建会话',
          },
          title: { type: 'string', description: '新建会话标题（仅不传 session_id 时生效）' },
        },
        required: ['text'],
      },
    },
    {
      name: 'builtin-essay_grade_wait',
      description:
        '等待批改完成（内部轮询）。completed 附带完整结果；timeout 表示仍在进行，应再次调用继续等待，勿判为失败。',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '批改任务 ID（优先，来自 essay_grade）' },
          session_id: { type: 'string', description: '批改会话 ID（兜底定位）' },
          round_number: { type: 'integer', description: '轮次号（配合 session_id，不传取最新）' },
          timeout_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: 100000,
            default: 90000,
            description: '本次等待超时毫秒数',
          },
        },
      },
    },
    {
      name: 'builtin-essay_grade_status',
      description: '非阻塞查询批改任务状态（running/completed/error/cancelled/not_found）。',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '批改任务 ID（优先）' },
          session_id: { type: 'string', description: '批改会话 ID（兜底）' },
          round_number: { type: 'integer', description: '轮次号（配合 session_id，不传取最新）' },
        },
      },
    },
    {
      name: 'builtin-essay_list_modes',
      description: '列出可用批阅模式（内置/自定义/覆盖；含 ID、名称、is_builtin、评分维度、满分）。选批改标准前先调用，勿猜测 mode_id。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'builtin-essay_list_sessions',
      description: '列出历史批改会话（标题、轮次数、最新得分），用于回顾历史或续批。',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1, minimum: 1, description: '页码，从 1 开始' },
          page_size: { type: 'integer', default: 20, minimum: 1, maximum: 20, description: '每页条数' },
        },
      },
    },
    {
      name: 'builtin-essay_list_results',
      description: '列出某会话全部轮次摘要（轮次号、得分、结果预览）。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '批改会话 ID' },
          page: { type: 'integer', default: 1, minimum: 1, description: '页码，从 1 开始' },
          page_size: { type: 'integer', default: 20, minimum: 1, maximum: 20, description: '每页条数' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-essay_get_result',
      description: '获取某轮完整批改结果（原文 + 批改文本 + 总分 + 维度评分），提取错误点前调用。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '批改会话 ID' },
          round_number: { type: 'integer', description: '轮次号，不传取最新' },
        },
        required: ['session_id'],
      },
    },
  ],
};
