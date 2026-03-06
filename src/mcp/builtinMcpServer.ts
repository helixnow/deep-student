/**
 * 内置 MCP 服务器定义
 *
 * ⚠️ **已废弃**：此模块中的 BUILTIN_TOOLS 数组已被 Skills 渐进披露系统完全替代。
 *
 * 新的工具定义位于：`src/chat-v2/skills/builtin-tools/`
 * - knowledge-retrieval.ts: 检索工具
 * - canvas-note.ts: Canvas 笔记工具
 * - vfs-memory.ts: VFS 记忆工具
 * - learning-resource.ts: 学习资源工具
 * - todo-tools.ts: TodoList 任务工具
 * - (anki-tools.ts: 已移除，由 ChatAnki skill 接管)
 * - qbank-tools.ts: 智能题目集工具
 * - workspace-tools.ts: 工作区协作工具
 * - web-fetch.ts: Web Fetch 工具
 *
 * 此文件仍保留以下内容供其他模块使用：
 * - BUILTIN_SERVER_ID, BUILTIN_NAMESPACE: 常量
 * - isBuiltinServer, isBuiltinTool, stripBuiltinNamespace: 辅助函数
 * - getToolDisplayNameKey: 工具 i18n 显示名称
 * - ALL_SEARCH_ENGINE_IDS: 搜索引擎类型
 *
 * @deprecated BUILTIN_TOOLS 数组和 getBuiltinToolSchemas 函数已废弃
 * @see docs/design/Skills渐进披露架构设计.md
 */

import { builtinToolSkills } from '../chat-v2/skills/builtin-tools';

// 内置服务器常量
export const BUILTIN_SERVER_ID = '__builtin__tools';
// 🔧 使用 'builtin-' 而非 'builtin:' 以兼容 DeepSeek/OpenAI API 的工具名称限制
// API 要求工具名称符合正则 ^[a-zA-Z0-9_-]+$，不允许冒号
export const BUILTIN_NAMESPACE = 'builtin-';
export const BUILTIN_SERVER_NAME = '内置工具';
export const BUILTIN_SERVER_NAME_EN = 'Built-in Tools';

/**
 * 内置工具 Schema 定义
 */
