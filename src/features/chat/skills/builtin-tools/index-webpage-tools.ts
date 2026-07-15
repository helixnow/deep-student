import type { JsonSchemaProperty, SkillDefinition } from '../types';

const resourceId: JsonSchemaProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^res_[A-Za-z0-9_-]+$',
  description: 'VFS resource ID（res_ 前缀），不是 file_/tb_ 等业务 ID',
};

const folderId: JsonSchemaProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9_-]+$',
  description: '可选目标 VFS 文件夹 ID；省略时保存到资料库根目录',
};

const pagination = {
  page: {
    type: 'integer' as const,
    minimum: 1,
    default: 1,
    description: 'Unit 页码，从 1 开始',
  },
  page_size: {
    type: 'integer' as const,
    minimum: 1,
    maximum: 20,
    default: 20,
    description: '每页 Unit 数量，最多 20 条',
  },
};

export const indexWebpageToolsSkill: SkillDefinition = {
  id: 'index-webpage-tools',
  name: 'index-webpage-tools',
  description:
    '检查真实 VFS RAG 索引与 OCR 状态、重建指定资源的完整索引，或把 web_fetch 的完整网页内容保存为可检索的知识库 Markdown。适合“为什么搜不到刚导入的 PDF”“把这篇博客存进知识库”等场景。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://index-webpage-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# RAG 索引诊断与网页存档

三个工具只操作真实 VFS SSOT，不返回模拟状态。

- \`builtin-index_status\`（Low）读取全局或指定资源的索引摘要。指定 resource_id 时，还返回资源级 indexState、分页 Unit 状态，以及最多 2000 字符的 OCR/extractedText 预览和截断标记。
- \`builtin-index_rebuild\`（High）删除指定资源的旧文本/多模态向量及 SQLite 索引元数据，然后走 VfsFullIndexingService 完整重建。它会发出 \`vfs-index-progress\`；只有 status=indexed 的成功结果才代表完成。
- \`builtin-webpage_save\`（Medium）把已抓取的完整正文写成 Markdown blob，保存 source URL/title metadata，创建 VFS file/resource，生成 Unit 并加入索引队列，同时发出 DSTU 创建事件。

## “为什么搜不到刚导入的 PDF”

1. 先用 index_status(resource_id) 查看 indexState、text/mm Unit、OCR/extractedText 和错误字段。
2. 没有可索引文本时，先完成 document_parse/OCR；index_rebuild 不会捏造缺失正文。
3. 用户明确要求修复并确认 High 操作后，再调用 index_rebuild。不要仅凭进度事件宣称完成，必须检查工具终态。

## “把这篇博客存进知识库”

1. 用 web_fetch 分页读取网页，持续使用 nextStartIndex，直到 hasMore=false。
2. 拼接所有真实 content，移除每页末尾的 \`<truncated>...\` 提示；禁止只保存第一页或截断提示。
3. 调用 webpage_save，传原始 url、完整 content 和可选 title/content_type/folder_id。
4. indexQueued=true 只表示 Unit 已入队；需要确认向量完成时再用 index_status 检查。

网页正文最多 1,000,000 Unicode 字符且最多 4 MiB；URL 仅允许无内嵌凭据的绝对 HTTP/HTTPS 地址。相同 URL、标题和正文生成相同 Markdown 哈希，重复保存会返回 deduplicated=true，并复核索引 Unit，不新增副本。

错误统一包含 code/message/messageKey/messageFallback/hint/retryable。常见 code：INVALID_ARGUMENT、INCOMPLETE_WEB_FETCH、RESOURCE_NOT_FOUND、FOLDER_NOT_FOUND、DEPENDENCY_UNAVAILABLE、CANCELLED、INDEX_STATUS_FAILED、INDEX_REBUILD_FAILED、WEBPAGE_SAVE_FAILED。
`,
  allowedTools: [
    'builtin-index_status',
    'builtin-index_rebuild',
    'builtin-webpage_save',
  ],
  embeddedTools: [
    {
      name: 'builtin-index_status',
      description:
        '读取真实 VFS 索引状态（Low）。无 resource_id 时返回全局 Unit/维度摘要；指定资源时额外返回资源级状态、分页 Unit、最多 2000 字符的 OCR/提取文本预览和明确截断标记。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          resource_id: resourceId,
          ...pagination,
        },
      },
    },
    {
      name: 'builtin-index_rebuild',
      description:
        '通过 VfsFullIndexingService 重建一个资源的完整索引（High）。先删除旧文本/多模态向量和 SQLite 索引元数据，再重新抽取、分块、嵌入；发出 vfs-index-progress，终态 status=indexed 才算完成。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['resource_id'],
        properties: {
          resource_id: resourceId,
          folder_id: folderId,
        },
      },
    },
    {
      name: 'builtin-webpage_save',
      description:
        '把 web_fetch 已完整抓取并拼接的 Markdown 正文保存到真实 VFS（Medium）：blob + source metadata + file/resource + Unit 索引 + DSTU 事件。不得传仍有 hasMore=true 的部分内容。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'content'],
        properties: {
          url: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            pattern: '^https?://',
            description: 'web_fetch 返回的原始绝对 HTTP/HTTPS URL；不得包含用户名或密码',
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 300,
            description: '可选网页标题；省略时从 URL 路径或 host 推导',
          },
          content: {
            type: 'string',
            minLength: 1,
            maxLength: 1000000,
            description: '完整拼接的网页 Markdown 正文；web_fetch 必须已读到 hasMore=false',
          },
          content_type: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: '可选 web_fetch contentType，仅作为来源 metadata 保存',
          },
          folder_id: folderId,
        },
      },
    },
  ],
};
