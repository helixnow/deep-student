/**
 * QR Code encoder (iLink / Bilibili login flows). Desktop-only submodule of `platform/util`:
 * the PNG writer uses `node:zlib` and `Buffer`.
 *
 * Rust delegates this to `qrcode` 0.13 + `image` (dstu-util/src/qr.rs:11): `QrCode::new`
 * selects the smallest normal version, error correction level M, the crate's optimal
 * segmentation (`optimize.rs`) and the lowest-penalty mask (`canvas.rs::apply_best_mask`).
 * This module ports those defaults rather than emitting a fixed-mask approximation, and
 * renders the same ≥256px 8-bit grayscale PNG with a 4-module quiet zone.
 */
import { deflateSync } from 'node:zlib';
import { AppError } from '../../kernel/error-model.ts';

// qrcode 0.13.0 tables (ISO/IEC 18004:2006 §6.5.1 Table 9), error correction level M.
const ECC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS_M = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const DATA_CODEWORDS_M = [16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334, 365, 415, 453, 507, 563, 627, 669, 714, 782, 860, 914, 1000, 1062, 1128, 1193, 1267, 1373, 1455, 1541, 1631, 1725, 1812, 1914, 1992, 2102, 2216, 2334];
/** qrcode 0.13.0 `ec.rs::DATA_LENGTHS` M column, in bits. */
const DATA_LENGTHS_M = DATA_CODEWORDS_M.map((codewords) => codewords * 8);
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];
/** BCH(18, 6) version information; qrcode 0.13.0 `canvas.rs::VERSION_INFOS` (v7+). */
const VERSION_INFO = Array.from({ length: 40 }, (_, index) => {
  const version = index + 1;
  if (version < 7) return 0;
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25);
  return (version << 12) | (remainder & 0xfff);
});
/** qrcode 0.13.0 `canvas.rs::FORMAT_INFOS_QR` for EcLevel::M, indexed by mask pattern. */
const FORMAT_INFOS_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0] as const;

function qrError(message: string): AppError {
  return AppError.validation(`生成二维码失败: ${message}`);
}

// ------------------------------------------------------------------ optimal segmentation

type QrMode = 'numeric' | 'alphanumeric' | 'byte' | 'kanji';

interface QrSegment {
  readonly mode: QrMode;
  readonly begin: number;
  readonly end: number;
}

/** qrcode 0.13.0 `types.rs::Mode::length_bits_count` for normal versions. */
function modeLengthBits(mode: QrMode, version: number): number {
  if (version <= 9) return mode === 'numeric' ? 10 : mode === 'alphanumeric' ? 9 : 8;
  if (version <= 26) return mode === 'numeric' ? 12 : mode === 'alphanumeric' ? 11 : mode === 'byte' ? 16 : 10;
  return mode === 'numeric' ? 14 : mode === 'alphanumeric' ? 13 : mode === 'byte' ? 16 : 12;
}

/** qrcode 0.13.0 `types.rs::Mode::data_bits_count`. */
function modeDataBits(mode: QrMode, count: number): number {
  switch (mode) {
    case 'numeric': return Math.floor((count * 10 + 2) / 3);
    case 'alphanumeric': return Math.floor((count * 11 + 1) / 2);
    case 'byte': return count * 8;
    case 'kanji': return count * 13;
  }
}

function segmentChars(segment: QrSegment): number {
  const bytes = segment.end - segment.begin;
  return segment.mode === 'kanji' ? Math.floor(bytes / 2) : bytes;
}

/** qrcode 0.13.0 `optimize.rs::Segment::encoded_len`. */
function segmentBits(segment: QrSegment, version: number): number {
  return 4 + modeLengthBits(segment.mode, version) + modeDataBits(segment.mode, segmentChars(segment));
}

/** qrcode 0.13.0 `types.rs::Mode::max`; incompatible pairs widen to Byte. */
function modeMax(left: QrMode, right: QrMode): QrMode {
  if (left === right) return left;
  if (left === 'numeric' && right === 'alphanumeric') return 'alphanumeric';
  if (right === 'byte') return 'byte';
  if (left === 'alphanumeric' && right === 'numeric') return 'alphanumeric';
  if (left === 'byte') return 'byte';
  return 'byte';
}

