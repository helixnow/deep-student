/**
 * 零外部依赖的 ISO/IEC 18004 标准 QR Code 矩阵编码与高清 SVG 渲染器
 *
 * 支持特性：
 * - UTF-8 Byte mode 字节流编码
 * - 自动选择 Version 1 ~ 40（容量最高支持 2953 字节）
 * - Reed-Solomon GF(256) 纠错码生成与多块交织（支持 L / M 纠错等级）
 * - 完整绘制 Finder、Separator、Alignment、Timing、Dark Module、Format Info、Version Info
 * - 8 种掩码（Mask 0~7）自动评估惩罚分并择优
 * - 支持内联高清 SVG 组件渲染、SVG 字符串导出及配对码元数据提取
 */

import React, { useMemo } from 'react';

export type QrEccLevel = 'L' | 'M';

// ISO/IEC 18004 Table 9 — ECC Codewords Per Block (index 0 unused, 1..40)
const ECC_CODEWORDS_PER_BLOCK: Record<QrEccLevel, readonly number[]> = {
  L: [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
};

// ISO/IEC 18004 Table 9 — Number of Error Correction Blocks (index 0 unused, 1..40)
const NUM_ERROR_CORRECTION_BLOCKS: Record<QrEccLevel, readonly number[]> = {
  L: [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
    8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
};

// Format Info ECC level 2-bit indicators (L = 01, M = 00)
const FORMAT_BITS: Record<QrEccLevel, number> = {
  L: 1,
  M: 0,
};

function getBit(val: number, bitIndex: number): boolean {
  return ((val >>> bitIndex) & 1) !== 0;
}

function appendBits(val: number, len: number, bitBuffer: number[]): void {
  for (let i = len - 1; i >= 0; i--) {
    bitBuffer.push((val >>> i) & 1);
  }
}

function getAlignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step =
    version === 32
      ? 26
      : Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
  const result: number[] = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function getNumRawDataModules(version: number): number {
  const size = version * 4 + 17;
  let result = size * size;
  result -= 8 * 8 * 3; // 3 Finder patterns + separators
  result -= 15 * 2 + 1; // Format info + dark module
  result -= (size - 16) * 2; // Timing patterns
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (numAlign * numAlign - 3) * 25; // Alignment patterns
    result += (numAlign - 2) * 2 * 5; // Overlap between timing & alignment
    if (version >= 7) {
      result -= 6 * 3 * 2; // Version info
    }
  }
  return result;
}

function getNumDataCodewords(version: number, ecc: QrEccLevel): number {
  return (
    Math.floor(getNumRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecc][version]! *
      NUM_ERROR_CORRECTION_BLOCKS[ecc][version]!
  );
}

// GF(256) multiplication with primitive polynomial 0x11D
function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonComputeDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = reedSolomonMultiply(result[j]!, root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1]!;
      }
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(
  data: Uint8Array,
  divisor: Uint8Array,
): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ result[0]!;
    result.copyWithin(0, 1);
    result[divisor.length - 1] = 0;
    for (let j = 0; j < divisor.length; j++) {
      result[j] ^= reedSolomonMultiply(divisor[j]!, factor);
    }
  }
  return result;
}

function addEccAndInterleave(
  data: Uint8Array,
  version: number,
  ecc: QrEccLevel,
): Uint8Array {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version]!;
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: Uint8Array[] = [];
  const rsDiv = reedSolomonComputeDivisor(blockEccLen);

  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.subarray(k, k + datLen);
    k += datLen;
    const eccBytes = reedSolomonComputeRemainder(dat, rsDiv);
    const block = new Uint8Array(shortBlockLen + 1);
    block.set(dat, 0);
    block.set(eccBytes, shortBlockLen - blockEccLen + 1);
    blocks.push(block);
  }

  const result = new Uint8Array(rawCodewords);
  for (let i = 0, k = 0; i < blocks[0]!.length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result[k] = blocks[j]![i]!;
        k++;
      }
    }
  }
  return result;
}

function computePenaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let result = 0;

  // Rule 1: Adjacent modules in row/column with same color
  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runX = 0;
    for (let x = 0; x < size; x++) {
      if (x === 0 || modules[y]![x] !== runColor) {
        runColor = modules[y]![x]!;
        runX = 1;
      } else {
        runX++;
        if (runX === 5) result += 3;
        else if (runX > 5) result += 1;
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runY = 0;
    for (let y = 0; y < size; y++) {
      if (y === 0 || modules[y]![x] !== runColor) {
        runColor = modules[y]![x]!;
        runY = 1;
      } else {
        runY++;
        if (runY === 5) result += 3;
        else if (runY > 5) result += 1;
      }
    }
  }

  // Rule 2: 2x2 blocks of same color
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y]![x]!;
      if (
        color === modules[y]![x + 1] &&
        color === modules[y + 1]![x] &&
        color === modules[y + 1]![x + 1]
      ) {
        result += 3;
      }
    }
  }

  // Rule 3 & 4: Dark balance
  let dark = 0;
  for (const row of modules) {
    for (const cell of row) {
      if (cell) dark++;
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(0, k) * 10;

  return result;
}

/**
 * 将任意 UTF-8 字符串编码为标准 QR Code 布尔矩阵（true 表示深色模块）
 */
export function encodeQrCodeMatrix(
  text: string,
  eccLevel: QrEccLevel = 'L',
): boolean[][] {
  const bytes = new TextEncoder().encode(text);

  // Pick minimal version 1..40 that fits byte mode payload
  let version = 1;
  for (; version <= 40; version++) {
    const countBits = version <= 9 ? 8 : 16;
    const capacityBits = getNumDataCodewords(version, eccLevel) * 8;
    if (4 + countBits + bytes.length * 8 <= capacityBits) {
      break;
    }
  }
  if (version > 40) {
    throw new Error('数据超出标准二维码最大容量（Version 40）');
  }

  const bitBuffer: number[] = [];
  // Byte mode indicator = 0100 (4)
  appendBits(0b0100, 4, bitBuffer);
  appendBits(bytes.length, version <= 9 ? 8 : 16, bitBuffer);
  for (let i = 0; i < bytes.length; i++) {
    appendBits(bytes[i]!, 8, bitBuffer);
  }

  const dataCapacityBits = getNumDataCodewords(version, eccLevel) * 8;
  appendBits(0, Math.min(4, dataCapacityBits - bitBuffer.length), bitBuffer);
  appendBits(0, (8 - (bitBuffer.length % 8)) % 8, bitBuffer);

  for (
    let padByte = 0xec;
    bitBuffer.length < dataCapacityBits;
    padByte ^= 0xec ^ 0x11
  ) {
    appendBits(padByte, 8, bitBuffer);
  }

  const dataCodewords = new Uint8Array(bitBuffer.length / 8);
  for (let i = 0; i < bitBuffer.length; i++) {
    dataCodewords[i >>> 3] |= bitBuffer[i]! << (7 - (i & 7));
  }

  const allCodewords = addEccAndInterleave(dataCodewords, version, eccLevel);

  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false),
  );
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false),
  );

  const setFunctionModule = (x: number, y: number, isDark: boolean) => {
    modules[y]![x] = isDark;
    isFunction[y]![x] = true;
  };

  // Timing patterns
  for (let i = 0; i < size; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // 3 Finder patterns + separators
  const drawFinderPattern = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
          setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  };
  drawFinderPattern(3, 3);
  drawFinderPattern(size - 4, 3);
  drawFinderPattern(3, size - 4);

  // Alignment patterns
  const alignPos = getAlignmentPatternPositions(version);
  const numAlign = alignPos.length;
  for (let i = 0; i < numAlign; i++) {
    for (let j = 0; j < numAlign; j++) {
      if (
        !(
          (i === 0 && j === 0) ||
          (i === 0 && j === numAlign - 1) ||
          (i === numAlign - 1 && j === 0)
        )
      ) {
        const cx = alignPos[i]!;
        const cy = alignPos[j]!;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFunctionModule(
              cx + dx,
              cy + dy,
              Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
            );
          }
        }
      }
    }
  }

  // Reserve Format Info & Dark Module
  const drawFormatBits = (mask: number) => {
    const data = (FORMAT_BITS[eccLevel] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getBit(bits, i));
    setFunctionModule(8, 7, getBit(bits, 6));
    setFunctionModule(8, 8, getBit(bits, 7));
    setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++)
      setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++)
      setFunctionModule(8, size - 15 + i, getBit(bits, i));
    setFunctionModule(8, size - 8, true); // Dark module
  };

  drawFormatBits(0);

  // Version Info (Version >= 7)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, color);
      setFunctionModule(b, a, color);
    }
  }

  // Draw data & ECC codewords in zigzag scan
  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && bitIdx < allCodewords.length * 8) {
          modules[y]![x] = getBit(
            allCodewords[bitIdx >>> 3]!,
            7 - (bitIdx & 7),
          );
          bitIdx++;
        }
      }
    }
  }

  // Evaluate 8 masks and pick lowest penalty
  const applyMask = (mask: number, target: boolean[][]) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunction[y]![x]) continue;
        let invert = false;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          case 7:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
        }
        if (invert) target[y]![x] = !target[y]![x];
      }
    }
  };

  let bestMask = 0;
  let minPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m, modules);
    drawFormatBits(m);
    const penalty = computePenaltyScore(modules);
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMask = m;
    }
    applyMask(m, modules); // undo mask
  }

  applyMask(bestMask, modules);
  drawFormatBits(bestMask);

  return modules;
}

