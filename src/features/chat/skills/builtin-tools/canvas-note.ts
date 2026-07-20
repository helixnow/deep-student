/**
 * Canvas 笔记技能组
 *
 * 包含笔记读取、追加、替换、设置、创建、列表、搜索、标签与软删除工具
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const canvasNoteSkill: SkillDefinition = {
  id: 'canvas-note',
  name: 'canvas-note',
  description: '智能笔记能力组，包含笔记读取、追加、替换、创建、列表、搜索、标签更新、软删除以及笔记库 zip 导入等工具。当用户需要查看、编辑、创建、管理笔记或导入笔记库备份 zip 时使用；若用户要求“展示/演示/让我看你操作”等可见操作，必须同时加载 workbench-tools，先打开并聚焦已有笔记，再按授权执行可见编辑。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://canvas-note',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 智能笔记技能

当你需要操作笔记时，请根据操作类型选择合适的工具：

## 工具选择指南

### 读取操作
- **builtin-note_read**: 读取笔记内容，可指定章节只读取部分内容

### 写入操作
- **builtin-note_append**: 追加内容到笔记末尾或指定章节末尾
- **builtin-note_replace**: 替换笔记中的特定内容（支持正则）
- **builtin-note_set**: 设置笔记完整内容（⚠️ 会覆盖原有内容）

### 创建和管理
- **builtin-note_create**: 创建新笔记
- **builtin-note_list**: 列出笔记列表
- **builtin-note_search**: 在笔记中搜索
- **builtin-note_update_tags**: 更新标签；必须先 note_read 并传入 updatedAt OCC 基线
- **builtin-note_delete**: 软删除笔记到回收站；必须先 note_read 并传入 updatedAt，可通过 dstu-tools 恢复

### 导入笔记库 zip
- **builtin-notes_import**: 把用户提供的笔记库导出 zip 完整导入资源库（Medium）。流程：先加载 workspace-tools，用 builtin-attachment_stage 把 zip 附件物化到 temp root，再把返回的 root_id + relative_path 传给本工具，并按用户意愿选择 conflict_strategy（skip/overwrite/merge_keep_newer，默认 skip）。**禁止**用 shell unzip 手工拼装导入——那无法等价复刻冲突策略与附件还原逻辑。

## 使用建议

1. 编辑、更新标签或删除前先用 note_read 读取当前内容
2. 增量修改优先使用 note_append 或 note_replace；任何已有笔记写入前必须先 note_read，并原样传入 updatedAt 作为 expected_updated_at
3. 只有需要完全重写时才使用 note_set
4. 支持 Markdown 格式
5. 删除笔记是 Medium 软删除；批量删除超过 5 篇前先用 builtin-ask_user 确认
6. 删除后如需查看或恢复，加载 dstu-tools 调用 dstu_list_trash / dstu_restore

## 可见操作演示（必须遵守）

当用户说“展示一下”“演示”“让我看你操作”“可视化操作”等，意图是看到学习桌面中的真实窗口操作，而不是看到一串后台 CRUD 工具卡：

1. **同时加载 \`workbench-tools\`**，并按其“可见笔记演示”剧本执行。
2. 先用 \`builtin-note_list\` 找到已有笔记（若用户已指定笔记则直接使用），再用 Workbench 工具检查窗口并打开/聚焦目标笔记。
3. 用户只要求“展示能力”且未授权改内容时，默认做无损演示：打开、聚焦、读取或滚动已有笔记，然后说明如需观看 AI 光标与逐步编辑，请指定目标笔记和要改的内容。
4. 用户已明确授权具体修改时，在目标笔记窗口打开并聚焦后，优先调用 \`builtin-note_append\` 或 \`builtin-note_replace\`。它们会经 ACR 前端委托呈现窗口光环、AgentStrip、AI 光标/高亮、节奏化编辑与进度。
5. **不得为了演示而自行创建笔记、编造笔记主题、覆盖整篇内容或修改未获授权的笔记。** \`builtin-note_create\` / \`builtin-note_set\` 只能在用户明确要求创建或完整重写时使用。
6. 写入后用 \`builtin-note_read\` 或 \`builtin-workbench_query_state\` 确认结果，不要仅根据工具调用已发出就宣称成功。
`,
  allowedTools: [
    'builtin-note_read',
    'builtin-note_append',
    'builtin-note_replace',
    'builtin-note_set',
    'builtin-note_create',
    'builtin-note_list',
    'builtin-note_search',
    'builtin-note_update_tags',
    'builtin-note_delete',
    'builtin-notes_import',
  ],
  embeddedTools: [
    {
      name: 'builtin-note_read',
      description: '读取笔记内容和 updatedAt 版本基线。任何 append/replace/set/update_tags/delete 前必须先完整读取，并原样传递 updatedAt；section 读取只用于浏览，不作为写入基线。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。' },
          section: { type: 'string', description: '可选：要读取的章节标题（如 "## 代码实现"）。不指定则读取完整内容。' },
        },
      },
    },
    {
      name: 'builtin-note_append',
      description: '追加内容到笔记。必须先 note_read，并原样传入其 updatedAt 作为 expected_updated_at；冲突后重新读取，禁止盲重试。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。' },
          content: { type: 'string', description: '【必填】要追加的内容（支持 Markdown 格式）' },
          section: { type: 'string', description: '可选：要追加到的章节标题。不指定则追加到末尾。' },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】note_read 返回的 updatedAt OCC 基线' },
        },
        required: ['content', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-note_replace',
      description: '替换笔记内容。必须先 note_read，并原样传入其 updatedAt 作为 expected_updated_at；冲突后重新读取。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。' },
          search: { type: 'string', description: '【必填】要查找的文本或正则表达式' },
          replace: { type: 'string', description: '【必填】替换后的文本' },
          is_regex: { type: 'boolean', description: '是否使用正则表达式（默认 false）' },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】note_read 返回的 updatedAt OCC 基线' },
        },
        required: ['search', 'replace', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-note_set',
      description: '设置笔记完整内容。仅在用户明确要求完整重写时使用；必须先 note_read 并传入 expected_updated_at。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。' },
          content: { type: 'string', description: '【必填】笔记的新完整内容（支持 Markdown 格式）' },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】note_read 返回的 updatedAt OCC 基线' },
        },
        required: ['content', 'expected_updated_at'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-note_create',
      description: '创建新笔记。当用户要求创建新的笔记、调研报告、或需要记录新内容时使用。创建成功后返回笔记 ID。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '【必填】笔记标题' },
          content: { type: 'string', description: '笔记初始内容（支持 Markdown 格式，可选）' },
          tags: { type: 'array', items: { type: 'string' }, description: '笔记标签（可选）' },
          folder_id: { type: 'string', description: '可选：存放笔记的文件夹 ID' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-note_list',
      description: '列出笔记列表。当需要查看用户有哪些笔记、或在操作前确认笔记存在时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', description: '可选：指定文件夹 ID，只列出该文件夹下的笔记' },
          page: { type: 'integer', description: '页码，从 1 开始', default: 1, minimum: 1 },
          page_size: { type: 'integer', description: '每页返回数量，最多 20 条', default: 20, minimum: 1, maximum: 20 },
        },
      },
    },
    {
      name: 'builtin-note_search',
      description: '在笔记中搜索特定内容。当用户想找特定主题的笔记、或查找包含某些关键词的笔记时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '【必填】搜索关键词' },
          folder_id: { type: 'string', description: '可选：限制搜索范围到指定文件夹' },
          page: { type: 'integer', description: '页码，从 1 开始', default: 1, minimum: 1, maximum: 10 },
          page_size: { type: 'integer', description: '每页返回数量，最多 20 条', default: 10, minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
    },
    {
      name: 'builtin-note_update_tags',
      description: '替换笔记的完整标签列表（Medium，OCC）。必须先完整调用 note_read，并把返回的 updatedAt 原样传为 expected_updated_at；冲突后重新读取，禁止盲重试。成功返回 success、noteId、tags、previousTags、updatedAt 与 reversible。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          note_id: { type: 'string', minLength: 1, description: '【必填】要更新标签的笔记 ID' },
          tags: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 100 },
            maxItems: 50,
            description: '【必填】最终完整标签列表；传空数组表示清空标签',
          },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】最近一次完整 note_read 返回的 updatedAt OCC 基线' },
        },
        required: ['note_id', 'tags', 'expected_updated_at'],
      },
    },
    {
      name: 'builtin-note_delete',
      description: '把笔记软删除到 DSTU 回收站（Medium，OCC，可恢复），不永久清除内容。必须先完整调用 note_read 并原样传入其 updatedAt。成功返回 success、noteId、path、softDeleted、reversible 与 restoreWith；一项任务删除超过 5 篇前必须先用 builtin-ask_user 确认。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          note_id: { type: 'string', minLength: 1, description: '【必填】要移入回收站的笔记 ID' },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】最近一次完整 note_read 返回的 updatedAt OCC 基线' },
        },
        required: ['note_id', 'expected_updated_at'],
      },
    },
    {
      name: 'builtin-notes_import',
      description:
        '把笔记库导出 zip 完整导入资源库（Medium，写操作）。与设置页 UI 导入等价：完整还原学科/笔记/附件并按 conflict_strategy 处理冲突。入参是 builtin-attachment_stage 物化后的 staged zip（root_id=temp + relative_path），仅接受当前会话 temp root 内的文件。返回 subject_count/note_count/attachment_count/skipped_count/overwritten_count。不要用 shell unzip 手工拼装替代本工具。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root_id: {
            type: 'string',
            enum: ['temp'],
            default: 'temp',
            description: '固定为 temp（attachment_stage 返回的 root_id）',
          },
          relative_path: {
            type: 'string',
            minLength: 1,
            description: '【必填】attachment_stage 返回的 relative_path（如 attachments/notes_backup.zip）',
          },
          conflict_strategy: {
            type: 'string',
            enum: ['skip', 'overwrite', 'merge_keep_newer'],
            default: 'skip',
            description: '冲突策略：skip 跳过已存在笔记（默认）；overwrite 覆盖；merge_keep_newer 保留更新时间较新的一方。overwrite 会覆盖用户现有笔记，使用前应向用户确认。',
          },
        },
        required: ['relative_path'],
      },
    },
  ],
};