// qrcode 0.13.0 `optimize.rs` exclusive character sets and parser states.
const ECS_END = 0;
const ECS_SYMBOL = 1;
const ECS_NUMERIC = 2;
const ECS_ALPHA = 3;
const ECS_KANJI_HI1 = 4;
const ECS_KANJI_HI2 = 5;
const ECS_KANJI_HI3 = 6;
const ECS_KANJI_LO1 = 7;
const ECS_KANJI_LO2 = 8;
const ECS_BYTE = 9;

const STATE_INIT = 0;
const STATE_NUMERIC = 10;
const STATE_ALPHA = 20;
const STATE_BYTE = 30;
const STATE_KANJI_HI12 = 40;
const STATE_KANJI_HI3 = 50;
const STATE_KANJI = 60;

const ACTION_IDLE = 0;
const ACTION_NUMERIC = 1;
const ACTION_ALPHA = 2;
const ACTION_BYTE = 3;
const ACTION_KANJI = 4;
const ACTION_KANJI_AND_SINGLE_BYTE = 5;

type Transition = readonly [nextState: number, action: number];
/** qrcode 0.13.0 `optimize.rs::STATE_TRANSITION`, indexed by state / 10 then character class. */
const STATE_TRANSITION: readonly (readonly Transition[])[] = [
  // Init state.
  [[STATE_INIT, ACTION_IDLE], [STATE_ALPHA, ACTION_IDLE], [STATE_NUMERIC, ACTION_IDLE], [STATE_ALPHA, ACTION_IDLE], [STATE_KANJI_HI12, ACTION_IDLE], [STATE_KANJI_HI12, ACTION_IDLE], [STATE_KANJI_HI3, ACTION_IDLE], [STATE_BYTE, ACTION_IDLE], [STATE_BYTE, ACTION_IDLE], [STATE_BYTE, ACTION_IDLE]],
  // Numeric state.
  [[STATE_INIT, ACTION_NUMERIC], [STATE_ALPHA, ACTION_NUMERIC], [STATE_NUMERIC, ACTION_IDLE], [STATE_ALPHA, ACTION_NUMERIC], [STATE_KANJI_HI12, ACTION_NUMERIC], [STATE_KANJI_HI12, ACTION_NUMERIC], [STATE_KANJI_HI3, ACTION_NUMERIC], [STATE_BYTE, ACTION_NUMERIC], [STATE_BYTE, ACTION_NUMERIC], [STATE_BYTE, ACTION_NUMERIC]],
  // Alpha state.
  [[STATE_INIT, ACTION_ALPHA], [STATE_ALPHA, ACTION_IDLE], [STATE_NUMERIC, ACTION_ALPHA], [STATE_ALPHA, ACTION_IDLE], [STATE_KANJI_HI12, ACTION_ALPHA], [STATE_KANJI_HI12, ACTION_ALPHA], [STATE_KANJI_HI3, ACTION_ALPHA], [STATE_BYTE, ACTION_ALPHA], [STATE_BYTE, ACTION_ALPHA], [STATE_BYTE, ACTION_ALPHA]],
  // Byte state.
  [[STATE_INIT, ACTION_BYTE], [STATE_ALPHA, ACTION_BYTE], [STATE_NUMERIC, ACTION_BYTE], [STATE_ALPHA, ACTION_BYTE], [STATE_KANJI_HI12, ACTION_BYTE], [STATE_KANJI_HI12, ACTION_BYTE], [STATE_KANJI_HI3, ACTION_BYTE], [STATE_BYTE, ACTION_IDLE], [STATE_BYTE, ACTION_IDLE], [STATE_BYTE, ACTION_IDLE]],
  // KanjiHi12 state.
  [[STATE_INIT, ACTION_KANJI_AND_SINGLE_BYTE], [STATE_ALPHA, ACTION_KANJI_AND_SINGLE_BYTE], [STATE_NUMERIC, ACTION_KANJI_AND_SINGLE_BYTE], [STATE_KANJI, ACTION_IDLE], [STATE_KANJI, ACTION_IDLE], [STATE_KANJI, ACTION_IDLE], [STATE_KANJI, ACTION_IDLE], [STATE_KANJI, ACTION_IDLE], [STATE_KANJI, ACTION_IDLE], [STATE_BYTE, ACTION_KANJI_AND_SINGLE_BYTE]],
  // KanjiHi3 state.
  [[STATE_INIT, ACTION_KANJI_AND_SINGLE_BYTE], [STATE_ALPHA, ACTION_KANJI_AND_SINGLE_BYTE], [STATE_NUMERIC, ACTION_KANJI_AND_SINGLE_BYTE], [STATE_KANJI, ACTION_IDLE], [STATE_KANJI, ACTION_IDLE], [STATE_KANJI_HI12, ACTION_KANJI_AND_SINGLE_BYTE], [STATE_KANJI_HI3, ACTION_KANJI_AND_SINGLE_BYTE], [STATE_KANJI, ACTION_IDLE], [STATE_BYTE, ACTION_KANJI_AND_SINGLE_BYTE], [STATE_BYTE, ACTION_KANJI_AND_SINGLE_BYTE]],
  // Kanji state.
  [[STATE_INIT, ACTION_KANJI], [STATE_ALPHA, ACTION_KANJI], [STATE_NUMERIC, ACTION_KANJI], [STATE_ALPHA, ACTION_KANJI], [STATE_KANJI_HI12, ACTION_IDLE], [STATE_KANJI_HI12, ACTION_IDLE], [STATE_KANJI_HI3, ACTION_IDLE], [STATE_BYTE, ACTION_KANJI], [STATE_BYTE, ACTION_KANJI], [STATE_BYTE, ACTION_KANJI]],
];

