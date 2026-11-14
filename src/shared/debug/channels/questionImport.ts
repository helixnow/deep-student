import { debugChannel } from '../bus';
import type * as Panel from '../../../debug-panel/plugins/QuestionImportDebugPlugin';

export const QUESTION_IMPORT_DEBUG_CHANNEL = 'question-import';

const channel = debugChannel<Pick<typeof Panel, 'emitImportDebug'>>(QUESTION_IMPORT_DEBUG_CHANNEL);

export const emitImportDebug = channel.emitter('emitImportDebug');
