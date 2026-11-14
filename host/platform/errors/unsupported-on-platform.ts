/**
 * “当前平台没有这项能力”的统一代号与消息格式。存储层 `StorageError('UNSUPPORTED_ON_PLATFORM')`、`ctx.http` 的
 * `HttpError('UnsupportedOnPlatform')` 与插件装载降级原因共用这一份；非 Rust 错误到前端只剩消息文本，前端按
 * {@link UNSUPPORTED_ON_PLATFORM_PREFIX} 识别。没有任何导入，前端与移动端 worker 可直接引用。
 */

export const UNSUPPORTED_ON_PLATFORM = 'UNSUPPORTED_ON_PLATFORM';

/** 错误消息的固定前缀。 */
export const UNSUPPORTED_ON_PLATFORM_PREFIX = `${UNSUPPORTED_ON_PLATFORM}: `;

/**
 * `UNSUPPORTED_ON_PLATFORM: <capability> is not available on <platform>[: <detail>]`。
 * `capability` 用平台能力清单（`mobile/src/capabilities.ts`）中的 id。
 */
export function unsupportedOnPlatformMessage(capability: string, platform: string, detail?: string): string {
  return `${UNSUPPORTED_ON_PLATFORM_PREFIX}${capability} is not available on ${platform}${detail ? `: ${detail}` : ''}`;
}

const MESSAGE_RE = /^UNSUPPORTED_ON_PLATFORM: (\S+) is not available on (.+?)(?:: ([\s\S]*))?$/;

/**
 * 从 {@link unsupportedOnPlatformMessage} 格式的消息取回能力 id、平台与说明；不是该格式时 null。
 * 插件装载的降级原因只带代号（`UNSUPPORTED_ON_PLATFORM: plugin "<id>" supports …`），不是能力格式，同样返回 null。
 */
export function parseUnsupportedOnPlatform(message: string): { capability: string; platform: string; detail?: string } | null {
  const match = MESSAGE_RE.exec(message);
  if (!match) return null;
  return { capability: match[1]!, platform: match[2]!, ...(match[3] !== undefined ? { detail: match[3] } : {}) };
}