/** qrcode 0.13.0 `optimize.rs::ExclCharSet::from_u8`. */
function exclCharSet(byte: number): number {
  if (byte === 0x20 || byte === 0x24 || byte === 0x25 || byte === 0x2a || byte === 0x2b || (byte >= 0x2d && byte <= 0x2f) || byte === 0x3a) return ECS_SYMBOL;
  if (byte >= 0x30 && byte <= 0x39) return ECS_NUMERIC;
  if (byte >= 0x41 && byte <= 0x5a) return ECS_ALPHA;
  if (byte >= 0x81 && byte <= 0x9f) return ECS_KANJI_HI1;
  if (byte >= 0xe0 && byte <= 0xea) return ECS_KANJI_HI2;
  if (byte === 0xeb) return ECS_KANJI_HI3;
  if (byte === 0x40 || (byte >= 0x5b && byte <= 0x7e) || byte === 0x80 || (byte >= 0xa0 && byte <= 0xbf)) return ECS_KANJI_LO1;
  if ((byte >= 0xc0 && byte <= 0xdf) || (byte >= 0xec && byte <= 0xfc)) return ECS_KANJI_LO2;
  return ECS_BYTE;
}

interface ParserState {
  state: number;
  begin: number;
  pendingSingleByte: boolean;
  index: number;
  ended: boolean;
}

/** qrcode 0.13.0 `optimize.rs::Parser::next`. */
function nextSegment(data: Uint8Array, parser: ParserState): QrSegment | null {
  if (parser.pendingSingleByte) {
    parser.pendingSingleByte = false;
    parser.begin += 1;
    return { mode: 'byte', begin: parser.begin - 1, end: parser.begin };
  }
  for (;;) {
    if (parser.ended) return null;
    let index: number;
    let ecs: number;
    if (parser.index < data.length) {
      index = parser.index;
      ecs = exclCharSet(data[parser.index]!);
      parser.index += 1;
    } else {
      index = parser.index;
      ecs = ECS_END;
      parser.ended = true;
    }
    const [nextState, action] = STATE_TRANSITION[parser.state / 10]![ecs]!;
    parser.state = nextState;
    const oldBegin = parser.begin;
    switch (action) {
      case ACTION_IDLE:
        continue;
      case ACTION_NUMERIC:
        parser.begin = index;
        return { mode: 'numeric', begin: oldBegin, end: index };
      case ACTION_ALPHA:
        parser.begin = index;
        return { mode: 'alphanumeric', begin: oldBegin, end: index };
      case ACTION_BYTE:
        parser.begin = index;
        return { mode: 'byte', begin: oldBegin, end: index };
      case ACTION_KANJI:
        parser.begin = index;
        return { mode: 'kanji', begin: oldBegin, end: index };
      case ACTION_KANJI_AND_SINGLE_BYTE: {
        const nextBegin = index - 1;
        if (parser.begin === nextBegin) {
          parser.begin = index;
          return { mode: 'byte', begin: oldBegin, end: index };
        }
        parser.pendingSingleByte = true;
        parser.begin = nextBegin;
        return { mode: 'kanji', begin: oldBegin, end: nextBegin };
      }
      default:
        throw new Error(`unreachable parser action ${action}`);
    }
  }
}