/**
 * 构建 SVG path 字符串（合并同行连续暗块以减小 DOM 体积）
 */
export function buildQrSvgPath(matrix: boolean[][], margin = 4): {
  viewBoxSize: number;
  pathData: string;
} {
  const size = matrix.length;
  const viewBoxSize = size + margin * 2;
  const segments: string[] = [];

  for (let y = 0; y < size; y++) {
    const row = matrix[y]!;
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && row[x + run]) {
        run++;
      }
      segments.push(`M${x + margin} ${y + margin}h${run}v1h-${run}z`);
      x += run;
    }
  }

  return {
    viewBoxSize,
    pathData: segments.join(''),
  };
}

/**
 * 生成独立的 SVG 文件字符串（内嵌元信息，方便离线文件导入识别）
 */
export function renderQrCodeSvgString(
  text: string,
  options?: { size?: number; margin?: number; eccLevel?: QrEccLevel },
): string {
  const pixelSize = options?.size ?? 320;
  const margin = options?.margin ?? 4;
  const matrix = encodeQrCodeMatrix(text, options?.eccLevel ?? 'L');
  const { viewBoxSize, pathData } = buildQrSvgPath(matrix, margin);
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" data-pairing-code="${escaped}">`,
    `<desc>${escaped}</desc>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<path d="${pathData}" fill="#0f172a"/>`,
    `</svg>`,
  ].join('');
}

/**
 * 从 SVG 源码或包含配对码的文本中提取 DSPAIR1: 载荷
 */
export function extractPairingCodeFromText(raw: string): string | null {
  if (!raw) return null;
  const match = raw.match(/DSPAIR1:[A-Za-z0-9_+=-]+/);
  return match ? match[0] : null;
}

export { encodeQrCodeMatrix as encodeQrMatrix };

export interface QrCodeSvgProps {
  value: string;
  size?: number;
  margin?: number;
  eccLevel?: QrEccLevel;
  className?: string;
  ariaLabel?: string;
  label?: string;
}

export const QrCodeSvg: React.FC<QrCodeSvgProps> = ({
  value,
  size = 208,
  margin = 3,
  eccLevel = 'L',
  className,
  ariaLabel,
  label,
}) => {
  const encoded = useMemo(() => {
    const matrix = encodeQrCodeMatrix(value, eccLevel);
    return buildQrSvgPath(matrix, margin);
  }, [value, margin, eccLevel]);

  return React.createElement(
    'svg',
    {
      role: 'img',
      'aria-label': label ?? ariaLabel ?? '同步配对二维码',
      viewBox: `0 0 ${encoded.viewBoxSize} ${encoded.viewBoxSize}`,
      width: size,
      height: size,
      shapeRendering: 'crispEdges',
      className,
      'data-testid': 'device-pairing-qr-svg',
      'data-pairing-code': value,
    },
    React.createElement('desc', null, value),
    React.createElement('rect', {
      width: '100%',
      height: '100%',
      fill: '#ffffff',
      rx: 1.5,
    }),
    React.createElement('path', {
      d: encoded.pathData,
      fill: '#0f172a',
    }),
  );
};
