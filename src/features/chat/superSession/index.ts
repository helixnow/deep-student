/**
 * Super 会话前端功能入口
 */

export * from './api';
export { isSuperSession, getSuperSessionWorkspaceId } from './isSuperSession';
export { parseInboundOrigin, isInboundUserMessage } from './inboundOrigin';
export type { InboundItem, InboundItemKind, InboundWorkerStatus } from './inboundOrigin';
export {
  SuperResidentController,
  startSuperResidentController,
  stopSuperResidentController,
  resumeSuperInboxDelivery,
  detectMainWindow,
  isReadyForDelivery,
} from './residentController';
export {
  superResidentStore,
  useSuperResidentState,
  shouldShowPausedBanner,
} from './residentState';
export type { SuperResidentState, SuperInboxPauseReason } from './residentState';
export { SuperInboxEventCard, SuperInboxEventMessage } from './SuperInboxEventCard';
export { SuperInboxPausedBanner } from './SuperInboxPausedBanner';
export { useSuperSessionEntry } from './useSuperSessionEntry';
export type { SuperSessionEntry } from './useSuperSessionEntry';
