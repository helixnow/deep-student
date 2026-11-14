/**
 * 事件名规则（Tauri `is_event_name_valid` / `Error::IllegalEventName`）。前端 `emit`/`listen`（外壳 `electron/shell/events.ts`、
 * 移动端外壳）与 Host `backendEvents` 用同一条规则。
 * 可移植：不依赖 Node 内建模块与 Cordis，`plugin-id.ts` 和前端可直接导入。
 */

/** `is_event_name_valid`：Rust `char::is_alphanumeric` 覆盖 Unicode 字母与数字。 */
export function isEventNameValid(event: string): boolean {
  return /^[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}\-/:_]*$/u.test(event);
}

/** `crate::Error::IllegalEventName` 的 Display（src/error.rs:164）。 */
export function illegalEventName(event: string): string {
  return `only alphanumeric, '-', '/', ':', '_' permitted for event names: ${JSON.stringify(event)}`;
}
