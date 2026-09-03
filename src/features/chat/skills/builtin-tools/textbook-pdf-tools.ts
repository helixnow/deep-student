import type { JsonSchemaProperty, SkillDefinition } from '../types';

// description 可省略：字段名自明（如 textbook_id）时不再注入 description 键，
// 只减少注入 LLM 的 schema 字符，不改变 JSON Schema 校验结构。
const id = (description?: string): JsonSchemaProperty => ({
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9_-]+$',
  ...(description === undefined ? {} : { description }),
});

const expectedRevision: JsonSchemaProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: '最近一次 get 返回的 updated_at（OCC 基线）',
};

const pagination = {
  page: { type: 'integer' as const, minimum: 1, default: 1 },
  page_size: {
    type: 'integer' as const,
    minimum: 1,
    maximum: 20,
    default: 20,
  },
};

const rectSchema: JsonSchemaProperty = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    width: { type: 'number', minimum: 0, maximum: 1 },
    height: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const highlightProperties = {
  page_index: {
    type: 'integer' as const,
    minimum: 0,
    maximum: 100000,
    description: 'PDF 页索引（0-based）',
  },
  text: {
    type: 'string' as const,
    minLength: 1,
    maxLength: 20000,
    description: '高亮对应的真实选中文本',
  },
  color: {
    type: 'string' as const,
    enum: ['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca'],
    description: '高亮色：黄/绿/蓝/红',
  },
  rects: {
    type: 'array' as const,
    minItems: 1,
    maxItems: 64,
    items: rectSchema,
    description: 'coordVersion=2 归一化矩形，须完整落在 0..1 内',
  },
};