function parseSegments(data: Uint8Array): QrSegment[] {
  const parser: ParserState = { state: STATE_INIT, begin: 0, pendingSingleByte: false, index: 0, ended: false };
  const segments: QrSegment[] = [];
  for (let segment = nextSegment(data, parser); segment !== null; segment = nextSegment(data, parser)) segments.push(segment);
  return segments;
}

/** qrcode 0.13.0 `optimize.rs::Optimizer`: greedy left-to-right merging. */
function optimizeSegments(segments: readonly QrSegment[], version: number): QrSegment[] {
  if (segments.length === 0) return [];
  const out: QrSegment[] = [];
  let last = segments[0]!;
  let lastSize = segmentBits(last, version);
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i]!;
    const segmentSize = segmentBits(segment, version);
    const merged: QrSegment = { mode: modeMax(last.mode, segment.mode), begin: last.begin, end: segment.end };
    const mergedSize = segmentBits(merged, version);
    if (lastSize + segmentSize >= mergedSize) {
      last = merged;
      lastSize = mergedSize;
    } else {
      out.push(last);
      last = segment;
      lastSize = segmentSize;
    }
  }
  out.push(last);
  return out;
}

/** qrcode 0.13.0 `bits.rs::find_min_version`. */
function findMinVersion(length: number): number {
  let base = 0;
  let size = 39;
  while (size > 1) {
    const half = Math.floor(size / 2);
    const mid = base + half;
    base = DATA_LENGTHS_M[mid]! > length ? base : mid;
    size -= half;
  }
  base = DATA_LENGTHS_M[base]! >= length ? base : base + 1;
  if (base >= 40) throw qrError('data too long');
  return base + 1;
}

// ------------------------------------------------------------------ bit stream

class BitWriter {
  private readonly bits: number[] = [];

  get length(): number {
    return this.bits.length;
  }

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  /** qrcode 0.13.0 `bits.rs::push_number_checked`. */
  pushChecked(value: number, length: number): void {
    if (length > 16 || value >= 2 ** length) throw qrError('data too long');
    this.push(value, length);
  }

  /** qrcode 0.13.0 `bits.rs::push_terminator` for normal versions. */
  finish(version: number): Uint8Array {
    const dataLength = DATA_LENGTHS_M[version - 1]!;
    if (this.bits.length > dataLength) throw qrError('data too long');
    const terminator = Math.min(4, dataLength - this.bits.length);
    if (terminator > 0) this.push(0, terminator);
    while (this.bits.length % 8 !== 0) this.push(0, 1); // qrcode sets bit_offset = 0 before padding.
    const dataBytes = dataLength / 8;
    let pad = 0xec;
    while (this.bits.length / 8 < dataBytes) {
      this.push(pad, 8);
      pad ^= 0xec ^ 0x11;
    }
    return this.toBytes();
  }

  private toBytes(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i] === 1) bytes[i >>> 3] = bytes[i >>> 3]! | (0x80 >>> (i & 7));
    }
    return bytes;
  }
}

