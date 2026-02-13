/**
 * 聊天保存测试系统 - 集中配置
 */

/**
 * 超时配置（毫秒）
 */
export const TIMEOUTS = {
  /** 删除事件超时 */
  DELETE_EVENT: 5000,
  /** 保存完成超时 */
  SAVE_COMPLETION: 15000,
  /** 流式完成超时 */
  STREAM_COMPLETE: 30000,
  /** 元素查找超时 */
  ELEMENT_WAIT: 5000,
} as const;

/**
 * 轮询配置
 */
export const POLLING = {
  /** 初始轮询间隔（毫秒） */
  INITIAL_INTERVAL: 200,
  /** 最大轮询间隔（毫秒） */
  MAX_INTERVAL: 2000,
  /** 退避因子 */
  BACKOFF_FACTOR: 1.5,
  /** 最大轮询次数 */
  MAX_ATTEMPTS: 50,
} as const;

/**
 * UI配置
 */
export const UI = {
  /** 最大日志条数 */
  MAX_LOGS: 500,
  /** 场景间隔（毫秒） */
  SCENARIO_INTERVAL: 500,
} as const;

/**
 * 数据完整性验证模式
 */
export enum IntegrityMode {
  /** 严格模式：所有差异都报错 */
  STRICT = 'strict',
  /** 宽松模式：允许系统扩展字段 */
  LENIENT = 'lenient',
}

/**
 * 允许的系统扩展字段（宽松模式）
 */
export const ALLOWED_SYSTEM_EXTENSIONS = [
  '_stableId',
  'createdAt',
  'updatedAt',
  'metadata.sources',
  'metadata.confidence',
] as const;

