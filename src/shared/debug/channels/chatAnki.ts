import { debugChannel } from '../bus';
import type * as Panel from '../../../debug-panel/plugins/ChatAnkiWorkflowDebugPlugin';

export type { ChatAnkiLifecycleDetail } from '../../../debug-panel/plugins/ChatAnkiWorkflowDebugPlugin';

export const CHAT_ANKI_DEBUG_CHANNEL = 'chatanki';

const channel = debugChannel<Pick<typeof Panel, 'recordChatAnkiLifecycle'>>(CHAT_ANKI_DEBUG_CHANNEL);

/** Same detail as the `chatanki-debug-lifecycle` window event; a no-op in production builds. */
export const emitChatAnkiLifecycle = channel.emitter('recordChatAnkiLifecycle');
