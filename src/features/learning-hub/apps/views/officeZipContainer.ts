/**
 * OOXML / ZIP 容器完整性校验与尾部冗余字节规整。
 *
 * 供 PPTX / XLSX 预览器与 .xmind 解析器共享：
 * - 识别 OLE 复合文档头（D0 CF 11 E0）：密码加密 OOXML 或旧版二进制格式（.ppt / .xls）
 * - 校验 ZIP 局部文件头（PK\x03\x04）与 End-of-Central-Directory（PK\x05\x06）及中央目录范围
 * - 兼容真实下载文件在合法 EOCD 后附带少量尾部换行符/空白或填充字节的场景（如部分 HTTP 下载的 .pptx
 *   末尾多出 1 字节 `\n`），并在返回时裁剪到 EOCD 精确终点，避免下游 ZIP 解析器误报损坏；
 *   同时继续严格拦截真正截断或损坏的文件。
 */

const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const MAX_BENIGN_TRAILING_BYTES = 64;

export type OfficeZipContainerIssue = 'encrypted-or-legacy' | 'truncated' | 'invalid';

export interface OfficeZipInspectionResult {
  issue: OfficeZipContainerIssue | null;
  normalizedBuffer: ArrayBuffer;
}

function isBenignTrailingByte(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;
}

function areAllBenignTrailingBytes(bytes: Uint8Array, start: number): boolean {
  for (let i = start; i < bytes.length; i += 1) {
    if (!isBenignTrailingByte(bytes[i])) return false;
  }
  return true;
}

/**
 * 查找合法且完整的 ZIP 容器结束偏移（含 EOCD + 注释）。
 * 返回 `null` 表示容器被截断或缺少合法中央目录。
 */
export function findCompleteZipEndOffset(bytes: Uint8Array): number | null {
  if (bytes.length < ZIP_EOCD_MIN_BYTES) return null;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(
    0,
    bytes.length - (ZIP_EOCD_MIN_BYTES + ZIP_MAX_COMMENT_BYTES + MAX_BENIGN_TRAILING_BYTES),
  );

  for (let offset = bytes.length - ZIP_EOCD_MIN_BYTES; offset >= minOffset; offset -= 1) {
    if (
      bytes[offset] !== 0x50 ||
      bytes[offset + 1] !== 0x4b ||
      bytes[offset + 2] !== 0x05 ||
      bytes[offset + 3] !== 0x06
    ) {
      continue;
    }

    const commentLength = view.getUint16(offset + 20, true);
    const endOffset = offset + ZIP_EOCD_MIN_BYTES + commentLength;
    if (endOffset > bytes.length) {
      continue;
    }

    const trailingBytes = bytes.length - endOffset;
    if (trailingBytes > MAX_BENIGN_TRAILING_BYTES) {
      continue;
    }

    const cdSize = view.getUint32(offset + 12, true);
    const cdOffset = view.getUint32(offset + 16, true);
    const isZip64 = cdSize === 0xffffffff || cdOffset === 0xffffffff;

    if (isZip64) {
      if (trailingBytes === 0 || areAllBenignTrailingBytes(bytes, endOffset)) {
        return endOffset;
      }
      continue;
    }

    if (cdOffset + cdSize > offset) {
      continue;
    }

    if (
      cdSize > 0 &&
      (bytes[cdOffset] !== 0x50 ||
        bytes[cdOffset + 1] !== 0x4b ||
        bytes[cdOffset + 2] !== 0x01 ||
        bytes[cdOffset + 3] !== 0x02)
    ) {
      continue;
    }

    // 尾部存在额外字节时：允许全空白/NUL 尾随（如 HTTP 下载附加的 \n），
    // 或要求中央目录紧邻 EOCD（cdOffset + cdSize === offset）以排除截断拼接。
    if (trailingBytes > 0 && !areAllBenignTrailingBytes(bytes, endOffset) && cdOffset + cdSize !== offset) {
      continue;
    }

    return endOffset;
  }

  return null;
}

/**
 * 校验 Office OOXML（.pptx / .xlsx）二进制容器并规整尾部冗余字节。
 */
export function inspectOfficeZipContainer(buffer: ArrayBuffer): OfficeZipInspectionResult {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return { issue: 'encrypted-or-legacy', normalizedBuffer: buffer };
  }
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const endOffset = findCompleteZipEndOffset(bytes);
    if (endOffset === null) {
      return { issue: 'truncated', normalizedBuffer: buffer };
    }
    return {
      issue: null,
      normalizedBuffer: endOffset < bytes.length ? buffer.slice(0, endOffset) : buffer,
    };
  }
  return { issue: 'invalid', normalizedBuffer: buffer };
}
