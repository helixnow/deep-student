/**
 * DSTU / VFS organization tools.
 *
 * Read-only discovery remains in learning-resource. This skill owns resource
 * organization writes, trash lifecycle operations, favorites, and uploads.
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

const DSTU_TOOL_NAMES = [
  'builtin-dstu_folder_create',
  'builtin-dstu_folder_rename',
  'builtin-dstu_rename',
  'builtin-dstu_move',
  'builtin-dstu_delete',
  'builtin-dstu_restore',
  'builtin-dstu_list_trash',
  'builtin-dstu_set_favorite',
  'builtin-dstu_purge',
  'builtin-dstu_upload_file',
] as const;

export const dstuToolsSkill: SkillDefinition = {
  id: 'dstu-tools',
  name: 'dstu-tools',
  description:
    'DSTU/VFS 学习资源组织写入能力组：创建和重命名文件夹、重命名或移动资源、软删除与回收站恢复、收藏、永久删除，以及把本地文件或 staged 对话附件上传到资源库。浏览、筛选和读取资源时配合 learning-resource 技能使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://dstu-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  relatedSkills: ['learning-resource', 'attachment-tools'],
  content: `# DSTU / VFS 资源组织技能

本技能负责学习资源库的**写入与生命周期管理**。读取与定位目标前，加载
\`learning-resource\`，用 \`builtin-folder_list\` / \`builtin-resource_list\` /
\`builtin-resource_search\` 取得真实 ID 和 path；不要猜测路径或 ID。

## 完整读写工作流

1. \`load_skills(["learning-resource", "dstu-tools"])\`。
2. 用 \`builtin-folder_list\` 了解目录，用 \`builtin-resource_list\` 或
   \`builtin-resource_search\` 找到目标；保留返回的准确 \`id\` / \`path\`。
3. 按需创建文件夹，再重命名、移动、软删除或收藏资源。
4. 写入后重新调用只读列表工具核验最终位置、名称和收藏状态。
5. 删除后用 \`builtin-dstu_list_trash\` 核验；需要撤销时调用
   \`builtin-dstu_restore\`。

## 工具与敏感度

- \`builtin-dstu_folder_create\`：Medium，创建文件夹。
- \`builtin-dstu_folder_rename\`：Medium，按 folder_id 重命名文件夹。
- \`builtin-dstu_rename\`：Medium，按 DSTU path 重命名任意资源或文件夹。
- \`builtin-dstu_move\`：Medium，把资源或文件夹移动到目标文件夹。
- \`builtin-dstu_delete\`：Medium，软删除到回收站，可恢复。
- \`builtin-dstu_restore\`：Medium，从回收站恢复。
- \`builtin-dstu_list_trash\`：Low，只读列出回收站。
- \`builtin-dstu_set_favorite\`：Low，收藏或取消收藏。
- \`builtin-dstu_purge\`：High，永久删除且不可恢复。
- \`builtin-dstu_upload_file\`：Medium，从本地路径或 staged runtime 文件上传。

## 确认规则（必须遵守）

- 一项任务将软删除**超过 5 项**资源或文件夹时，先加载 \`ask-user\`，用
  \`builtin-ask_user\` 列出数量与目标范围并取得明确确认；确认前不得开始删除。
- \`builtin-dstu_purge\` 是不可恢复的 High 操作。**每次调用前都必须**加载
  \`ask-user\` 并用 \`builtin-ask_user\` 列明将永久删除的准确目标；只有用户明确
  确认后才能调用。后端审批不能替代这一步，也不得把旧确认复用于新目标。
- 能软删除时优先 \`builtin-dstu_delete\`，不得用 purge 代替普通清理。

## 上传来源

- 普通本地文件：传 \`local_path\`。
- 对话附件：先加载 \`attachment-tools\`，调用 \`builtin-attachment_stage\`，再把其
  返回的 \`root_id\` 与 \`relative_path\` 原样传给 \`builtin-dstu_upload_file\`。
- \`folder_id\` 省略时上传到资源库默认文件夹；\`name\` / \`mime_type\` 省略时由
  源文件推断。成功返回资源 ID、DSTU path、名称、大小、MIME、目标文件夹和去重状态。
`,
  allowedTools: [...DSTU_TOOL_NAMES],
  embeddedTools: [
    {
      name: 'builtin-dstu_folder_create',
      description:
        '创建资源库文件夹（Medium）。title 必填；parent_id 省略时创建在根目录。可选 icon/color 会原样保存。成功返回 success、action、folder 与 node；node 中的 id/path 可直接用于后续操作。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255, description: '【必填】文件夹名称' },
          parent_id: { type: 'string', minLength: 1, description: '可选：父文件夹 ID；省略表示根目录' },
          icon: { type: 'string', maxLength: 100, description: '可选：文件夹图标标识' },
          color: { type: 'string', maxLength: 100, description: '可选：文件夹颜色值' },
        },
        required: ['title'],
      },
    },
    {
      name: 'builtin-dstu_folder_rename',
      description:
        '按文件夹 ID 重命名文件夹（Medium）。成功返回 success、action、folder 与 node；node 含更新后的 id/name/path，且操作不会移动文件夹。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          folder_id: { type: 'string', minLength: 1, description: '【必填】folder_list 返回的文件夹 ID' },
          title: { type: 'string', minLength: 1, maxLength: 255, description: '【必填】新文件夹名称' },
        },
        required: ['folder_id', 'title'],
      },
    },
    {
      name: 'builtin-dstu_rename',
      description:
        '按准确 DSTU path 重命名资源或文件夹（Medium）。成功返回 success、action 及重命名后的完整 node（id、type、name、path），供后续移动、读取或核验使用。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: '【必填】只读资源工具返回的准确 DSTU path' },
          new_name: { type: 'string', minLength: 1, maxLength: 255, description: '【必填】新名称' },
        },
        required: ['path', 'new_name'],
      },
    },
    {
      name: 'builtin-dstu_move',
      description:
        '移动一个资源或文件夹（Medium）。src 是目标的准确 DSTU path；dst 是目标文件夹的 DSTU path，根目录使用 "/"。成功返回 success、action 及移动后的完整 node（id、type、name、path）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          src: { type: 'string', minLength: 1, description: '【必填】待移动资源或文件夹的准确 DSTU path' },
          dst: { type: 'string', minLength: 1, description: '【必填】目标文件夹 DSTU path；根目录传 "/"' },
        },
        required: ['src', 'dst'],
      },
    },
    {
      name: 'builtin-dstu_delete',
      description:
        '把一个资源或文件夹软删除到回收站（Medium，可恢复）。成功返回 success、action 与已删除目标的 path；一项任务累计删除超过 5 项前必须先用 builtin-ask_user 确认目标范围。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: '【必填】待移入回收站的准确 DSTU path' },
        },
        required: ['path'],
      },
    },
    {
      name: 'builtin-dstu_restore',
      description:
        '从回收站恢复一个资源或文件夹（Medium）。path 必须来自 dstu_list_trash。成功返回 success、action 及恢复后的完整 node（id、type、name、path）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: '【必填】list_trash 返回的准确 DSTU path' },
        },
        required: ['path'],
      },
    },
    {
      name: 'builtin-dstu_list_trash',
      description:
        '只读列出回收站（Low）。成功返回 success、action 和按删除时间排列的 items，每项含 id、type、name、path 等恢复定位信息；同时返回 count、limit、offset、has_more 与 next_offset，供分页及 restore/purge 使用。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '返回数量，默认及最多 20' },
          offset: { type: 'integer', minimum: 0, default: 0, description: '分页偏移，默认 0' },
        },
      },
    },
    {
      name: 'builtin-dstu_set_favorite',
      description:
        '设置资源或文件夹的收藏状态（Low）。favorite=true 收藏，false 取消收藏。成功返回 success、action、path 与最终 favorite 状态。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: '【必填】资源或文件夹的准确 DSTU path' },
          favorite: { type: 'boolean', description: '【必填】最终收藏状态；true 收藏，false 取消收藏' },
        },
        required: ['path', 'favorite'],
      },
    },
    {
      name: 'builtin-dstu_purge',
      description:
        '永久删除回收站中的一个目标（High，不可恢复）。每次调用前必须加载 ask-user 并用 builtin-ask_user 列明本次准确 path、取得明确确认。成功仅返回 success、action 与 path；目标之后不能 restore。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: '【必填】list_trash 返回且已明确确认永久删除的准确 DSTU path' },
        },
        required: ['path'],
      },
    },
    {
      name: 'builtin-dstu_upload_file',
      description:
        '把本地文件或 staged runtime 文件上传到资源库（Medium）。来源严格二选一：local_path，或 attachment_stage/workspace 返回的 root_id + relative_path；两种来源同时传或都不传会被拒绝。可指定 folder_id、name、mime_type。成功返回 success、action、node、source_id、resource_id、path、name、mime_type、size、folder_id、is_new 与 resource_hash。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          local_path: { type: 'string', minLength: 1, description: '本地文件绝对路径；与 root_id + relative_path 二选一' },
          root_id: { type: 'string', minLength: 1, description: 'staged/workspace runtime root ID；必须与 relative_path 同时传入' },
          relative_path: { type: 'string', minLength: 1, description: 'root 内相对文件路径；必须与 root_id 同时传入，禁止绝对路径和 ..' },
          folder_id: { type: 'string', minLength: 1, description: '可选：资源库目标文件夹 ID；省略使用默认文件夹' },
          name: { type: 'string', minLength: 1, maxLength: 255, description: '可选：资源显示名称；省略时取源文件名' },
          mime_type: { type: 'string', minLength: 1, maxLength: 255, description: '可选：MIME 类型；省略时按扩展名推断' },
        },
        oneOf: [
          { type: 'object', required: ['local_path'] },
          { type: 'object', required: ['root_id', 'relative_path'] },
        ],
      },
    },
  ],
};
