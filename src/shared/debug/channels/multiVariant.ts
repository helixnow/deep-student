import { debugChannel } from '../bus';
import type * as Panel from '../../../debug-panel/plugins/MultiVariantDebugPlugin';

export const MULTI_VARIANT_DEBUG_CHANNEL = 'multi-variant';

const channel = debugChannel<Pick<typeof Panel, 'logMultiVariant'>>(MULTI_VARIANT_DEBUG_CHANNEL);

export const logMultiVariant = channel.emitter('logMultiVariant');
