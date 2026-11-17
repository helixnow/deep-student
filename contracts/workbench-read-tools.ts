/** Shared existing read-only Workbench schemas. Host and frontend use the same definitions. */
export const DIVISION = '领域内容增删改用对应领域工具；本组只执行 manifest 声明的 UI 操作。';

export const WORKBENCH_TYPE_IDS = [
  'chat',
  'note',
  'notes',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
  'file-preview',
  'mindmap',
  'files',
  'todo',
  'skills',
  'templates',
  'taskDashboard',
  'flashcards',
  'browser',
  'settings',
  'pomodoro',
  'sandbox',
] as const;

export const AGENT_CONDITION_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: {
      type: 'string' as const,
      enum: [
        'revision_changed',
        'ref_exists',
        'ref_absent',
        'selection_includes',
        'action_available',
        'state_equals',
      ],
      description: '条件类型；取值来自 observe。',
    },
    from: {
      type: 'string' as const,
      description: 'revision_changed：旧 revision。',
    },
    ref: {
      type: 'string' as const,
      description: '相关条件的稳定 AgentRef。',
    },
    action: {
      type: 'string' as const,
      description: 'action_available：capability 名。',
    },
    path: {
      type: 'string' as const,
      description: 'state_equals：点路径，如 state.status。',
    },
    value: {
      description: 'state_equals：目标值。',
    },
  },
};

export const WORKBENCH_READ_TOOLS = {
workbench_get_capabilities: {
      name: 'builtin-workbench_get_capabilities',
      description: [
        '【目的】读取子应用实时注册的 Agent manifest：能力名、输入 schema、风险、mutates、可逆/幂等与目标类型。',
        '【何时用】首次操控、切换应用或 UNKNOWN_ACTION/能力变化后；先发现再行动，不要凭硬编码清单猜测。',
        '【副作用】只读。off 档仍允许；feature flag 硬闸关闭时拒绝。',
        '【目标】可按 typeId/windowId 过滤；都省略时返回全部应用但只含能力概要（省略 inputSchema，schemasOmitted:true）；act 前须带 typeId 或 windowId 重新调用取完整 schema。',
        '【笔记 typeId】发现笔记/导图能力用 typeId:"notes"；"note" 仅为资源别名，不是发现主路径。',
        `【分工】${DIVISION}`,
        '【成功返回】{ apps: [...], schemasOmitted? }，只含应用真实声明的能力。',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          typeId: {
            type: 'string',
            enum: [...WORKBENCH_TYPE_IDS],
            description: '可选：只查询此应用类型。',
          },
          windowId: {
            type: 'string',
            description: '可选：只查询此窗口（来自 list_windows/observe）。',
          },
        },
      },
    },
workbench_observe: {
      name: 'builtin-workbench_observe',
      description: [
        '【目的】结构化观察一个子应用窗口：revision、路由/模式、dirty/busy、selection、实体稳定 ref、可用 actions 与领域 state。',
        '【何时用】act 前建立状态基线；窗口状态变化或 STALE_OBSERVATION 后重新读取。',
        '【何时不用】读取完整笔记正文/导图/领域数据集仍用对应 read/list 工具。',
        '【副作用】只读，不聚焦、不滚动、不改数据。off 档仍允许。',
        '【精确目标】多窗时传精确 windowId；回执的 windowId/ref/revision 绑定同一窗口，act/wait_for 须沿用。',
        '【稳定引用】只使用本次 observation 返回的 ref，过期后重新 observe。',
        `【分工】${DIVISION}`,
        '【成功返回】AgentObservation。',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          windowId: {
            type: 'string',
            description: '优先：目标窗口 id。',
          },
          typeId: {
            type: 'string',
            enum: [...WORKBENCH_TYPE_IDS],
            description: '无 windowId 时：目标应用类型。',
          },
          instanceKey: {
            type: 'string',
            description: '多实例应用的资源/实例 id。',
          },
        },
      },
    },
workbench_wait_for: {
      name: 'builtin-workbench_wait_for',
      description: [
        '【目的】等待结构化 observation 满足条件；适合加载完成、revision 改变、实体出现或动作变为可用。',
        '【何时用】act 已触发异步变化且回执明确仍在等待；不要固定睡眠或高频重复 observe。',
        '【副作用】只读，不执行动作；off 档仍允许。超时返回 timedOut:true，非工具故障。',
        '【限制】条件只引用结构化状态，不提供 DOM/坐标等待；多窗沿用 act/observe 的精确 windowId。',
        `【分工】${DIVISION}`,
        '【成功返回】{ matched, timedOut, elapsedMs, failedConditions, observation }。',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        anyOf: [{ required: ['condition'] }, { required: ['conditions'] }],
        properties: {
          windowId: {
            type: 'string',
            description: '优先：目标窗口 id。',
          },
          typeId: {
            type: 'string',
            enum: [...WORKBENCH_TYPE_IDS],
            description: '无 windowId 时：目标应用类型。',
          },
          instanceKey: {
            type: 'string',
            description: '多实例应用的资源/实例 id。',
          },
          condition: {
            ...AGENT_CONDITION_SCHEMA,
            description: '单个等待条件。',
          },
          conditions: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: AGENT_CONDITION_SCHEMA,
            description: '多个条件，全部满足才返回 matched:true。',
          },
          timeoutMs: {
            type: 'integer',
            minimum: 100,
            maximum: 30000,
            default: 5000,
            description: '最长等待毫秒数。',
          },
          intervalMs: {
            type: 'integer',
            minimum: 50,
            maximum: 2000,
            default: 100,
            description: '轮询间隔毫秒数。',
          },
        },
      },
    },
workbench_list_windows: {
      name: 'builtin-workbench_list_windows',
      description: [
        '【目的】列出桌面全部窗口摘要（标题、typeId、lifecycle、焦点、dirty）。',
        '【何时用】操作前侦察桌面；确认目标窗是否已开、有无未保存编辑。',
        '【何时不用】单窗状态用 query_state；不要代替领域数据查询。',
        '【副作用】只读，不开窗、不改数据。',
        `【分工】${DIVISION}`,
        '【成功返回】{ windows: WindowSummary[], focused?: windowId }。',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {},
      },
    },
workbench_query_state: {
      name: 'builtin-workbench_query_state',
      description: [
        '【目的】查询焦点窗或指定窗状态摘要（typeId/title/instanceKey/lifecycle 及 driver 扩展）。',
        '【何时用】需要比 list_windows 更细的单窗状态，或确认焦点应用。',
        '【何时不用】全桌面清单用 list_windows；正文内容用领域 read 工具。',
        '【副作用】只读，不改窗口与数据。',
        `【分工】${DIVISION}`,
        '【成功返回】{ typeId, title, instanceKey, lifecycle, ...driverExt }；无焦点/找不到窗时带可行动错误。',
      ].join(' '),
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        required: ['scope'],
        properties: {
          scope: {
            type: 'string',
            enum: ['focused', 'window'],
            description: 'focused=当前焦点窗；window=指定 windowId',
          },
          windowId: {
            type: 'string',
            description: 'scope=window 时必填：目标窗口 id',
          },
        },
      },
    }
};
