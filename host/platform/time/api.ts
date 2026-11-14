/**
 * 平台时间模块（F4 发布）：chrono 0.4 兼容的 RFC 3339 格式化与解析。
 *
 * 类型与 serde/FromStr 解析入口从本文件发布；实现在 `index.ts`。这里没有 Cordis 服务，
 * 除 `orderedNowEpochNanos()` 记住上次结果以保证连续调用严格递增外，全部是无状态纯函数
 * （`now()` 只读取一次系统时钟）。
 */

/** chrono `SecondsFormat`（`chrono::format::SecondsFormat`）。 */
export type SecondsFormat = 'Secs' | 'Millis' | 'Micros' | 'Nanos' | 'AutoSi';

/** 同一个时刻的三种表示，保证毫秒值与字符串来自同一次采样。 */
export interface Instant {
  /** Unix 纪元纳秒（可能为负）。 */
  readonly epochNanos: bigint;
  /** `epochNanos` 向下取整到毫秒的 Unix 时间戳。 */
  readonly millis: number;
  /** `toRfc3339(epochNanos)`（UTC，`+00:00`）。 */
  readonly rfc3339: string;
}

/** 日历拆解（chrono `Datelike`/`Timelike` 的常用字段）。 */
export interface CivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0..999_999_999；闰秒解析时可能大于等于 1e9（内部表示）。 */
  nanos: number;
  /** 相对 UTC 的分钟偏移（东正）。 */
  offsetMinutes: number;
}

/** chrono DateTime 的可移植表示；parseChronoDateTimeUtc 的字段归一化为 UTC。 */
export interface ParsedDateTime extends CivilTime {
  /** Unix 纪元纳秒（闰秒已归一化到下一整秒）。 */
  epochNanos: bigint;
  /** `epochNanos` 向下取整到毫秒。 */
  millis: number;
}

/** `toRfc3339` 的选项。 */
export interface Rfc3339Options {
  /** 使用本机时区偏移（`DateTime<Local>`）而不是 UTC。默认 false。 */
  local?: boolean;
  /** 固定偏移（分钟，东正）；与 `local` 同时给出时以 `local` 为准。 */
  offsetMinutes?: number;
}

/** `parseFlexibleTimestamp` 的选项。 */
export interface FlexibleTimestampOptions {
  /**
   * 是否接受纯数字时间戳（默认 true，对应
   * `parse_flexible_timestamp_public`）。设为 false 对应 `sync/mod.rs` 内部
   * 只接受 RFC 3339 / SQLite 两种文本格式的版本。
   */
  numeric?: boolean;
}

/**
 * chrono 0.4.41 DateTime<Utc> serde 字符串 / FromStr：relaxed RFC3339。
 * 输入是已解码字符串；失败返回 null，成功保留纳秒、闰秒并将日历字段转为 UTC。
 * JSON/Option 解码由调用方负责，不能将非法字符串的 null 当作 Option::None。
 */
export { parseChronoDateTimeUtc } from './index.ts';
