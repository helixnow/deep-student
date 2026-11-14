/**
 * Headless builtin tool schemas (headless.rs:664–1133), filtered by the
 * headless whitelist at construction time.
 *
 * Generated from the Rust source so the pagination/limit contracts the
 * headless tests assert stay byte-for-byte identical.
 */
export interface HeadlessToolSchema {
  name: string;
  serverId?: null;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const HEADLESS_TOOL_SCHEMAS: readonly HeadlessToolSchema[] = [
  {
    name: "builtin-unified_search",
    serverId: null,
    description: "统一搜索：同时搜索知识库文档、图片/PDF、用户记忆，合并返回最相关结果。默认首选搜索工具。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "【必填】搜索查询文本"
        },
        top_k: {
          type: "integer",
          description: "每种搜索源返回的最大结果数，默认 10",
          default: 10,
          minimum: 1,
          maximum: 30
        },
        enable_reranking: {
          type: "boolean",
          description: "是否启用重排序，默认启用",
          default: true
        }
      },
      required: [
        "query"
      ]
    }
  },
  {
    name: "builtin-rag_search",
    serverId: null,
    description: "在本地知识库中检索相关文档片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "【必填】搜索查询文本"
        },
        top_k: {
          type: "integer",
          description: "返回结果数量，默认 10",
          default: 10,
          minimum: 1,
          maximum: 30
        }
      },
      required: [
        "query"
      ]
    }
  },
  {
    name: "builtin-web_search",
    serverId: null,
    description: "搜索互联网获取最新信息。当本地知识库没有答案或需要实时信息时使用。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "【必填】搜索查询文本"
        },
        top_k: {
          type: "integer",
          description: "返回结果数量，默认 5",
          default: 5,
          minimum: 1,
          maximum: 20
        }
      },
      required: [
        "query"
      ]
    }
  },
  {
    name: "builtin-web_fetch",
    serverId: null,
    description: "抓取并解析指定网页的内容。",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "【必填】要抓取的网页 URL"
        }
      },
      required: [
        "url"
      ]
    }
  },
  {
    name: "builtin-memory_read",
    serverId: null,
    description: "读取指定记忆的完整内容。note_id 从 unified_search 的记忆结果或 memory_list 获取。",
    inputSchema: {
      type: "object",
      properties: {
        note_id: {
          type: "string",
          description: "【必填】记忆笔记 ID"
        }
      },
      required: [
        "note_id"
      ]
    }
  },
  {
    name: "builtin-memory_list",
    serverId: null,
    description: "列出记忆目录结构和笔记列表。返回笔记 ID、标题、文件夹路径和更新时间。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        folder: {
          type: "string",
          description: "相对于记忆根目录的文件夹路径，留空表示根目录"
        },
        limit: {
          type: "integer",
          description: "返回数量限制，默认及最多 20",
          default: 20,
          minimum: 1,
          maximum: 20
        },
        offset: {
          type: "integer",
          description: "分页偏移量，默认 0",
          default: 0,
          minimum: 0
        }
      }
    }
  },
  {
    name: "builtin-resource_list",
    serverId: null,
    description: "列出用户的学习资源。可按类型（笔记、教材、整卷、作文、翻译、知识导图）和文件夹筛选。",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "note",
            "textbook",
            "file",
            "image",
            "exam",
            "essay",
            "translation",
            "mindmap",
            "all"
          ],
          default: "all",
          description: "资源类型"
        },
        folder_id: {
          type: "string",
          description: "可选：文件夹 ID"
        },
        search: {
          type: "string",
          description: "可选：按标题/名称过滤的关键词"
        },
        limit: {
          type: "integer",
          default: 20,
          minimum: 1,
          maximum: 100,
          description: "返回数量限制"
        }
      }
    }
  },
  {
    name: "builtin-resource_read",
    serverId: null,
    description: "读取指定学习资源的内容。resource_id 用 DSTU 格式 ID（note_xxx / tb_xxx 等）。多页文档支持 page_start/page_end 按页读取。大文本用 offset（UTF-8 字节偏移）与 max_bytes 续读，返回 sha256（页范围后完整逻辑内容）、returned_bytes、next_offset、eof。offset 须落在字符边界。",
    inputSchema: {
      type: "object",
      properties: {
        resource_id: {
          type: "string",
          description: "【必填】资源 ID（DSTU 格式）"
        },
        include_metadata: {
          type: "boolean",
          description: "是否包含元数据，默认 true"
        },
        page_start: {
          type: "integer",
          minimum: 1,
          description: "可选：起始页码（1-based）"
        },
        page_end: {
          type: "integer",
          minimum: 1,
          description: "可选：结束页码（含）"
        },
        time_start: {
          type: "number",
          description: "可选：音视频转写起始秒"
        },
        time_end: {
          type: "number",
          description: "可选：结束秒，单次≤10分钟"
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "UTF-8 字节偏移，须落在字符边界；续读时传上次 next_offset"
        },
        max_bytes: {
          type: "integer",
          minimum: 1,
          maximum: 1048576,
          default: 65536,
          description: "本次最多返回的正文字节数"
        },
        expected_hash: {
          type: "string",
          description: "可选：上次读取返回的逻辑内容 sha256"
        }
      },
      required: [
        "resource_id"
      ]
    }
  },
  {
    name: "builtin-resource_search",
    serverId: null,
    description: "在学习资源中全文搜索，返回匹配的资源列表和相关片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "【必填】搜索关键词"
        },
        folder_id: {
          type: "string",
          description: "可选：限制搜索范围到指定文件夹"
        },
        top_k: {
          type: "integer",
          default: 10,
          minimum: 1,
          maximum: 50,
          description: "返回结果数量"
        }
      },
      required: [
        "query"
      ]
    }
  },
  {
    name: "builtin-folder_list",
    serverId: null,
    description: "列出用户的文件夹结构。",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: {
          type: "string",
          description: "父文件夹 ID，为空或 \"root\" 时列出根目录"
        },
        include_count: {
          type: "boolean",
          description: "是否包含资源数量统计，默认 true"
        },
        recursive: {
          type: "boolean",
          description: "是否递归列出子文件夹，默认 false"
        }
      }
    }
  },
  {
    name: "builtin-dstu_list_trash",
    serverId: null,
    description: "分页列出 DSTU 回收站内容。这是只读操作，不会恢复或永久删除资源。",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          default: 20,
          minimum: 1,
          maximum: 20
        },
        offset: {
          type: "integer",
          default: 0,
          minimum: 0
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "builtin-user_todo_list_lists",
    serverId: null,
    description: "[用户待办] 分页列出用户的个人待办列表。",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "integer",
          minimum: 1,
          default: 1
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "builtin-user_todo_list_items",
    serverId: null,
    description: "[用户待办] 列出用户的待办项。支持按列表 ID 筛选与今日/逾期/即将到期视图。",
    inputSchema: {
      type: "object",
      properties: {
        list_id: {
          type: "string",
          description: "待办列表 ID（可选）"
        },
        view: {
          type: "string",
          enum: [
            "all",
            "today",
            "overdue",
            "upcoming",
            "completed"
          ],
          description: "视图过滤，默认 all"
        },
        include_completed: {
          type: "boolean",
          description: "是否包含已完成项，默认 false"
        },
        page: {
          type: "integer",
          minimum: 1,
          default: 1
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "builtin-user_todo_get_summary",
    serverId: null,
    description: "[用户待办] 获取用户待办事项总览摘要（今日、逾期、统计）。",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "builtin-user_todo_search",
    serverId: null,
    description: "[用户待办] 跨列表分页搜索待办项。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1
        },
        page: {
          type: "integer",
          minimum: 1,
          default: 1
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20
        }
      },
      required: [
        "query"
      ],
      additionalProperties: false
    }
  },
  {
    name: "builtin-user_todo_list_trash",
    serverId: null,
    description: "[用户待办] 分页查看待办项或列表回收站（只读）。",
    inputSchema: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: [
            "item",
            "list"
          ]
        },
        page: {
          type: "integer",
          minimum: 1,
          default: 1
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20
        }
      },
      required: [
        "entity_type"
      ],
      additionalProperties: false
    }
  },
  {
    name: "builtin-settings_get",
    serverId: null,
    description: "按显式安全前缀读取最多 20 个低风险应用设置；密钥、OAuth、MCP、云凭据和审批设置永不返回。",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          enum: [
            "theme",
            "language",
            "enableNotifications",
            "maxChatHistory",
            "markdownRendererMode",
            "auto_save",
            "macos.",
            "sidebar.",
            "ui.",
            "thinking.",
            "textbook."
          ]
        }
      },
      required: [
        "prefix"
      ],
      additionalProperties: false
    }
  },
  {
    name: "builtin-model_assignments_get",
    serverId: null,
    description: "读取模型职责分配和严格脱敏的分页模型目录；不返回 API key、base URL、headers 或认证配置。",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "integer",
          minimum: 1,
          default: 1
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "builtin-llm_usage_query",
    serverId: null,
    description: "查询本地 LLM token 用量、趋势和分组统计。成本仅为 estimated；缺少定价的 0 不代表免费。",
    inputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: {
            action: {
              const: "summary"
            },
            start_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$"
            },
            end_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$"
            }
          },
          required: [
            "action",
            "start_date",
            "end_date"
          ],
          additionalProperties: false
        },
        {
          type: "object",
          properties: {
            action: {
              const: "trends"
            },
            days: {
              type: "integer",
              minimum: 1,
              maximum: 366
            },
            granularity: {
              type: "string",
              enum: [
                "hour",
                "day"
              ]
            },
            offset: {
              type: "integer",
              minimum: 0,
              default: 0
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              default: 20
            }
          },
          required: [
            "action",
            "days",
            "granularity"
          ],
          additionalProperties: false
        },
        {
          type: "object",
          properties: {
            action: {
              enum: [
                "by_model",
                "by_caller"
              ]
            },
            start_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$"
            },
            end_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$"
            },
            offset: {
              type: "integer",
              minimum: 0,
              default: 0
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              default: 20
            }
          },
          required: [
            "action",
            "start_date",
            "end_date"
          ],
          additionalProperties: false
        },
        {
          type: "object",
          properties: {
            action: {
              const: "recent"
            },
            offset: {
              type: "integer",
              minimum: 0,
              default: 0
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              default: 20
            }
          },
          required: [
            "action"
          ],
          additionalProperties: false
        }
      ]
    }
  },
  {
    name: "builtin-backup_status",
    serverId: null,
    description: "分页读取本机备份目录；仅表示 local_backup_catalog，不探测云端。",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "integer",
          minimum: 1,
          default: 1
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "builtin-backup_job_status",
    serverId: null,
    description: "查询已知后台备份 job 的真实状态和 result.success；只读，不创建或取消任务。",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          minLength: 1,
          maxLength: 80
        }
      },
      required: [
        "job_id"
      ],
      additionalProperties: false
    }
  },
  {
    name: "builtin-sync_status",
    serverId: null,
    description: "读取本地 change-log 同步统计。cloud_probed=false，不能据此判断云端可达或两端一致。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "builtin-qbank_list",
    serverId: null,
    description: "列出用户的所有题目集，返回基本信息和学习统计数据。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          default: 20,
          minimum: 1,
          maximum: 20
        },
        offset: {
          type: "integer",
          default: 0,
          minimum: 0
        },
        search: {
          type: "string",
          description: "搜索关键词（匹配题目集名称）"
        },
        include_stats: {
          type: "boolean",
          default: true,
          description: "是否包含统计信息"
        }
      }
    }
  },
  {
    name: "builtin-qbank_list_questions",
    serverId: null,
    description: "列出题目集中的题目。支持按状态、难度、标签筛选与分页。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: {
          type: "string",
          description: "【必填】题目集 ID"
        },
        status: {
          type: "string",
          enum: [
            "new",
            "in_progress",
            "mastered",
            "review"
          ],
          description: "筛选状态"
        },
        difficulty: {
          type: "string",
          enum: [
            "easy",
            "medium",
            "hard",
            "very_hard"
          ],
          description: "筛选难度"
        },
        tags: {
          type: "array",
          items: {
            type: "string"
          },
          description: "筛选标签"
        },
        page: {
          type: "integer",
          default: 1,
          minimum: 1
        },
        page_size: {
          type: "integer",
          default: 20,
          minimum: 1,
          maximum: 20
        }
      },
      required: [
        "session_id"
      ]
    }
  },
  {
    name: "builtin-qbank_get_question",
    serverId: null,
    description: "获取单个题目的详细信息（题干、答案、解析、作答记录）。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "【必填】题目集 ID"
        },
        card_id: {
          type: "string",
          description: "【必填】题目卡片 ID"
        }
      },
      required: [
        "session_id",
        "card_id"
      ]
    }
  },
  {
    name: "builtin-qbank_get_stats",
    serverId: null,
    description: "获取题目集的学习统计信息（总题数、各状态数量、正确率等）。",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "【必填】题目集 ID"
        }
      },
      required: [
        "session_id"
      ]
    }
  },
  {
    name: "builtin-qbank_get_next_question",
    serverId: null,
    description: "获取下一道推荐题目（顺序/随机/错题优先/知识点聚焦）。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: {
          type: "string",
          description: "【必填】题目集 ID"
        },
        mode: {
          type: "string",
          enum: [
            "sequential",
            "random",
            "review_first",
            "by_tag"
          ],
          default: "sequential"
        },
        tag: {
          type: "string",
          description: "mode=by_tag 时指定要练习的标签"
        },
        current_card_id: {
          type: "string",
          description: "当前题目 ID（用于顺序模式获取下一题）"
        },
        review_only: {
          type: "boolean",
          default: false,
          description: "只选择 status=review 的错题/待复习题"
        }
      },
      required: [
        "session_id"
      ]
    }
  },
  {
    name: "builtin-index_status",
    serverId: null,
    description: "读取真实 VFS 索引摘要；可按 resource_id 查询分页 Unit 与有界 OCR/提取文本预览。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        resource_id: {
          type: "string",
          pattern: "^res_[A-Za-z0-9_-]+$"
        },
        page: {
          type: "integer",
          minimum: 1,
          default: 1
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20
        }
      }
    }
  },
  {
    name: "builtin-learning_overview",
    serverId: null,
    description: "聚合查询学习活动、题库、复习与番茄钟统计；返回分页日明细与部分数据源错误。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        start_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$"
        },
        end_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$"
        },
        page: {
          type: "integer",
          minimum: 1,
          default: 1
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20
        }
      }
    }
  },
  {
    name: "builtin-pomodoro_today_stats",
    serverId: null,
    description: "查询今日番茄钟专注统计。",
    inputSchema: {
      type: "object",
      additionalProperties: false
    }
  },
  {
    name: "builtin-pomodoro_daily_stats",
    serverId: null,
    description: "分页查询最近若干天的番茄钟日统计。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        days: {
          type: "integer",
          minimum: 1,
          maximum: 90,
          default: 7
        },
        page: {
          type: "integer",
          minimum: 1,
          default: 1
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20
        }
      }
    }
  },
  {
    name: "builtin-review_get_due",
    serverId: null,
    description: "查询今天（或指定日期前）到期的间隔重复复习计划，附题目内容预览。",
    inputSchema: {
      type: "object",
      properties: {
        exam_id: {
          type: "string",
          description: "可选：限定题目集 ID"
        },
        until_date: {
          type: "string",
          description: "可选：截止日期 YYYY-MM-DD，默认今天"
        },
        difficult_only: {
          type: "boolean",
          description: "可选：仅返回困难题"
        },
        limit: {
          type: "integer",
          default: 20,
          minimum: 1,
          maximum: 100
        },
        offset: {
          type: "integer",
          default: 0,
          minimum: 0
        }
      }
    }
  },
  {
    name: "builtin-review_stats",
    serverId: null,
    description: "获取间隔重复复习统计（各状态计划数、今日到期、逾期、正确率等）。",
    inputSchema: {
      type: "object",
      properties: {
        exam_id: {
          type: "string",
          description: "可选：限定题目集 ID"
        }
      }
    }
  }
];