export const textbookPdfToolsSkill: SkillDefinition = {
  id: 'textbook-pdf-tools',
  name: 'textbook-pdf-tools',
  description:
    '教材 PDF 批注与页图工具。分页读取、添加、删除或更新真实书签和划线高亮，并读取经过尺寸与体积限制的真实 PDF 页图。适合“第 12 页加书签/划黄”“看看这一页图像”等场景。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://textbook-pdf-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 教材 PDF 批注与页图

三个工具均操作真实 VFS/DSTU 数据，不存在模拟结果。

- \`builtin-textbook_bookmarks\`：get 为 Low；add/remove/update 为 Medium。书签页码是 1-based。
- \`builtin-textbook_highlights\`：get 为 Low；add/remove/update 为 Medium。高亮沿用 EnhancedPdfViewer 格式，page_index 是 0-based，新增/更新坐标固定为 coordVersion=2。
- \`builtin-pdf_page_image\`：Low，只读真实 PDF 预渲染页图；优先使用流水线已有压缩 blob，必要时再缩到最长边 2048 并压缩，返回受限 data URL。

## OCC 工作流

1. 写批注前必须先对同一教材调用对应工具的 get，取得 \`updated_at\`。
2. 把它原样作为 \`expected_updated_at\` 传给 add/remove/update。
3. 冲突会返回结构化 \`ANNOTATION_CONFLICT\`、当前 revision 和 bounded 当前值。重新读取、比较用户意图，不得用旧 revision 盲重试。
4. 成功写入会发出 \`pdf-annotations:changed\`，所有已打开的阅读器从 DSTU metadata 刷新。

get 单页最多 20 条并返回 total/page/page_size/has_more。任何输出文本字段超过 2000 Unicode 字符会截断并提供对应 \`*_truncated\` 标记；这不改变落库原文。

## 格式和边界

- 书签格式与阅读器一致：id/page/title/createdAt；同一页只允许一个书签。
- 高亮格式与阅读器一致：id/pageIndex/text/color/rects/createdAt/coordVersion。颜色只允许四个阅读器色值，rects 最多 64 个且必须完整位于归一化页面 0..1 内。
- 每本教材书签和高亮各最多 500 条。页码会与已知 page_count 交叉校验。
- 删除只是批注级写入，敏感度为 Medium，不是教材删除；仍需 OCC。
- 页图参数使用 VFS resource_id，不是 textbook_id；page_index 为 0-based。输出不截断 base64，超过安全上限时明确失败，绝不返回残缺图片。

错误统一为 code/message/message_key/hint/retryable。常见 code 包括 INVALID_ARGUMENT、TEXTBOOK_NOT_FOUND、ANNOTATION_NOT_FOUND、ANNOTATION_CONFLICT、ANNOTATION_LIMIT_EXCEEDED、PDF_PAGE_IMAGE_NOT_AVAILABLE、PDF_PAGE_IMAGE_TOO_LARGE。
`,
  allowedTools: [
    'builtin-textbook_bookmarks',
    'builtin-textbook_highlights',
    'builtin-pdf_page_image',
  ],
  embeddedTools: [
    {
      name: 'builtin-textbook_bookmarks',
      description:
        '分页读取或以 OCC 增删改教材书签。get 为 Low 且返回 updated_at，写为 Medium；超长标题带 title_truncated。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['get', 'add', 'remove', 'update'] },
          textbook_id: id(),
        },
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'textbook_id'],
            properties: {
              action: { type: 'string', enum: ['get'] },
              textbook_id: id(),
              ...pagination,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'textbook_id', 'page_number', 'title', 'expected_updated_at'],
            properties: {
              action: { type: 'string', enum: ['add'] },
              textbook_id: id(),
              page_number: { type: 'integer', minimum: 1, maximum: 100000, description: '1-based 页码' },
              title: { type: 'string', minLength: 1, maxLength: 500 },
              expected_updated_at: expectedRevision,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'textbook_id', 'bookmark_id', 'expected_updated_at'],
            properties: {
              action: { type: 'string', enum: ['remove'] },
              textbook_id: id(),
              bookmark_id: id(),
              expected_updated_at: expectedRevision,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'textbook_id', 'bookmark_id', 'expected_updated_at'],
            properties: {
              action: { type: 'string', enum: ['update'] },
              textbook_id: id(),
              bookmark_id: id(),
              page_number: { type: 'integer', minimum: 1, maximum: 100000 },
              title: { type: 'string', minLength: 1, maxLength: 500 },
              expected_updated_at: expectedRevision,
            },
          },
        ],
      },
    },
    {
      name: 'builtin-textbook_highlights',
      description:
        '分页读取或以 OCC 增删改 PDF 高亮。get 为 Low 且返回 updated_at，写为 Medium；page_index 0-based，超长 text 带 text_truncated。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['get', 'add', 'remove', 'update'] },
          textbook_id: id(),
        },
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'textbook_id'],
            properties: {
              action: { type: 'string', enum: ['get'] },
              textbook_id: id(),
              page_index: highlightProperties.page_index,
              ...pagination,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'textbook_id', 'page_index', 'text', 'color', 'rects', 'expected_updated_at'],
            properties: {
              action: { type: 'string', enum: ['add'] },
              textbook_id: id(),
              ...highlightProperties,
              expected_updated_at: expectedRevision,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'textbook_id', 'highlight_id', 'expected_updated_at'],
            properties: {
              action: { type: 'string', enum: ['remove'] },
              textbook_id: id(),
              highlight_id: id(),
              expected_updated_at: expectedRevision,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'textbook_id', 'highlight_id', 'expected_updated_at'],
            properties: {
              action: { type: 'string', enum: ['update'] },
              textbook_id: id(),
              highlight_id: id(),
              ...highlightProperties,
              expected_updated_at: expectedRevision,
            },
          },
        ],
      },
    },
    {
      name: 'builtin-pdf_page_image',
      description:
        '读取 VFS PDF 预渲染页图（Low，page_index 0-based）。优先用已有压缩 blob，必要时缩到最长边 2048 并压缩；返回 image_url 等元信息，绝不返回截断 base64。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['resource_id', 'page_index'],
        properties: {
          resource_id: {
            ...id('VFS resource ID；不是 textbook_id'),
            pattern: '^res_[A-Za-z0-9_-]+$',
          },
          page_index: {
            type: 'integer',
            minimum: 0,
            maximum: 100000,
            description: 'PDF 页索引，0-based',
          },
        },
      },
    },
  ],
};
