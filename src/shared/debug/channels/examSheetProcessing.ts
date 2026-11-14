import { debugChannel } from '../bus';
import type * as Panel from '../../../debug-panel/plugins/ExamSheetProcessingDebugPlugin';

export const EXAM_SHEET_PROCESSING_DEBUG_CHANNEL = 'exam-sheet-processing';

const channel = debugChannel<Pick<typeof Panel, 'emitExamSheetDebug'>>(EXAM_SHEET_PROCESSING_DEBUG_CHANNEL);

export const emitExamSheetDebug = channel.emitter('emitExamSheetDebug');
