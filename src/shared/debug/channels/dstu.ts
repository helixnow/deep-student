import { debugChannel } from '../bus';
import type { dstuDebugLog as PanelLog } from '../../../debug-panel/plugins/DstuDebugPlugin';

export const DSTU_DEBUG_CHANNEL = 'dstu';

const channel = debugChannel<typeof PanelLog>(DSTU_DEBUG_CHANNEL);

export const dstuDebugLog: typeof PanelLog = {
  call: channel.emitter('call'),
  success: channel.emitter('success'),
  error: channel.emitter('error'),
};
