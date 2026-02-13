import type { SendMessageRequest } from "../adapters/types";

export type AttachmentRequestAuditSource = "frontend" | "backend";

export interface AttachmentRequestAuditInput {
  source: AttachmentRequestAuditSource;
  modelId?: string;
  isMultimodalModel: boolean;
}

interface RefInjectModeSummary {
  image: string[];
  pdf: string[];
}

interface RefBlockSummary {
  total: number;
  text: number;
  image: number;
}

interface AttachmentRequestRefAudit {
  resourceId: string;
  typeId: string;
  displayName?: string;
  injectModes: RefInjectModeSummary;
  blocks: RefBlockSummary;
}

interface AttachmentRequestExpectation {
  expectedImageBlocks: boolean;
  expectedOcrText: boolean;
  expectationMet: boolean;
  mismatchReasons: string[];
}

export interface AttachmentRequestAuditResult {
  source: AttachmentRequestAuditSource;
  sessionId: string;
  modelId?: string;
  isMultimodalModel: boolean;
  contentLength: number;
  refCount: number;
  pathMapCount: number;
  blockTotals: RefBlockSummary;
  refs: AttachmentRequestRefAudit[];
  expectation: AttachmentRequestExpectation;
}

function normalizeModes(modes?: string[]): string[] {
  if (!Array.isArray(modes)) return [];
  return modes.filter((mode): mode is string => typeof mode === "string");
}

export function buildAttachmentRequestAudit(
  request: SendMessageRequest,
  input: AttachmentRequestAuditInput
): AttachmentRequestAuditResult {
  const refs = request.userContextRefs ?? [];

  const refAudits: AttachmentRequestRefAudit[] = refs.map((ref) => {
    const blocks = ref.formattedBlocks ?? [];
    const textBlocks = blocks.filter((b) => b.type === "text").length;
    const imageBlocks = blocks.filter((b) => b.type === "image").length;

    return {
      resourceId: ref.resourceId,
      typeId: ref.typeId,
      displayName: ref.displayName,
      injectModes: {
        image: normalizeModes(ref.injectModes?.image),
        pdf: normalizeModes(ref.injectModes?.pdf),
      },
      blocks: {
        total: blocks.length,
        text: textBlocks,
        image: imageBlocks,
      },
    };
  });

  const blockTotals = refAudits.reduce(
    (acc, refAudit) => {
      acc.total += refAudit.blocks.total;
      acc.text += refAudit.blocks.text;
      acc.image += refAudit.blocks.image;
      return acc;
    },
    { total: 0, text: 0, image: 0 }
  );

  const hasImageModeSelection = refAudits.some(
    (refAudit) =>
      refAudit.injectModes.image.includes("image") || refAudit.injectModes.pdf.includes("image")
  );

  const hasOcrModeSelection = refAudits.some(
    (refAudit) =>
      refAudit.injectModes.image.includes("ocr") || refAudit.injectModes.pdf.includes("ocr")
  );

  const expectedImageBlocks = input.isMultimodalModel && hasImageModeSelection;
  const expectedOcrText = hasOcrModeSelection;

  const mismatchReasons: string[] = [];
  if (expectedImageBlocks && blockTotals.image === 0) {
    mismatchReasons.push("selected_image_mode_but_no_image_blocks");
  }
  if (expectedOcrText && blockTotals.text === 0) {
    mismatchReasons.push("selected_ocr_mode_but_no_text_blocks");
  }
  if (!input.isMultimodalModel && hasImageModeSelection && blockTotals.image > 0) {
    mismatchReasons.push("text_model_received_image_blocks");
  }

  return {
    source: input.source,
    sessionId: request.sessionId,
    modelId: input.modelId,
    isMultimodalModel: input.isMultimodalModel,
    contentLength: request.content.length,
    refCount: refs.length,
    pathMapCount: request.pathMap ? Object.keys(request.pathMap).length : 0,
    blockTotals,
    refs: refAudits,
    expectation: {
      expectedImageBlocks,
      expectedOcrText,
      expectationMet: mismatchReasons.length === 0,
      mismatchReasons,
    },
  };
}
