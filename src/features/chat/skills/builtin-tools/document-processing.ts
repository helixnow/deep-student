/**
 * 文档解析/OCR 技能组
 *
 * 让 AI 主动对 VFS 中的 PDF/图片资源发起解析与 OCR 管线（此前仅 UI 可触发），
 * 并轮询处理进度。OCR 完成后文档全文可被检索/读取/导入题库。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const documentProcessingSkill: SkillDefinition = {
  id: 'document-processing',
  name: 'document-processing',
  description:
    '文档解析/OCR 能力组：对资源库中的 PDF、扫描件、图片主动发起解析与 OCR 管线并查询进度。当用户说"识别这个 PDF/这份扫描件读不出来/把图片里的文字提取出来"，或 resource_read 返回内容为空/提示 OCR 未完成时使用。OCR 完成后可用 resource_read 读全文、qbank_import_document 导入题库（再用 review-planning 安排复习），或用 chatanki 制卡。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://document-processing',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 文档解析/OCR 技能

对 VFS 资源库中的 PDF/图片主动发起解析与 OCR 管线，让"读不出内容"的扫描件变成可检索、可导入的文本。

## 何时使用

- \`builtin-resource_read\` 返回内容为空、或元数据显示 \`hasExtractedText=false\` / OCR 未完成
- 用户上传/导入了扫描版 PDF、试卷照片、课本拍照等图片类材料，需要提取文字
- 用户明确要求"识别/OCR/提取文字"

## 标准工作流（异步任务模式）

OCR 是后台管线（可能耗时数分钟），调用顺序：

1. 定位资源：用 \`builtin-resource_list\` / \`builtin-resource_search\` 拿到 \`file_*\` 或 \`res_*\` ID
2. \`builtin-document_parse\` 发起解析 → 立即返回 started
3. 稍后用 \`builtin-document_parse_status\` 轮询（建议间隔性查询，不要连续高频调用）
   - stage 为 completed / completed_with_issues → 完成
   - stage 为 error → 失败，可用 \`stage=full\` 重新发起
4. 完成后消费全文（见下方链路）

## 工具说明

- **builtin-document_parse**: 发起解析/OCR 管线
  - \`stage=auto\`（默认）：PDF 从 OCR 阶段开始、图片从压缩阶段开始
  - \`stage=ocr\`：强制从 OCR 阶段开始
  - \`stage=full\`：从文本提取开始重跑完整管线（修复解析失败时用）
- **builtin-document_parse_status**: 查询进度（阶段/进度/错误/已提取字符数）

## 🔗 OCR 完成后的下游链路（主动引导用户）

- **读取全文**：\`builtin-resource_read\`（learning-resource 技能组）
- **导入题库**：若文档是试卷/习题集，\`load_skills(["qbank-tools"])\` 后用
  \`builtin-qbank_import_document\` 把 OCR 文本导入题库；入库后可再
  \`load_skills(["review-planning"])\` 用 \`builtin-review_plan_generate\` 为整套题安排间隔复习
- **制作卡片**：若文档是学习资料，可用 chatanki 技能制作 Anki 卡片
- **检索问答**：OCR 后文档自动进入向量索引，\`builtin-rag_search\` 可检索

## 注意事项

- 仅支持 PDF 与图片；DOCX/PPTX/XLSX 请直接用 docx_read_structured 等 Office 工具读取
- 同一文件已有运行中的管线时会返回 already_running，不会重复触发
- OCR 消耗算力（可能调用视觉模型），不要对无关文件批量盲目发起
`,
  allowedTools: [
    'builtin-document_parse',
    'builtin-document_parse_status',
  ],
  embeddedTools: [
    {
      name: 'builtin-document_parse',
      description:
        '对 PDF/图片发起解析/OCR 管线（异步，立即返回）；resource_read 读不到内容或需识别扫描件时使用，随后用 document_parse_status 轮询。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: '文件类资源 ID（file_* 或 res_*，来自 resource_list/resource_search）',
          },
          stage: {
            type: 'string',
            enum: ['auto', 'ocr', 'full'],
            default: 'auto',
            description: 'auto=按媒体类型自动选择；ocr=强制从 OCR 开始；full=重跑完整管线（修复失败用）',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-document_parse_status',
      description:
        '查询解析/OCR 进度：当前阶段、进度详情、错误、已提取字符数；stage=completed 即可消费全文。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: '文件类资源 ID（file_* 或 res_*）',
          },
        },
        required: ['resource_id'],
      },
    },
  ],
};
