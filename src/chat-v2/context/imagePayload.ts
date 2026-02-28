/**
 * Chat V2 - Image payload parsing helpers
 *
 * VFS image content may contain mixed payload:
 * - raw base64 / data URL image data
 * - trailing OCR xml segment (<image_ocr>...</image_ocr>)
 *
 * This module keeps image decoding paths resilient by separating binary payload
 * from OCR payload before building data URLs.
 */

export interface ParsedImagePayload {
  base64: string;
  mediaType?: string;
  ocrText: string;
}

const OCR_TAG_REGEX = /<image_ocr\b[^>]*>([\s\S]*?)<\/image_ocr>/i;
const DATA_URL_PREFIX = 'data:';
const BASE64_MARKER = ';base64,';

function splitBinaryAndOcr(data: string): { binaryPart: string; ocrText: string } {
  const input = typeof data === 'string' ? data : '';
  const ocrMatch = input.match(OCR_TAG_REGEX);
  const ocrText = ocrMatch?.[1]?.trim() ?? '';

  const ocrTagStart = input.indexOf('<image_ocr');
  const binaryPart = (ocrTagStart >= 0 ? input.slice(0, ocrTagStart) : input).trim();

  return { binaryPart, ocrText };
}

function normalizeBase64(base64: string): string {
  if (!base64) return '';
  return base64.replace(/\s+/g, '');
}

function isLikelyBase64(base64: string): boolean {
  if (!base64) return false;
  const sample = base64.slice(0, 256);
  return /^[A-Za-z0-9+/]+=*$/.test(sample);
}

export function extractImagePayload(data: string): ParsedImagePayload {
  const { binaryPart, ocrText } = splitBinaryAndOcr(data);

  if (!binaryPart) {
    return { base64: '', ocrText };
  }

  if (binaryPart.startsWith(DATA_URL_PREFIX)) {
    const markerIndex = binaryPart.indexOf(BASE64_MARKER);
    if (markerIndex > -1) {
      const mediaType = binaryPart.slice(DATA_URL_PREFIX.length, markerIndex).trim() || undefined;
      const encodedPart = binaryPart.slice(markerIndex + BASE64_MARKER.length);
      const normalized = normalizeBase64(encodedPart);
      if (!isLikelyBase64(normalized)) {
        return { base64: '', mediaType, ocrText };
      }
      return {
        base64: normalized,
        mediaType,
        ocrText,
      };
    }
  }

  const normalized = normalizeBase64(binaryPart);
  if (!isLikelyBase64(normalized)) {
    return {
      base64: '',
      ocrText,
    };
  }

  return {
    base64: normalized,
    ocrText,
  };
}

export function extractImageOcrText(data: string): string {
  return splitBinaryAndOcr(data).ocrText;
}

export function buildImageDataUrl(data: string, fallbackMimeType = 'image/png'): string | null {
  const { base64, mediaType } = extractImagePayload(data);
  if (!base64) return null;
  return `data:${mediaType || fallbackMimeType};base64,${base64}`;
}
