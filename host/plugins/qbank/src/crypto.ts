import type { Context } from '@deepseek-ai/cordis';
import type { CryptoService } from '../../../platform/crypto/api.ts';
import { createWebCrypto } from '../../../platform/crypto/web.ts';

/** `ctx.crypto`；未装平台 crypto 插件的最小 Host 退回同接口的 Web 实现（两者输出逐字节一致）。 */
export function cryptoOf(ctx: Context): CryptoService {
  return (ctx.get('crypto') as CryptoService | undefined) ?? createWebCrypto();
}