const ALPHANUMERIC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** qrcode 0.13.0 `bits.rs::push_segments` for an already optimized segment list. */
function pushSegment(bits: BitWriter, data: Uint8Array, segment: QrSegment, version: number): void {
  const slice = data.subarray(segment.begin, segment.end);
  const lengthBits = modeLengthBits(segment.mode, version);
  switch (segment.mode) {
    case 'numeric': {
      bits.pushChecked(0b0001, 4);
      bits.pushChecked(slice.length, lengthBits);
      for (let i = 0; i < slice.length; i += 3) {
        const chunk = slice.subarray(i, i + 3);
        let value = 0;
        for (const byte of chunk) value = value * 10 + (byte - 0x30);
        bits.push(value, chunk.length * 3 + 1);
      }
      return;
    }
    case 'alphanumeric': {
      bits.pushChecked(0b0010, 4);
      bits.pushChecked(slice.length, lengthBits);
      for (let i = 0; i < slice.length; i += 2) {
        const chunk = slice.subarray(i, i + 2);
        let value = 0;
        for (const byte of chunk) {
          const digit = ALPHANUMERIC_CHARS.indexOf(String.fromCharCode(byte));
          if (digit < 0) throw qrError('invalid character');
          value = value * 45 + digit;
        }
        bits.push(value, chunk.length * 5 + 1);
      }
      return;
    }
    case 'byte': {
      bits.pushChecked(0b0100, 4);
      bits.pushChecked(slice.length, lengthBits);
      for (const byte of slice) bits.push(byte, 8);
      return;
    }
    case 'kanji': {
      bits.pushChecked(0b1000, 4);
      bits.pushChecked(Math.floor(slice.length / 2), lengthBits);
      for (let i = 0; i < slice.length; i += 2) {
        if (i + 1 >= slice.length) throw qrError('invalid character');
        const code = slice[i]! * 0x100 + slice[i + 1]!;
        const adjusted = code < 0xe040 ? code - 0x8140 : code - 0xc140;
        bits.push((adjusted >>> 8) * 0xc0 + (adjusted & 0xff), 13);
      }
      return;
    }
  }
}

interface EncodedQr {
  readonly version: number;
  readonly data: Uint8Array;
}

/** qrcode 0.13.0 `bits.rs::encode_auto` at EcLevel::M. */
function encodeOptimal(data: Uint8Array): EncodedQr {
  const parsed = parseSegments(data);
  for (const probe of [9, 26, 40]) {
    const segments = optimizeSegments(parsed, probe);
    const total = segments.reduce((sum, segment) => sum + segmentBits(segment, probe), 0);
    if (total > DATA_LENGTHS_M[probe - 1]!) continue;
    const version = findMinVersion(total);
    const bits = new BitWriter();
    for (const segment of segments) pushSegment(bits, data, segment, version);
    return { version, data: bits.finish(version) };
  }
  throw qrError('data too long');
}

// ------------------------------------------------------------------ GF(256)

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function reedSolomonGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, root);
    }
    poly = next;
  }
  return poly;
}

function reedSolomonRemainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const degree = generator.length - 1;
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i++) remainder[i] = remainder[i]! ^ gfMul(generator[i + 1]!, factor);
  }
  return remainder;
}

/** qrcode 0.13.0 `ec.rs::construct_codewords`: split blocks, add ECC, interleave both halves. */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const blockCount = BLOCKS_M[version - 1]!;
  const eccPerBlock = ECC_PER_BLOCK_M[version - 1]!;
  const totalData = DATA_CODEWORDS_M[version - 1]!;
  const shortLength = Math.floor(totalData / blockCount);
  const longBlocks = totalData % blockCount;
  const shortBlocks = blockCount - longBlocks;

  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let block = 0; block < blockCount; block++) {
    const length = shortLength + (block >= shortBlocks ? 1 : 0);
    const chunk = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(chunk);
    eccBlocks.push(reedSolomonRemainder(chunk, reedSolomonGenerator(eccPerBlock)));
  }

  const out: number[] = [];
  for (let i = 0; i <= shortLength; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < eccPerBlock; i++) for (const block of eccBlocks) out.push(block[i]!);
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------ matrix

interface Matrix {
  size: number;
  modules: Int8Array;
  functionModules: Uint8Array;
}

function newMatrix(size: number): Matrix {
  return { size, modules: new Int8Array(size * size).fill(-1), functionModules: new Uint8Array(size * size) };
}

function cloneMatrix(matrix: Matrix): Matrix {
  return { size: matrix.size, modules: matrix.modules.slice(), functionModules: matrix.functionModules.slice() };
}

function setFunction(matrix: Matrix, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) return;
  const at = y * matrix.size + x;
  matrix.modules[at] = dark ? 1 : 0;
  matrix.functionModules[at] = 1;
}

function drawFinder(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue;
      const dark =
        (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
        (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6)) ||
        (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      setFunction(matrix, x, y, dark);
    }
  }
}

function drawAlignment(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunction(matrix, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawVersion(matrix: Matrix, version: number): void {
  if (version < 7) return;
  const bits = VERSION_INFO[version - 1]!;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) === 1;
    const a = matrix.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(matrix, a, b, bit);
    setFunction(matrix, b, a, bit);
  }
}

