import { describe, expect, it } from "vitest";
import type { SendMessageRequest } from "../../../src/chat-v2/adapters/types";
import { buildAttachmentRequestAudit } from "../../../src/chat-v2/debug/attachmentRequestAudit";

describe("buildAttachmentRequestAudit", () => {
  it("marks multimodal request as matched when pdf/image mode results in image blocks", () => {
    const request: SendMessageRequest = {
      sessionId: "sess_1",
      content: "请分析附件",
      options: { modelId: "model-vlm" },
      userContextRefs: [
        {
          resourceId: "res_pdf",
          hash: "h1",
          typeId: "file",
          injectModes: { pdf: ["image", "ocr"] },
          formattedBlocks: [
            { type: "text", text: "OCR text" },
            { type: "image", mediaType: "image/png", base64: "abc" },
          ],
        },
      ],
    };

    const audit = buildAttachmentRequestAudit(request, {
      source: "frontend",
      modelId: "model-vlm",
      isMultimodalModel: true,
    });

    expect(audit.refCount).toBe(1);
    expect(audit.blockTotals.image).toBe(1);
    expect(audit.expectation.expectedImageBlocks).toBe(true);
    expect(audit.expectation.expectationMet).toBe(true);
  });

  it("marks text model request as mismatch when image mode selected but no image blocks", () => {
    const request: SendMessageRequest = {
      sessionId: "sess_2",
      content: "分析这张图",
      options: { modelId: "model-text" },
      userContextRefs: [
        {
          resourceId: "res_img",
          hash: "h2",
          typeId: "image",
          injectModes: { image: ["image"] },
          formattedBlocks: [{ type: "text", text: "fallback OCR" }],
        },
      ],
    };

    const audit = buildAttachmentRequestAudit(request, {
      source: "backend",
      modelId: "model-text",
      isMultimodalModel: false,
    });

    expect(audit.blockTotals.image).toBe(0);
    expect(audit.expectation.expectedImageBlocks).toBe(false);
    expect(audit.expectation.expectationMet).toBe(true);
  });
});
