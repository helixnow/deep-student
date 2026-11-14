/** Minimal L14/L16 surface pending publication in qbank/api.ts. */
export interface QbankRefReader {
  contextForRefs(examId: string): {
    schema_version: number;
    exam_id: string;
    materials: Record<string, unknown>[];
    groups: Record<string, unknown>[];
    questions: Record<string, unknown>[];
  } | null;
}