export interface BuiltinToolSchema {
  name: string;
  /** i18n 翻译键，用于获取可读的工具名称 */
  displayNameKey: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 内置工具列表
 */
export const BUILTIN_TOOLS: BuiltinToolSchema[] = [
  {
    name: `${BUILTIN_NAMESPACE}rag_search`,
    displayNameKey: 'mcp.tools.rag_search',
    description:
      '在知识库中搜索文档。当用户询问已上传的文档、文件或特定主题时使用。返回相关文档片段和来源信息。' +
      '支持多种过滤方式：按文件夹、按资源类型、按特定文档ID。' +
      '如果检索结果被单一文档占满，可以使用 max_per_resource 参数限制每个文档的结果数。' +
      '检索结果可能包含图片URL，你可以在回答中使用 ![描述](图片URL) 格式直接展示相关图片。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询文本，应该包含用户问题的核心关键词',
        },
        folder_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：指定要搜索的文件夹ID列表。如果为空，则搜索所有可用文件夹。',
        },
        resource_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：指定要搜索的资源ID列表，精确到特定文档。用于针对特定文档进行深入检索。',
        },
        resource_types: {
          type: 'array',
          items: { 
            type: 'string',
            enum: ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap'],
          },
          description: '可选：限制搜索的资源类型。支持 note/textbook/file/image/exam/essay/translation/mindmap',
        },
        top_k: {
          type: 'integer',
          default: 10,
          minimum: 1,
          maximum: 100,
          description: '返回的结果数量，默认10条，最大100条。如果初次检索结果不够，可以增大此值。',
        },
        max_per_resource: {
          type: 'integer',
          default: 0,
          minimum: 0,
          maximum: 20,
          description: '每个文档最多返回的结果块数量，0表示不限制。当多个相似文档时，设置此参数可以获得更多样化的结果。',
        },
        enable_reranking: {
          type: 'boolean',
          default: true,
          description: '是否启用重排序以提高结果质量',
        },
      },
      required: ['query'],
    },
  },
  // ★ 多模态搜索工具 - 当前多模态索引已禁用，暂时隐藏此工具
  // 恢复时取消注释即可重新启用
  // {
  //   name: `${BUILTIN_NAMESPACE}multimodal_search`,
  //   displayNameKey: 'mcp.tools.multimodal_search',
  //   description:
  //     '在多模态知识库中搜索图片和扫描PDF内容。当用户询问图片中的内容、扫描文档、手写笔记、整卷识别结果等视觉内容时使用。' +
  //     '使用 VL Embedding 模型进行多模态向量检索。' +
  //     '返回结果包含图片URL，你可以在回答中使用 ![描述](图片URL) 格式直接展示找到的图片。',
  //   inputSchema: {
  //     type: 'object',
  //     properties: {
  //       query: {
  //         type: 'string',
  //         description: '搜索查询文本，描述要查找的图片或视觉内容',
  //       },
  //       folder_ids: {
  //         type: 'array',
  //         items: { type: 'string' },
  //         description: '可选：指定要搜索的文件夹ID列表。如果为空，则搜索所有可用文件夹。',
  //       },
  //       resource_ids: {
  //         type: 'array',
  //         items: { type: 'string' },
  //         description: '可选：指定要搜索的资源ID列表，精确到特定文档。',
  //       },
  //       resource_types: {
  //         type: 'array',
  //         items: {
  //           type: 'string',
  //           enum: ['exam', 'textbook', 'image', 'note'],
  //         },
  //         description: '可选：限制搜索的资源类型。exam=整卷识别, textbook=教材, image=图片, note=笔记',
  //       },
  //       top_k: {
  //         type: 'integer',
  //         default: 10,
  //         minimum: 1,
  //         maximum: 100,
  //         description: '返回的结果数量，默认10条，最大100条',
  //       },
  //       max_per_resource: {
  //         type: 'integer',
  //         default: 0,
  //         minimum: 0,
  //         maximum: 20,
  //         description: '每个文档最多返回的结果数量，0表示不限制',
  //       },
  //     },
  //     required: ['query'],
  //   },
  // },
  {
    name: `${BUILTIN_NAMESPACE}unified_search`,
    displayNameKey: 'mcp.tools.unified_search',
    description:
      '统一搜索：同时搜索知识库文本和用户记忆，合并返回最相关结果。' +
      '这是默认本地搜索工具，一次调用即可覆盖文本+记忆。' +
      '引用方式请使用 [知识库-N] / [图片-N] / [记忆-N]，需要页面图片时用 [知识库-N:图片] 或 [图片-N:图片]。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询文本',
        },
        folder_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：指定要搜索的文件夹ID列表。如果为空，则搜索所有可用文件夹。',
        },
        resource_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：指定要搜索的资源ID列表，精确到特定文档。',
        },
        resource_types: {
          type: 'array',
          items: { 
            type: 'string',
            enum: ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap'],
          },
          description: '可选：限制搜索的资源类型',
        },
        top_k: {
          type: 'integer',
          default: 10,
          minimum: 1,
          maximum: 30,
          description: '每种搜索源返回的最大结果数，默认10，最大30',
        },
        max_per_resource: {
          type: 'integer',
          default: 0,
          minimum: 0,
          description: '每个资源最多返回的片段数，0表示不限制',
        },
        enable_reranking: {
          type: 'boolean',
          default: true,
          description: '是否启用重排序优化结果质量，默认启用',
        },
      },
      required: ['query'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}memory_read`,
    displayNameKey: 'mcp.tools.memory_read',
    description:
      '读取指定记忆文件的完整内容。通过 note_id（从 unified_search 的记忆结果或 memory_list 获取）读取记忆笔记。',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: '记忆笔记 ID（从 unified_search 的记忆结果或 memory_list 中获取）',
        },
      },
      required: ['note_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}memory_write`,
    displayNameKey: 'mcp.tools.memory_write',
    description:
      '创建或更新用户记忆文件。用于保存用户偏好、学习到的知识或重要经历。记忆以 Markdown 笔记形式存储在 VFS 记忆文件夹中。',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: '可选：指定 note_id 则按 ID 更新/追加该记忆',
        },
        folder: {
          type: 'string',
          description: '记忆分类文件夹路径，如 "偏好"、"知识"、"经历"、"知识/数学"。留空表示存储在记忆根目录。',
        },
        title: {
          type: 'string',
          description: '记忆标题',
        },
        content: {
          type: 'string',
          description: '记忆内容（Markdown 格式）',
        },
        mode: {
          type: 'string',
          enum: ['create', 'update', 'append'],
          default: 'create',
          description: '写入模式：create=新建, update=替换同名记忆, append=追加到同名记忆末尾（传 note_id 时改为按 ID 更新）',
        },
      },
      anyOf: [
        { required: ['title', 'content'] },
        { required: ['note_id', 'title'] },
        { required: ['note_id', 'content'] },
      ],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}memory_update_by_id`,
    displayNameKey: 'mcp.tools.memory_update_by_id',
    description: '按 note_id 更新记忆内容或标题（避免同名记忆误更新）。',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: '记忆笔记 ID（从 unified_search 的记忆结果或 memory_list 获取）',
        },
        title: {
          type: 'string',
          description: '可选：新的记忆标题',
        },
        content: {
          type: 'string',
          description: '可选：新的记忆内容（Markdown 格式）',
        },
      },
      required: ['note_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}memory_delete`,
    displayNameKey: 'mcp.tools.memory_delete',
    description: '删除指定记忆（软删除）。',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: '记忆笔记 ID（从 unified_search 的记忆结果或 memory_list 获取）',
        },
      },
      required: ['note_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}memory_write_smart`,
    displayNameKey: 'mcp.tools.memory_write_smart',
    description: '智能写入记忆。fact 用于用户事实；study 用于用户明确要求保存的学习内容；note 用于方法论/经验。',
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: '记忆分类文件夹路径，如 "偏好"、"经历"、"知识/数学"。留空表示存储在记忆根目录。',
        },
        title: {
          type: 'string',
          description: '记忆标题',
        },
        content: {
          type: 'string',
          description: '记忆内容（Markdown 格式）',
        },
        memory_type: {
          type: 'string',
          enum: ['fact', 'study', 'note'],
          description: '记忆类型。fact=用户事实；study=用户显式保存的词汇/知识点/错题要点；note=用户显式保存的方法/经验。',
        },
        memory_purpose: {
          type: 'string',
          enum: ['internalized', 'memorized', 'supplementary', 'systemic'],
          description: '记忆目的。',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}memory_write_batch`,
    displayNameKey: 'mcp.tools.memory_write_smart',
    description: '批量写入记忆，适合一次性保存多条词汇/知识点/要点。默认 memory_type=study。',
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: '默认文件夹路径。',
        },
        memory_type: {
          type: 'string',
          enum: ['fact', 'study', 'note'],
          default: 'study',
          description: '默认记忆类型。',
        },
        memory_purpose: {
          type: 'string',
          enum: ['internalized', 'memorized', 'supplementary', 'systemic'],
          description: '默认记忆目的。',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              content: { type: 'string' },
              folder: { type: 'string' },
              memory_type: { type: 'string', enum: ['fact', 'study', 'note'] },
              memory_purpose: { type: 'string', enum: ['internalized', 'memorized', 'supplementary', 'systemic'] },
            },
            required: ['title', 'content'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}memory_list`,
    displayNameKey: 'mcp.tools.memory_list',
    description:
      '列出记忆目录结构，查看有哪些记忆分类和文件。可指定文件夹路径查看子目录内容。',
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: '相对于记忆根目录的文件夹路径，留空表示根目录',
        },
        limit: {
          type: 'integer',
          default: 100,
          minimum: 1,
          maximum: 500,
          description: '返回数量限制，默认100条',
        },
      },
    },
  },
  // web_search 工具单独处理，使用 getWebSearchToolSchema() 动态生成

  // ============================================================================
  // 学习资源工具
  // ============================================================================

  {
    name: `${BUILTIN_NAMESPACE}resource_list`,
    displayNameKey: 'mcp.tools.resource_list',
    description:
      '列出用户的学习资源。可按类型（笔记、教材、文件、图片、整卷、作文、翻译、思维导图）和文件夹筛选。' +
      '当需要了解用户有哪些学习材料、浏览用户的笔记或教材列表时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap', 'all'],
          default: 'all',
          description: '资源类型。支持 note/textbook/file/image/exam/essay/translation/mindmap/all',
        },
        folder_id: {
          type: 'string',
          description: '可选：文件夹 ID。指定后只列出该文件夹下的资源。不指定则列出根目录。',
        },
        search: {
          type: 'string',
          description: '可选：搜索关键词。按标题/名称过滤资源。',
        },
        limit: {
          type: 'integer',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: '返回数量限制，默认20条，最多100条',
        },
        favorites_only: {
          type: 'boolean',
          default: false,
          description: '可选：是否只返回收藏的资源',
        },
      },
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}resource_read`,
    displayNameKey: 'mcp.tools.resource_read',
    description:
      '读取指定学习资源的内容。支持笔记（Markdown）、教材页面、整卷题目、作文批改、翻译结果、知识导图。' +
      '对于 PDF/教材类多页文档，支持通过 page_start/page_end 按页读取，避免一次加载全部内容。' +
      '首次读取时不指定页码可获取全文和总页数（totalPages），后续可按需读取特定页。',
    inputSchema: {
      type: 'object',
      properties: {
        resource_id: {
          type: 'string',
          description: '资源 ID（如 note_xxx, tb_xxx, file_xxx, exam_xxx, essay_xxx, tr_xxx, mm_xxx, res_xxx）。可通过 resource_list/resource_search，或 unified_search 返回的 readResourceId（优先）/sourceId/resourceId 获取。',
        },
        include_metadata: {
          type: 'boolean',
          default: true,
          description: '是否包含元数据（标题、创建时间、文件夹路径等）',
        },
        page_start: {
          type: 'integer',
          minimum: 1,
          description: '可选：起始页码（1-based），仅对 PDF/教材/文件类型有效。指定后只返回该页范围的内容。',
        },
        page_end: {
          type: 'integer',
          minimum: 1,
          description: '可选：结束页码（1-based，包含），仅对 PDF/教材/文件类型有效。未指定时默认等于 page_start（只读单页）。',
        },
      },
      required: ['resource_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}resource_search`,
    displayNameKey: 'mcp.tools.resource_search',
    description:
      '在学习资源中全文搜索。当用户询问特定知识点、想查找某个主题的笔记、或寻找相关学习材料时使用。' +
      '返回匹配的资源列表和相关片段。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词。支持标题和内容搜索。',
        },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap'],
          },
          description: '可选：限制搜索的资源类型。不指定则搜索所有类型。',
        },
        folder_id: {
          type: 'string',
          description: '可选：限制搜索范围到指定文件夹。不指定则全局搜索。',
        },
        top_k: {
          type: 'integer',
          default: 10,
          minimum: 1,
          maximum: 50,
          description: '返回结果数量，默认10条，最多50条',
        },
      },
      required: ['query'],
    },
  },

  // ============================================================================
  // Canvas 笔记编辑工具（完全前端模式）
  // ============================================================================

  {
    name: `${BUILTIN_NAMESPACE}note_read`,
    displayNameKey: 'mcp.tools.note_read',
    description:
      '读取当前笔记的内容。当用户询问笔记内容、需要分析笔记、或要基于笔记进行操作时使用。' +
      '可指定 section 参数只读取特定章节。',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。',
        },
        section: {
          type: 'string',
          description: '可选：要读取的章节标题（如 "## 代码实现"）。不指定则读取完整内容。',
        },
      },
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}note_append`,
    displayNameKey: 'mcp.tools.note_append',
    description:
      '追加内容到笔记末尾。当用户要求添加新内容、补充笔记、或在笔记中添加总结时使用。' +
      '可指定 section 参数追加到特定章节末尾。支持 Markdown 格式。',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。',
        },
        content: {
          type: 'string',
          description: '要追加的内容（支持 Markdown 格式）',
        },
        section: {
          type: 'string',
          description: '可选：要追加到的章节标题（如 "## 代码实现"）。不指定则追加到末尾。',
        },
      },
      required: ['content'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}note_replace`,
    displayNameKey: 'mcp.tools.note_replace',
    description:
      '替换笔记中的内容。当用户要求修改特定内容、更正错误、或更新笔记中的某部分时使用。' +
      '支持普通文本和正则表达式。',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。',
        },
        search: {
          type: 'string',
          description: '要查找的文本或正则表达式',
        },
        replace: {
          type: 'string',
          description: '替换后的文本',
        },
        is_regex: {
          type: 'boolean',
          description: '是否使用正则表达式（默认 false）',
          default: false,
        },
      },
      required: ['search', 'replace'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}note_set`,
    displayNameKey: 'mcp.tools.note_set',
    description:
      '设置笔记的完整内容。⚠️ 谨慎使用，会覆盖原有内容。' +
      '当用户要求重写整个笔记、或需要完全替换笔记内容时使用。支持 Markdown 格式。',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。',
        },
        content: {
          type: 'string',
          description: '笔记的新完整内容（支持 Markdown 格式）',
        },
      },
      required: ['content'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}note_create`,
    displayNameKey: 'mcp.tools.note_create',
    description:
      '创建新笔记。当用户要求创建新的笔记、调研报告、或需要记录新内容时使用。' +
      '创建成功后返回笔记 ID，可用于后续的读写操作。',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '笔记标题（必填）',
        },
        content: {
          type: 'string',
          description: '笔记初始内容（支持 Markdown 格式）',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：笔记标签列表',
        },
      },
      required: ['title'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}note_list`,
    displayNameKey: 'mcp.tools.note_list',
    description:
      '列出用户的笔记。当用户询问有哪些笔记、需要查看笔记列表、或搜索特定笔记时使用。' +
      '可按文件夹、标签或关键词过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        folder_id: {
          type: 'string',
          description: '可选：限制在特定文件夹内搜索',
        },
        tag: {
          type: 'string',
          description: '可选：按标签过滤',
        },
        limit: {
          type: 'integer',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: '返回的最大笔记数量，默认 20',
        },
      },
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}note_search`,
    displayNameKey: 'mcp.tools.note_search',
    description:
      '搜索笔记内容。当用户需要查找包含特定内容的笔记、或按关键词搜索时使用。' +
      '返回匹配的笔记列表及相关内容片段。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词或短语',
        },
        folder_id: {
          type: 'string',
          description: '可选：限制在特定文件夹内搜索',
        },
        top_k: {
          type: 'integer',
          default: 10,
          minimum: 1,
          maximum: 50,
          description: '返回的结果数量，默认 10',
        },
      },
      required: ['query'],
    },
  },

  // ============================================================================
  // 知识内化工具
  // ============================================================================

  {
    name: `${BUILTIN_NAMESPACE}knowledge_internalize`,
    displayNameKey: 'mcp.tools.knowledge_internalize',
    description:
      '将知识点内化到知识图谱。把对话中提取的知识点转化为持久化的图谱节点。' +
      '当用户要求保存学习要点、内化知识、创建笔记卡片时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: '会话ID（格式：chat-xxx 或纯UUID）',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: '知识点内容',
              },
              category: {
                type: 'string',
                description: '知识类别（如：概念、定理、方法、易错点等）',
              },
            },
            required: ['content', 'category'],
          },
          description: '要内化的知识点列表（最多32条）',
        },
        graph_id: {
          type: 'string',
          description: '可选：目标图谱ID。如不指定则使用默认图谱。',
        },
      },
      required: ['conversation_id', 'items'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}knowledge_extract`,
    displayNameKey: 'mcp.tools.knowledge_extract',
    description:
      '从对话中提取知识点。分析对话内容，自动识别值得记忆的知识点候选。' +
      '当用户想要整理对话中的学习要点、总结知识或准备内化时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: '会话ID（格式：chat-xxx 或纯UUID）',
        },
        chat_history: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['user', 'assistant'],
                description: '消息角色',
              },
              content: {
                type: 'string',
                description: '消息内容',
              },
            },
            required: ['role', 'content'],
          },
          description: '对话历史记录',
        },
        focus_categories: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：重点提取的知识类别（如：概念、公式、方法等）',
        },
      },
      required: ['conversation_id', 'chat_history'],
    },
  },

  // ============================================================================
  // TodoList 任务列表工具（永续执行 Agent）
  // ============================================================================

  {
    name: `${BUILTIN_NAMESPACE}todo_init`,
    displayNameKey: 'mcp.tools.todo_init',
    description:
      '初始化任务列表。将复杂任务分解为可执行的子步骤。' +
      '当用户提出需要多步骤完成的任务时使用，如"请帮我完成..."、"请调研..."等。' +
      '调用后会创建任务列表，AI 可以逐步执行并更新状态。',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '任务的整体目标或标题',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: '步骤描述，具体说明要做什么',
              },
            },
            required: ['description'],
          },
          description: '任务步骤列表，按执行顺序排列',
        },
      },
      required: ['title', 'steps'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}todo_update`,
    displayNameKey: 'mcp.tools.todo_update',
    description:
      '更新任务步骤的状态。每完成一个步骤都应调用此工具。' +
      '状态包括：running（执行中）、completed（已完成）、failed（失败）、skipped（跳过）。',
    inputSchema: {
      type: 'object',
      properties: {
        stepId: {
          type: 'string',
          description: '要更新的步骤 ID（如 step_1, step_2）',
        },
        status: {
          type: 'string',
          enum: ['running', 'completed', 'failed', 'skipped'],
          description: '新状态',
        },
        result: {
          type: 'string',
          description: '执行结果摘要（完成或失败时提供）',
        },
      },
      required: ['stepId', 'status'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}todo_add`,
    displayNameKey: 'mcp.tools.todo_add',
    description:
      '动态添加新任务步骤。在执行过程中发现需要额外步骤时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '新步骤的描述',
        },
        afterStepId: {
          type: 'string',
          description: '插入位置，在此步骤之后插入。省略则添加到末尾。',
        },
      },
      required: ['description'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}todo_get`,
    displayNameKey: 'mcp.tools.todo_get',
    description:
      '获取当前任务列表及所有步骤的状态。用于查看任务进度。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // Anki 制卡工具（CardForge 2.0）已移除 — 全部由 ChatAnki skill 接管
  // 后端 AnkiToolExecutor 仍注册但不再暴露给 LLM

  {
    name: `${BUILTIN_NAMESPACE}qbank_list`,
    displayNameKey: 'mcp.tools.qbank_list',
    description:
      '列出用户的所有题目集，返回每个题目集的基本信息和学习统计数据。无需 session_id 参数。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: '返回数量限制',
        },
        offset: {
          type: 'integer',
          default: 0,
          minimum: 0,
          description: '偏移量（用于分页）',
        },
        search: {
          type: 'string',
          description: '搜索关键词（匹配题目集名称）',
        },
        include_stats: {
          type: 'boolean',
          default: true,
          description: '是否包含统计信息（总题数、已掌握、需复习等）',
        },
      },
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_list_questions`,
    displayNameKey: 'mcp.tools.qbank_list_questions',
    description:
      '列出题目集中的题目。支持按状态、难度、标签筛选，支持分页。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '题目集 ID',
        },
        status: {
          type: 'string',
          enum: ['new', 'in_progress', 'mastered', 'review'],
          description: '筛选状态：new=新题, in_progress=学习中, mastered=已掌握, review=需复习',
        },
        difficulty: {
          type: 'string',
          enum: ['easy', 'medium', 'hard', 'very_hard'],
          description: '筛选难度',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '筛选标签（任意匹配）',
        },
        page: {
          type: 'integer',
          default: 1,
          minimum: 1,
          description: '页码',
        },
        page_size: {
          type: 'integer',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: '每页数量',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_get_question`,
    displayNameKey: 'mcp.tools.qbank_get_question',
    description: '获取单个题目的详细信息，包括题干、答案、解析、用户作答记录等。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '题目集 ID',
        },
        card_id: {
          type: 'string',
          description: '题目卡片 ID',
        },
      },
      required: ['session_id', 'card_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_submit_answer`,
    displayNameKey: 'mcp.tools.qbank_submit_answer',
    description: '提交用户答案并判断正误。自动更新题目状态和统计数据。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '题目集 ID',
        },
        card_id: {
          type: 'string',
          description: '题目卡片 ID',
        },
        user_answer: {
          type: 'string',
          description: '用户提交的答案',
        },
        is_correct: {
          type: 'boolean',
          description: '是否正确（可选，如果不提供则自动判断）',
        },
      },
      required: ['session_id', 'card_id', 'user_answer'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_update_question`,
    displayNameKey: 'mcp.tools.qbank_update_question',
    description: '更新题目信息，如答案、解析、难度、标签、用户笔记等。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '题目集 ID',
        },
        card_id: {
          type: 'string',
          description: '题目卡片 ID',
        },
        answer: {
          type: 'string',
          description: '更新答案',
        },
        explanation: {
          type: 'string',
          description: '更新解析',
        },
        difficulty: {
          type: 'string',
          enum: ['easy', 'medium', 'hard', 'very_hard'],
          description: '更新难度',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '更新标签',
        },
        user_note: {
          type: 'string',
          description: '更新用户笔记',
        },
        status: {
          type: 'string',
          enum: ['new', 'in_progress', 'mastered', 'review'],
          description: '更新学习状态',
        },
      },
      required: ['session_id', 'card_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_get_stats`,
    displayNameKey: 'mcp.tools.qbank_get_stats',
    description: '获取题目集的学习统计信息，包括总题数、各状态数量、正确率等。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '题目集 ID',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_get_next_question`,
    displayNameKey: 'mcp.tools.qbank_get_next_question',
    description: '获取下一道推荐题目。支持多种模式：顺序、随机、错题优先、知识点聚焦。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '题目集 ID',
        },
        mode: {
          type: 'string',
          enum: ['sequential', 'random', 'review_first', 'by_tag'],
          default: 'sequential',
          description: '推题模式：sequential=顺序, random=随机, review_first=错题优先, by_tag=按标签',
        },
        tag: {
          type: 'string',
          description: '当 mode=by_tag 时，指定要练习的标签',
        },
        current_card_id: {
          type: 'string',
          description: '当前题目 ID（用于顺序模式获取下一题）',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_generate_variant`,
    displayNameKey: 'mcp.tools.qbank_generate_variant',
    description: '基于原题生成变式题。AI 会保持题目结构和考点，但改变具体数值或情境。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '题目集 ID',
        },
        card_id: {
          type: 'string',
          description: '原题卡片 ID',
        },
        variant_type: {
          type: 'string',
          enum: ['similar', 'harder', 'easier', 'different_context'],
          default: 'similar',
          description: '变式类型：similar=相似, harder=更难, easier=更简单, different_context=不同情境',
        },
      },
      required: ['session_id', 'card_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_batch_import`,
    displayNameKey: 'mcp.tools.qbank_batch_import',
    description: '批量导入题目到题目集。支持 JSON 格式的题目数据。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '目标题目集 ID（可选，不提供则创建新题目集）',
        },
        name: {
          type: 'string',
          description: '新题目集名称（创建新题目集时使用）',
        },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '题干内容' },
              answer: { type: 'string', description: '答案' },
              explanation: { type: 'string', description: '解析' },
              question_type: {
                type: 'string',
                enum: ['single_choice', 'multiple_choice', 'fill_blank', 'short_answer', 'essay', 'calculation', 'proof', 'other'],
              },
              difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'] },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['content'],
          },
          description: '要导入的题目列表',
        },
      },
      required: ['questions'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_reset_progress`,
    displayNameKey: 'mcp.tools.qbank_reset_progress',
    description: '重置题目集的学习进度。可以重置全部或指定题目。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '题目集 ID',
        },
        card_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要重置的题目 ID 列表（可选，不提供则重置全部）',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_export`,
    displayNameKey: 'mcp.tools.qbank_export',
    description: '导出题目集为 JSON 或 Markdown 格式。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: '题目集 ID',
        },
        format: {
          type: 'string',
          enum: ['json', 'markdown'],
          default: 'json',
          description: '导出格式',
        },
        include_stats: {
          type: 'boolean',
          default: true,
          description: '是否包含学习统计',
        },
        filter_status: {
          type: 'string',
          enum: ['new', 'in_progress', 'mastered', 'review'],
          description: '只导出指定状态的题目',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}qbank_import_document`,
    displayNameKey: 'mcp.tools.qbank_import_document',
    description:
      '从文档导入题目到题目集。支持 DOCX、TXT、MD 格式。' +
      '超长文档将自动分块处理，每块独立调用 AI 解析，最后合并结果。' +
      '当用户上传题目文档、想要批量导入题目时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '文档内容（纯文本或 base64 编码）',
        },
        format: {
          type: 'string',
          enum: ['txt', 'md', 'docx', 'json'],
          default: 'txt',
          description: '文档格式。txt/md=纯文本, docx=Word文档(base64), json=结构化JSON',
        },
        name: {
          type: 'string',
          description: '题目集名称（可选，不提供则自动生成）',
        },
        session_id: {
          type: 'string',
          description: '目标题目集 ID（可选，不提供则创建新题目集）',
        },
        folder_id: {
          type: 'string',
          description: '目标文件夹 ID（创建新题目集时使用）',
        },
      },
      required: ['content'],
    },
  },

  // ============================================================================
  // 7. 工作区协作工具（仅在 Coordinator 会话或已关联工作区的会话中可用）
  // ============================================================================
  {
    name: `${BUILTIN_NAMESPACE}workspace_create`,
    displayNameKey: 'mcp.tools.workspace_create',
    description:
      '创建一个新的多 Agent 协作工作区。' +
      '【可用条件】当用户需要多个 Agent 协作完成复杂任务时使用。' +
      '工作区创建后，可以在其中注册多个 Worker Agent 分工协作。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '工作区名称（可选，不指定则自动生成）',
        },
      },
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}workspace_create_agent`,
    displayNameKey: 'mcp.tools.workspace_create_agent',
    description:
      '在工作区中创建一个新的 Agent。' +
      '【可用条件】必须先创建工作区（workspace_create）。' +
      'Worker Agent 可以指定 skill_id 来使用预置技能和推荐模型。' +
      '如果提供 initial_task，Worker 会自动启动执行任务。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: '工作区 ID',
        },
        role: {
          type: 'string',
          enum: ['coordinator', 'worker'],
          default: 'worker',
          description: 'Agent 角色：coordinator（协调者）或 worker（执行者）',
        },
        skill_id: {
          type: 'string',
          description: '技能 ID，指定 Worker 使用的预置技能（如 research, coding, writing 等）',
        },
        initial_task: {
          type: 'string',
          description: '初始任务描述。如果提供，Worker 会自动启动执行此任务',
        },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}workspace_send`,
    displayNameKey: 'mcp.tools.workspace_send',
    description:
      '向工作区中的 Agent 发送消息。' +
      '【可用条件】必须已创建工作区并存在目标 Agent。' +
      '可以发送任务、进度更新、结果等不同类型的消息。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: '工作区 ID',
        },
        content: {
          type: 'string',
          description: '消息内容',
        },
        target_session_id: {
          type: 'string',
          description: '目标 Agent 的会话 ID（不指定则广播给所有 Agent）',
        },
        message_type: {
          type: 'string',
          enum: ['task', 'progress', 'result', 'query', 'correction', 'broadcast'],
          default: 'task',
          description: '消息类型',
        },
      },
      required: ['workspace_id', 'content'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}workspace_query`,
    displayNameKey: 'mcp.tools.workspace_query',
    description:
      '查询工作区信息，包括 Agent 列表、消息记录、文档等。' +
      '【可用条件】必须已创建工作区。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: '工作区 ID',
        },
        query_type: {
          type: 'string',
          enum: ['agents', 'messages', 'documents'],
          default: 'agents',
          description: '查询类型',
        },
        limit: {
          type: 'integer',
          default: 50,
          minimum: 1,
          maximum: 200,
          description: '返回结果数量限制',
        },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}workspace_set_context`,
    displayNameKey: 'mcp.tools.workspace_set_context',
    description:
      '设置工作区共享上下文变量。' +
      '【可用条件】必须已创建工作区。' +
      '所有 Agent 都可以读取和修改共享上下文，用于协作时共享状态。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: '工作区 ID',
        },
        key: {
          type: 'string',
          description: '上下文键名',
        },
        value: {
          description: '上下文值（任意 JSON 值）',
        },
      },
      required: ['workspace_id', 'key', 'value'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}workspace_get_context`,
    displayNameKey: 'mcp.tools.workspace_get_context',
    description:
      '获取工作区共享上下文变量。' +
      '【可用条件】必须已创建工作区。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: '工作区 ID',
        },
        key: {
          type: 'string',
          description: '上下文键名',
        },
      },
      required: ['workspace_id', 'key'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}workspace_update_document`,
    displayNameKey: 'mcp.tools.workspace_update_document',
    description:
      '在工作区中创建或更新文档。' +
      '【可用条件】必须已创建工作区。' +
      '文档可以是计划、研究笔记、产出物等，所有 Agent 都可以访问。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: '工作区 ID',
        },
        title: {
          type: 'string',
          description: '文档标题',
        },
        content: {
          type: 'string',
          description: '文档内容',
        },
        doc_type: {
          type: 'string',
          enum: ['plan', 'research', 'artifact', 'notes'],
          default: 'notes',
          description: '文档类型',
        },
      },
      required: ['workspace_id', 'title', 'content'],
    },
  },
  {
    name: `${BUILTIN_NAMESPACE}workspace_read_document`,
    displayNameKey: 'mcp.tools.workspace_read_document',
    description:
      '读取工作区中的文档。' +
      '【可用条件】必须已创建工作区且文档存在。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: '工作区 ID',
        },
        document_id: {
          type: 'string',
          description: '文档 ID',
        },
      },
      required: ['workspace_id', 'document_id'],
    },
  },

  // ============================================================================
  // Web Fetch 工具（参考 @anthropic/mcp-fetch）
  // ============================================================================

  {
    name: `${BUILTIN_NAMESPACE}web_fetch`,
    displayNameKey: 'mcp.tools.web_fetch',
    description:
      '抓取网页内容并转换为 Markdown 格式。当用户需要获取某个 URL 的内容、阅读文章、查看网页详情时使用。' +
      '支持分页读取长内容（通过 start_index 和 max_length 参数）。' +
      '注意：此工具用于获取特定 URL 的内容，如果需要搜索请使用 web_search。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要抓取的 URL（必须是 http:// 或 https:// 开头）',
        },
        max_length: {
          type: 'integer',
          default: 5000,
          minimum: 100,
          maximum: 50000,
          description: '最大返回字符数，默认 5000。如果内容超过此长度，可使用 start_index 分页读取。',
        },
        start_index: {
          type: 'integer',
          default: 0,
          minimum: 0,
          description: '从第几个字符开始返回，默认 0。用于分页读取长内容。',
        },
        raw: {
          type: 'boolean',
          default: false,
          description: '是否返回原始内容（不转换为 Markdown）。默认 false，会将 HTML 转换为 Markdown 便于阅读。',
        },
      },
      required: ['url'],
    },
  },
];

function buildBuiltinToolsFromSkills(): BuiltinToolSchema[] {
  const tools: BuiltinToolSchema[] = [];
  for (const skill of builtinToolSkills) {
    if (!skill.embeddedTools) {
      continue;
    }
    for (const tool of skill.embeddedTools) {
      const shortName = tool.name.startsWith(BUILTIN_NAMESPACE)
        ? tool.name.replace(BUILTIN_NAMESPACE, '')
        : tool.name.replace('mcp_', '');
      tools.push({
        name: tool.name,
        displayNameKey: `tools.${shortName}`,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
      });
    }
  }
  return tools;
}

function applyWebSearchEngines(
  tool: BuiltinToolSchema,
  availableSearchEngines?: string[]
): BuiltinToolSchema {
  if (stripBuiltinNamespace(tool.name) !== 'web_search') {
    return tool;
  }
  const validEngines = availableSearchEngines?.filter(
    (e): e is SearchEngineId => ALL_SEARCH_ENGINE_IDS.includes(e as SearchEngineId)
  );
  if (!validEngines || validEngines.length === 0) {
    return tool;
  }
  const inputSchema =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? { ...(tool.inputSchema as Record<string, unknown>) }
      : { type: 'object', properties: {} };
  const properties = {
    ...((inputSchema.properties as Record<string, unknown>) ?? {}),
  };
  properties.engine = {
    type: 'string',
    enum: validEngines,
    description: `可用的搜索引擎：${validEngines.join(', ')}。如果不指定，使用默认配置的引擎。`,
  };
  inputSchema.properties = properties;
  return {
    ...tool,
    inputSchema,
  };
}

function getBuiltinToolsFromSkills(availableSearchEngines?: string[]): BuiltinToolSchema[] {
  const tools = buildBuiltinToolsFromSkills();
  if (!availableSearchEngines) {
    return tools;
  }
  return tools.map((tool) => applyWebSearchEngines(tool, availableSearchEngines));
}

/**
 * MCP 工具类型（与 DialogControlContext 中的类型对齐）
 */
export interface McpTool {
  id: string;
  name: string;
  description?: string;
  isOnline?: boolean;
  serverId?: string;
  serverName?: string;
}

/**
 * MCP 服务器类型（与 DialogControlContext 中的类型对齐）
 */
export interface McpServer {
  id: string;
  name: string;
  connected: boolean;
  toolsCount: number;
  tools: McpTool[];
}

/**
 * 获取内置服务器实例
 *
 * 🔧 2026-01-20: 从新的 Skills 系统获取工具定义，不再使用废弃的 BUILTIN_TOOLS 数组
 *
 * @param _availableSearchEngines 已废弃，保留参数签名以保持兼容
 */
export function getBuiltinServer(_availableSearchEngines?: string[]): McpServer {
  // 从新的 Skills 系统动态获取所有内置工具
  // 使用静态导入的 builtinToolSkills（无循环依赖）
  const skills = builtinToolSkills;

  const tools: McpTool[] = [];
  for (const skill of skills) {
    if (skill.embeddedTools) {
      for (const tool of skill.embeddedTools) {
        tools.push({
          id: tool.name,
          name: tool.name.replace(BUILTIN_NAMESPACE, ''),
          description: tool.description,
          isOnline: true, // 内置工具始终在线
          serverId: BUILTIN_SERVER_ID,
          serverName: BUILTIN_SERVER_NAME,
        });
      }
    }
  }

  return {
    id: BUILTIN_SERVER_ID,
    name: BUILTIN_SERVER_NAME,
    connected: true, // 内置服务器始终"已连接"
    toolsCount: tools.length,
    tools,
  };
}

/**
 * 检查是否为内置服务器
 */
export function isBuiltinServer(serverId: string): boolean {
  return serverId === BUILTIN_SERVER_ID;
}

/**
 * 检查工具名称是否为内置工具
 */
export function isBuiltinTool(toolName: string): boolean {
  return toolName.startsWith(BUILTIN_NAMESPACE);
}

/**
 * 从工具名称中去除内置命名空间前缀
 */
export function stripBuiltinNamespace(toolName: string): string {
  return toolName.replace(BUILTIN_NAMESPACE, '');
}

/**
 * 获取内置工具的 Schema 列表（用于传递给后端）
 * 
 * @param availableSearchEngines 可用的搜索引擎 ID 列表。传入后 web_search 工具的 engine 参数只会包含这些引擎。
 */
export function getBuiltinToolSchemas(availableSearchEngines?: string[]): Array<{
  name: string;
  description?: string;
  inputSchema?: unknown;
}> {
  const allTools = getBuiltinToolsWithDynamicSchema(availableSearchEngines);
  return allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * 获取工具的 displayNameKey
 *
 * 🔧 2026-01-20: 动态生成 i18n 键，格式为 mcp.tools.{toolName}
 * 🔧 2026-01-21: 扩展支持 mcp_ 前缀（由 Pipeline 添加）
 *
 * @param toolName 工具名称（如 builtin-web_search 或 mcp_load_skills）
 * @returns i18n 翻译键，如果不是内置工具则返回 undefined
 */
export function getToolDisplayNameKey(toolName: string): string | undefined {
  // 支持 builtin- 前缀
  if (toolName.startsWith(BUILTIN_NAMESPACE)) {
    const shortName = toolName.replace(BUILTIN_NAMESPACE, '');
    return `tools.${shortName}`;
  }
  // 支持 mcp_ 前缀（由 Pipeline 添加）
  if (toolName.startsWith('mcp_')) {
    const shortName = toolName.replace('mcp_', '');
    return `tools.${shortName}`;
  }
  return undefined;
}

/**
 * 检查工具是否有国际化显示名称
 */
export function hasToolDisplayName(toolName: string): boolean {
  return toolName.startsWith(BUILTIN_NAMESPACE) || toolName.startsWith('mcp_');
}

// ============================================================================
// 动态 web_search 工具 Schema 生成
// ============================================================================

/**
 * 所有支持的搜索引擎 ID
 */
export const ALL_SEARCH_ENGINE_IDS = [
  'google_cse',
  'serpapi',
  'tavily',
  'brave',
  'searxng',
  'zhipu',
  'bocha',
] as const;

export type SearchEngineId = typeof ALL_SEARCH_ENGINE_IDS[number];

/**
 * 动态生成 web_search 工具的 Schema
 * 
 * @param availableEngines 可用的搜索引擎 ID 列表。如果为空或未提供，则不包含 engine 参数（让后端自动选择）
 * @returns web_search 工具的完整 Schema
 */
export function getWebSearchToolSchema(availableEngines?: string[]): BuiltinToolSchema {
  const tools = getBuiltinToolsFromSkills(availableEngines);
  const webSearchTool = tools.find(
    (tool) => stripBuiltinNamespace(tool.name) === 'web_search'
  );
  if (webSearchTool) {
    return webSearchTool;
  }
  return {
    name: `${BUILTIN_NAMESPACE}web_search`,
    displayNameKey: 'tools.web_search',
    description: '搜索互联网获取最新信息。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询文本',
        },
      },
      required: ['query'],
    },
  };
}

/**
 * 获取完整的内置工具列表（包含动态生成的 web_search）
 * 
 * @param availableSearchEngines 可用的搜索引擎 ID 列表
 * @returns 完整的内置工具 Schema 列表
 */
export function getBuiltinToolsWithDynamicSchema(availableSearchEngines?: string[]): BuiltinToolSchema[] {
  return getBuiltinToolsFromSkills(availableSearchEngines);
}
