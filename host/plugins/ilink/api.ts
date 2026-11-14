/**
 * iLink（微信 ClawBot）渠道插件的公开 API（Rust `src/plugins/ilink_bot/`）。
 *
 * 由 kernel 的插件子系统入口 `host/kernel/plugins.ts` 实例化并交给 `PluginManager` 管理，
 * 本目录没有独立的 Cordis 入口（`index.ts`）。仅桌面：客户端依赖 `node:crypto` / `node:http`，
 * 登录二维码经 `platform/util/qr.ts`（`node:zlib`）。原先从 `host/kernel/api.ts` 导出，现由此处发布。
 */
export {
  IlinkClient,
  chunkText,
  chunkMarkdownSafeText,
  computeEqualJitterBackoffMs,
  emptyCredentials,
  extractText,
  isApiError,
  isSessionExpired,
  randomWechatUin,
  DEFAULT_BASE_URL,
  CHANNEL_VERSION,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  SESSION_EXPIRED,
} from './src/client.ts';
// 注：原清单里的 `classifyIlinkPhotoText` 在 src/photo-batch.ts 中从未实现，仓库内也无任何使用者，
// 因此不再对外导出；如需该能力请先在 src 内实现后再加回这一行。
export {
  IlinkPhotoBatchAggregator,
  PHOTO_BATCH_MAX_ATTACHMENTS,
  PHOTO_QUIET_MS,
  PHOTO_MAX_WAIT_MS,
} from './src/photo-batch.ts';
export type {
  IlinkPhotoScope,
  IlinkPhotoInbound,
  IlinkPhotoBatch,
  IlinkPhotoBatchResult,
  IlinkPhotoBatchOptions,
} from './src/photo-batch.ts';
export {
  IlinkPairingGuard,
  PAIR_CODE_LENGTH,
  PAIR_TTL_MS,
  PAIR_MAX_FAILURES,
  normalizeIlinkPairingCode,
  extractIlinkPairingCode,
  evaluateChannelReadiness,
} from './src/pairing-guard.ts';
export type {
  IlinkPairingVerifyResult,
  IlinkPairingGuardOptions,
  ChannelReadinessInput,
  ChannelReadinessStage,
  ChannelReadinessReport,
} from './src/pairing-guard.ts';
export type {
  IlinkInteger,
  IlinkCredentials,
  QrcodeResponse,
  QrcodeStatusResponse,
  GetUpdatesResponse,
  WeixinMessage,
  MessageItem,
  TextItem,
  IlinkClientOptions,
  IlinkFetch,
} from './src/client.ts';
export {
  IlinkBotPlugin,
  PLUGIN_ID,
  CREDENTIALS_KEY,
  SETTINGS_PREFIX,
  DEFAULT_REMOTE_SYSTEM_APPEND,
  OUTBOUND_CHUNK_LIMIT,
} from './src/bot.ts';
export type { IlinkBotOptions, RemoteTaskBridge, RemoteDispatchInput, RemoteDispatchOutcome } from './src/bot.ts';
export { decodeIlink } from './src/decode.ts';
