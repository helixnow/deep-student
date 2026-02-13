export const CHAT_DELETE_RENDER_EVENT = 'debug:chat-delete-render';

export type ChatDeleteRenderEventDetail = {
  trackingId: string;
  stableId?: string;
  renderCount: number;
  removed: boolean;
  chatHistoryLength: number;
  durationMs: number;
  timestamp: string;
};
