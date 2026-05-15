import type { AttachmentMeta } from './common';
import type { ContextRef } from '../../context/types';

export type QueuedMessageStatus = 'pending' | 'failed';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments: AttachmentMeta[];
  contextRefs: ContextRef[];
  createdAt: number;
  status: QueuedMessageStatus;
  /** Human-readable error surfaced via tooltip on the failed bubble. */
  error?: string;
}

export const QUEUE_HARD_CAP = 5;
export const QUEUE_DEQUEUE_BREATHER_MS = 300;