function drawFunctionPatterns(matrix: Matrix, version: number): void {
  const size = matrix.size;
  for (let i = 0; i < size; i++) {
    setFunction(matrix, 6, i, i % 2 === 0);
    setFunction(matrix, i, 6, i % 2 === 0);
  }
  drawFinder(matrix, 0, 0);
  drawFinder(matrix, size - 7, 0);
  drawFinder(matrix, 0, size - 7);

  const centers = ALIGNMENT[version - 1]!;
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)) continue;
      drawAlignment(matrix, cx, cy);
    }
  }

  // Reserve format areas (real bits are written after the mask is chosen).
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunction(matrix, 8, i, false);
      setFunction(matrix, i, 8, false);
    }
  }
  setFunction(matrix, 8, 8, false);
  for (let i = 0; i < 8; i++) setFunction(matrix, size - 1 - i, 8, false);
  for (let i = 0; i < 7; i++) setFunction(matrix, 8, size - 1 - i, false);
  setFunction(matrix, 8, size - 8, true);
  drawVersion(matrix, version);
}

/** qrcode 0.13.0 `canvas.rs::DataModuleIter` + `draw_codewords`, without masking. */
function placeData(matrix: Matrix, codewords: Uint8Array): void {
  const size = matrix.size;
  const bits: number[] = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  let index = 0;
  let row = size - 1;
  let column = size - 1;
  let direction = -1;
  while (column > 0) {
    if (column === 6) column--;
    while (row >= 0 && row < size) {
      for (let c = 0; c < 2; c++) {
        const x = column - c;
        const at = row * size + x;
        if (matrix.functionModules[at] === 1) continue;
        matrix.modules[at] = index < bits.length ? bits[index++]! : 0;
      }
      row += direction;
    }
    row -= direction;
    direction = -direction;
    column -= 2;
  }
}

// qrcode 0.13.0 `canvas.rs::mask_functions`, indexed by mask pattern number.
const MASK_FUNCTIONS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** qrcode 0.13.0 `canvas.rs::Canvas::apply_mask`: only data modules are inverted. */
function applyMask(matrix: Matrix, mask: number): void {
  const fn = MASK_FUNCTIONS[mask]!;
  const size = matrix.size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = y * size + x;
      if (matrix.functionModules[at] === 1) continue;
      if (fn(x, y)) matrix.modules[at] = matrix.modules[at] === 1 ? 0 : 1;
    }
  }
}

/** qrcode 0.13.0 `canvas.rs::draw_format_info_patterns` for normal QR + EcLevel::M. */
function drawFormat(matrix: Matrix, mask: number): void {
  const bits = FORMAT_INFOS_M[mask]!;
  const get = (i: number) => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFunction(matrix, 8, i, get(i));
  setFunction(matrix, 8, 7, get(6));
  setFunction(matrix, 8, 8, get(7));
  setFunction(matrix, 7, 8, get(8));
  for (let i = 9; i < 15; i++) setFunction(matrix, 14 - i, 8, get(i));
  for (let i = 0; i < 8; i++) setFunction(matrix, matrix.size - 1 - i, 8, get(i));
  for (let i = 8; i < 15; i++) setFunction(matrix, 8, matrix.size - 15 + i, get(i));
  setFunction(matrix, 8, matrix.size - 8, true);
}

// ------------------------------------------------------------------ mask penalty (qrcode 0.13.0 canvas.rs)

function adjacentPenalty(modules: Int8Array, size: number, horizontal: boolean): number {
  let total = 0;
  for (let i = 0; i < size; i++) {
    let last: boolean | null = null;
    let run = 1;
    for (let j = 0; j <= size; j++) {
      const color = j < size ? (horizontal ? modules[i * size + j] === 1 : modules[j * size + i] === 1) : null;
      if (color === last) {
        run += 1;
      } else {
        last = color;
        if (run >= 5) total += run - 2;
        run = 1;
      }
    }
  }
  return total;
}

function blockPenalty(modules: Int8Array, size: number): number {
  let total = 0;
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const at = y * size + x;
      const value = modules[at];
      if (modules[at + 1] === value && modules[at + size] === value && modules[at + size + 1] === value) total += 3;
    }
  }
  return total;
}

