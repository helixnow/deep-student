/**
 * 壁纸链路诊断日志（问题 3：桌面壁纸显示为雪白 / 自定义图片未生效）
 * ---------------------------------------------------------------------------
 * 沿「导入 → 持久化 → 桌面读取 → 渲染 → 图片加载」链路打点，统一前缀
 * `[wallpaper-diag]`，便于在应用日志中 grep 定位断点：
 * - Tauri 运行时经 `log_debug_message` 写入应用日志（target=frontend_debug）；
 * - 非 Tauri（vitest / 浏览器调试）只输出 console；
 * - 诊断本身绝不影响壁纸功能：所有出口 best-effort，异常静默。
 *
 * 关键盲区：CSS `background-image` 加载失败是完全静默的（不会抛错、不会
 * 出现在控制台），所以渲染侧额外用 `Image()` 主动探测并把 naturalWidth/
 * naturalHeight 与耗时写入日志——「图片 404 / asset 协议被拒」与「图片本身
 * 过白」由此可区分。
 */

export const WALLPAPER_DIAG_PREFIX = '[wallpaper-diag]';

type DiagPayload = Record<string, unknown>;

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const scope = window as unknown as Record<string, unknown>;
  return Boolean(scope.__TAURI_INTERNALS__) || Boolean(scope.__TAURI_IPC__);
}

function safeStringify(payload: DiagPayload): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return '[unserializable]';
  }
}

/**
 * 记录一条壁纸链路诊断。
 * console 始终输出（dev / 浏览器调试可见）；Tauri 运行时额外写入日志文件。
 */
export function logWallpaperDiag(stage: string, payload: DiagPayload = {}): void {
  const message = `${WALLPAPER_DIAG_PREFIX} ${stage} ${safeStringify(payload)}`;
  try {
    // eslint-disable-next-line no-console -- 诊断日志需在 dev 控制台可见
    console.info(message);
  } catch {
    // noop
  }
  if (!isTauriRuntime()) return;
  // 动态导入：WallpaperLayer 等模块的测试只 mock 了 convertFileSrc，
  // 静态引用 invoke 会在非 Tauri 测试环境拿到 undefined。
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('log_debug_message', { message }))
    .catch(() => {
      // 诊断失败不影响壁纸功能
    });
}

/** 错误对象 → 可读字符串（诊断用，避免只记 "[object Object]"） */
export function describeDiagError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
