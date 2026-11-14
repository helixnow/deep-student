import { debugChannel } from '../bus';
import type * as Panel from '../../../debug-panel/plugins/CrepeEditorDebugPlugin';

export const CREPE_EDITOR_DEBUG_CHANNEL = 'crepe-editor';

const channel = debugChannel<Pick<typeof Panel, 'emitCrepeDebug' | 'captureDOMSnapshot'>>(CREPE_EDITOR_DEBUG_CHANNEL);

export const emitCrepeDebug = channel.emitter('emitCrepeDebug');
export const captureDOMSnapshot = channel.query('captureDOMSnapshot');