const FINDER_LIKE_PATTERN = [true, false, true, true, true, false, true] as const;

function finderPenalty(modules: Int8Array, size: number, horizontal: boolean): number {
  let total = 0;
  for (let line = 0; line < size; line++) {
    const get = (position: number) => (horizontal ? modules[line * size + position] === 1 : modules[position * size + line] === 1);
    for (let start = 0; start <= size - 7; start++) {
      let matches = true;
      for (let k = 0; k < 7; k++) {
        if (get(start + k) !== FINDER_LIKE_PATTERN[k]) { matches = false; break; }
      }
      if (!matches) continue;
      const hasDark = (from: number, to: number): boolean => {
        for (let k = from; k < to; k++) {
          if (k >= 0 && k < size && get(k)) return true;
        }
        return false;
      };
      if (!hasDark(start - 4, start) || !hasDark(start + 7, start + 11)) total += 40;
    }
  }
  return total - 360;
}

function balancePenalty(modules: Int8Array): number {
  let dark = 0;
  for (const module of modules) if (module === 1) dark += 1;
  const ratio = Math.trunc((dark * 200) / modules.length);
  return Math.abs(ratio - 100);
}

/** qrcode 0.13.0 `canvas.rs::compute_total_penalty_scores` for normal QR codes. */
function totalPenalty(matrix: Matrix): number {
  return adjacentPenalty(matrix.modules, matrix.size, true)
    + adjacentPenalty(matrix.modules, matrix.size, false)
    + blockPenalty(matrix.modules, matrix.size)
    + finderPenalty(matrix.modules, matrix.size, true)
    + finderPenalty(matrix.modules, matrix.size, false)
    + balancePenalty(matrix.modules);
}

/** qrcode 0.13.0 `canvas.rs::apply_best_mask`: first pattern wins on a score tie. */
function applyBestMask(base: Matrix): Matrix {
  let best: Matrix | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < MASK_FUNCTIONS.length; mask++) {
    const candidate = cloneMatrix(base);
    applyMask(candidate, mask);
    drawFormat(candidate, mask);
    const score = totalPenalty(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (best === null) throw new Error('unreachable: no mask pattern');
  return best;
}

export interface QrMatrix {
  readonly size: number;
  /** Row-major 0/1 matrix without the quiet zone. */
  readonly modules: Uint8Array;
}

export function encodeQrMatrix(content: string): QrMatrix {
  const encoded = encodeOptimal(new TextEncoder().encode(content));
  const size = 17 + 4 * encoded.version;
  const matrix = newMatrix(size);
  drawFunctionPatterns(matrix, encoded.version);
  placeData(matrix, interleave(encoded.data, encoded.version));
  const masked = applyBestMask(matrix);
  return { size, modules: Uint8Array.from(masked.modules, (value) => (value === 1 ? 1 : 0)) };
}

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
  return out;
}

function pngFromMatrix(matrix: QrMatrix, quietZone = 4): Buffer {
  // qrcode renderer `min_dimensions(256, 256)` rounds the module size up
  // (render/mod.rs:135-142), so the PNG is at least 256px instead of smaller.
  const scale = Math.max(1, Math.ceil(256 / (matrix.size + quietZone * 2)));
  const dimension = (matrix.size + quietZone * 2) * scale;
  const raw = Buffer.alloc(dimension * (dimension + 1));
  for (let y = 0; y < dimension; y++) {
    const rowStart = y * (dimension + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < dimension; x++) {
      const moduleX = Math.floor(x / scale) - quietZone;
      const moduleY = Math.floor(y / scale) - quietZone;
      const dark =
        moduleX >= 0 &&
        moduleY >= 0 &&
        moduleX < matrix.size &&
        moduleY < matrix.size &&
        matrix.modules[moduleY * matrix.size + moduleX] === 1;
      raw[rowStart + 1 + x] = dark ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(dimension, 0);
  header.writeUInt32BE(dimension, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** Rust: dstu_util::qr::qrcode_png_base64 — raw base64 (no data-url prefix). */
export function qrcodePngBase64(content: string): string {
  try {
    return pngFromMatrix(encodeQrMatrix(content)).toString('base64');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'error_type' in error) throw error;
    throw qrError(error instanceof Error ? error.message : String(error));
  }
}
