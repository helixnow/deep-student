import type { AnkiGenerationOptions, CustomAnkiTemplate, DocumentAttachment } from '../types';
import { computeSha256Hex } from './hash';

const MAX_ATTACHMENT_BYTES = 50 * 1024;

export interface BuildAnkiTemplateAttachmentParams {
  template: CustomAnkiTemplate;
  prompt: string;
  options: AnkiGenerationOptions;
  customRequirements?: string;
}

export interface BuildAnkiTemplateAttachmentResult {
  attachment: DocumentAttachment;
  trimmed: boolean;
  bytes: number;
}

const encoder = new TextEncoder();

const sanitizeOptions = (options: AnkiGenerationOptions): AnkiGenerationOptions => {
  try {
    return JSON.parse(JSON.stringify(options)) as AnkiGenerationOptions;
  } catch {
    return options;
  }
};

export async function buildAnkiTemplateAttachment(
  params: BuildAnkiTemplateAttachmentParams
): Promise<BuildAnkiTemplateAttachmentResult> {
  const { template, prompt, options, customRequirements } = params;
  const normalizedOptions = sanitizeOptions(options);
  const payload = {
    template_id: template.id,
    template_name: template.name,
    template_version: template.version ?? null,
    prompt,
    options: normalizedOptions,
    custom_requirements: customRequirements?.trim() || undefined,
  };

  const textContent = JSON.stringify(payload, null, 2);
  const bytes = encoder.encode(textContent).length;

  if (bytes <= MAX_ATTACHMENT_BYTES) {
    return {
      attachment: {
        name: `anki_template_${template.id}.json`,
        mime_type: 'application/anki-template+json',
        size_bytes: bytes,
        text_content: textContent,
      },
      trimmed: false,
      bytes,
    };
  }

  const optionsHash = await computeSha256Hex(JSON.stringify(normalizedOptions));
  const trimmedPayload = {
    template_id: template.id,
    template_version: template.version ?? null,
    options_hash: optionsHash,
  };
  const trimmedContent = JSON.stringify(trimmedPayload, null, 2);
  const trimmedBytes = encoder.encode(trimmedContent).length;

  return {
    attachment: {
      name: `anki_template_${template.id}.json`,
      mime_type: 'application/anki-template+json',
      size_bytes: trimmedBytes,
      text_content: trimmedContent,
    },
    trimmed: true,
    bytes: trimmedBytes,
  };
}
