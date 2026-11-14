import { debugChannel } from '../bus';
import type * as Panel from '../../../debug-panel/plugins/CrepeImageUploadDebugPlugin';

export const CREPE_IMAGE_UPLOAD_DEBUG_CHANNEL = 'crepe-image-upload';

const channel = debugChannel<Pick<typeof Panel, 'emitImageUploadDebug' | 'captureDOMInfo' | 'captureImageBlockSnapshot'>>(
  CREPE_IMAGE_UPLOAD_DEBUG_CHANNEL,
);

export const emitImageUploadDebug = channel.emitter('emitImageUploadDebug');
export const captureDOMInfo = channel.query('captureDOMInfo');
export const captureImageBlockSnapshot = channel.query('captureImageBlockSnapshot');
