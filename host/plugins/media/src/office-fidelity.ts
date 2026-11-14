/**
 * `src/chat_v2/tools/office_fidelity_executor.rs`: read-only OOXML/PDF feature
 * inventory and the shared critical/high edit gate used by the Office tools.
 * Source loading from runtime roots/VFS stays with the tool executor and is not
 * migrated; `inspectBytes`/`preflightForEdit` only need raw bytes.
 */
import { createHash } from 'node:crypto';
import { readZipEntries } from './zip.ts';

export const OFFICE_FIDELITY_CONTRACT = 'office-fidelity-inspection/v1';
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
export const MAX_PART_BYTES = 32 * 1024 * 1024;
export const MAX_PARTS = 20_000;

export type Risk = 'critical' | 'high' | 'medium' | 'low';

export interface FeatureEvidence {
  feature: string;
  present: boolean;
  risk: Risk;
  count: number;
  evidenceParts: string[];
  featureHash: string | null;
}

export interface PackagePart { name: string; bytes: Buffer }

export interface EditPreflight {
  format: string;
  risk: string;
  sourceSha256: string;
  featureSetHash: string;
  criticalFeatures: string[];
  highFeatures: string[];
}

export interface EditGateWording {
  writePath: string;
  officeApps: string;
  highFeaturesDropped: boolean;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashJson(value: unknown): string {
  return sha256Hex(Buffer.from(JSON.stringify(value), 'utf8'));
}

export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  return needle.length > 0 && Buffer.from(haystack).indexOf(Buffer.from(needle)) >= 0;
}

export function findAll(haystack: Uint8Array, needle: Uint8Array): number[] {
  if (needle.length === 0) return [];
  const hay = Buffer.from(haystack);
  const pattern = Buffer.from(needle);
  const positions: number[] = [];
  let index = hay.indexOf(pattern);
  while (index >= 0) {
    positions.push(index);
    index = hay.indexOf(pattern, index + 1);
  }
  return positions;
}

/** 脚注/尾注部件是否有真实条目（排除 separator/continuationSeparator 样板）。 */
export function hasRealNote(bytes: Uint8Array, tag: Uint8Array): boolean {
  const buffer = Buffer.from(bytes);
  for (const start of findAll(bytes, tag)) {
    const close = buffer.indexOf(0x3e, start);
    const end = close < 0 ? bytes.length : close;
    const tagLower = Buffer.from(bytes.subarray(start, end)).toString('latin1').toLowerCase();
    if (!tagLower.includes('separator')) return true;
  }
  return false;
}

/**
 * Whether an ST_OnOff element (`<w:titlePg/>`, `<w:evenAndOddHeaders w:val="1"/>`)
 * is switched on. Rust matches the tag bytes alone; an explicit
 * `w:val="false"|"0"|"off"` — which the F7 docx writer emits in settings.xml — is off.
 */
export function hasEnabledOnOff(bytes: Uint8Array, tag: string): boolean {
  const buffer = Buffer.from(bytes);
  for (const start of findAll(bytes, bytesOf(tag))) {
    const next = buffer[start + tag.length];
    if (next !== undefined && next !== 0x20 && next !== 0x09 && next !== 0x0a && next !== 0x0d
      && next !== 0x2f && next !== 0x3e) continue;
    const close = buffer.indexOf(0x3e, start);
    const element = buffer.subarray(start, close < 0 ? buffer.length : close).toString('latin1');
    const value = /\bw:val\s*=\s*["']([^"']*)["']/.exec(element)?.[1]?.trim().toLowerCase();
    if (value === undefined || !['false', '0', 'off'].includes(value)) return true;
  }
  return false;
}

function featureHash(parts: readonly PackagePart[]): string {
  const hasher = createHash('sha256');
  for (const part of parts) {
    hasher.update(Buffer.from(part.name, 'utf8'));
    hasher.update(Buffer.from([0]));
    hasher.update(Buffer.from(sha256Hex(part.bytes), 'hex'));
  }
  return hasher.digest('hex');
}

function evidence(
  feature: string,
  risk: Risk,
  matched: readonly PackagePart[],
): FeatureEvidence {
  return {
    feature,
    present: matched.length > 0,
    risk,
    count: matched.length,
    evidenceParts: matched.map(part => part.name),
    featureHash: matched.length > 0 ? featureHash(matched) : null,
  };
}

export function matchingFeatureIf(
  parts: readonly PackagePart[],
  feature: string,
  risk: Risk,
  predicate: (part: PackagePart) => boolean,
): FeatureEvidence {
  return evidence(feature, risk, parts.filter(predicate));
}

export function matchingFeature(
  parts: readonly PackagePart[],
  feature: string,
  risk: Risk,
  pathMatches: (name: string) => boolean,
  markers: readonly Uint8Array[],
): FeatureEvidence {
  return evidence(feature, risk, parts.filter(part =>
    pathMatches(part.name) || markers.some(marker => containsBytes(part.bytes, marker))));
}

function bytesOf(value: string): Buffer { return Buffer.from(value, 'utf8'); }

function pdfFeature(
  bytes: Uint8Array,
  feature: string,
  risk: Risk,
  markers: readonly Uint8Array[],
): FeatureEvidence {
  const positions = markers.flatMap(marker => findAll(bytes, marker));
  const hasher = createHash('sha256');
  for (const position of positions) {
    const start = Math.max(0, position - 128);
    const end = Math.min(position + 256, bytes.length);
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(BigInt(position));
    hasher.update(prefix);
    hasher.update(Buffer.from(bytes.subarray(start, end)));
  }
  return {
    feature,
    present: positions.length > 0,
    risk,
    count: positions.length,
    evidenceParts: positions.map(position => `byte:${position}`),
    featureHash: positions.length > 0 ? hasher.digest('hex') : null,
  };
}

function inventoryResult(
  format: string,
  bytes: Uint8Array,
  features: readonly FeatureEvidence[],
  completeDetection: boolean,
): Record<string, unknown> {
  const unsupported = features.filter(feature => feature.present).map(feature => feature.feature);
  let risk: Risk = 'low';
  if (features.some(feature => feature.present && feature.risk === 'critical')) risk = 'critical';
  else if (features.some(feature => feature.present && feature.risk === 'high')) risk = 'high';
  else if (features.some(feature => feature.present && feature.risk === 'medium')) risk = 'medium';
  const requiresHumanReview = !completeDetection || unsupported.length > 0;
  if (!completeDetection && risk === 'low') risk = 'medium';
  return {
    contract: OFFICE_FIDELITY_CONTRACT,
    format,
    readOnly: true,
    sourceSha256: sha256Hex(bytes),
    supported: ['package_feature_inventory', 'feature_presence_detection', 'auditable_feature_hashes'],
    preserved: ['source_bytes_unchanged_by_inspection'],
    unsupported,
    features,
    featureSetHash: hashJson(features),
    risk,
    requiresHumanReview,
    requires_human_review: requiresHumanReview,
    inspectionCoverage: completeDetection
      ? 'complete_for_listed_ooxml_package_features'
      : 'partial_lexical_or_encrypted_container_detection',
    limitations: completeDetection
      ? []
      : ['compressed PDF object streams or encrypted container contents may hide features'],
    completionGate: {
      automatedEditAllowed: !requiresHumanReview,
      defaultMacroOrSignatureAction: 'refuse',
      explicitStripPolicy: 'macro_policy=strip',
      signatureInvalidationLabelRequired: true,
      preservationClaimAllowed: false,
    },
    secretPrompt: {
      supported: false,
      reasonCode: 'DECRYPTOR_INTEGRATION_UNAVAILABLE',
      reason: 'SecretPrompt handles are isolated from chat and logs, but no Office/PDF decryptor consumes them yet',
    },
  };
}

export function inspectPdf(bytes: Uint8Array): Record<string, unknown> {
  if (!Buffer.from(bytes.subarray(0, 5)).equals(bytesOf('%PDF-'))) {
    throw new Error('OFFICE_FIDELITY_INVALID_PDF: missing PDF signature');
  }
  return inventoryResult('pdf', bytes, [
    pdfFeature(bytes, 'forms', 'high', [bytesOf('/AcroForm'), bytesOf('/XFA')]),
    pdfFeature(bytes, 'digital_signatures', 'critical',
      [bytesOf('/Type /Sig'), bytesOf('/SigFlags'), bytesOf('/ByteRange')]),
    pdfFeature(bytes, 'attachments', 'high',
      [bytesOf('/EmbeddedFiles'), bytesOf('/Filespec'), bytesOf('/EmbeddedFile')]),
    pdfFeature(bytes, 'encryption', 'critical', [bytesOf('/Encrypt')]),
  ], false);
}

function readPackage(bytes: Uint8Array): PackagePart[] {
  const entries = readZipEntries(bytes);
  if (entries === null) throw new Error('OFFICE_FIDELITY_INVALID_OOXML: invalid ZIP package');
  if (entries.length > MAX_PARTS) {
    throw new Error(`OFFICE_FIDELITY_PACKAGE_LIMIT: ${entries.length} parts exceeds ${MAX_PARTS}`);
  }
  let total = 0;
  const parts: PackagePart[] = [];
  for (const entry of entries) {
    if (entry.bytes.length > MAX_PART_BYTES) {
      throw new Error(`OFFICE_FIDELITY_PACKAGE_LIMIT: part '${entry.name}' exceeds ${MAX_PART_BYTES} bytes`);
    }
    total += entry.bytes.length;
    if (total > MAX_PACKAGE_BYTES) {
      throw new Error(`OFFICE_FIDELITY_PACKAGE_LIMIT: uncompressed package exceeds ${MAX_PACKAGE_BYTES} bytes`);
    }
    parts.push({ name: entry.name, bytes: entry.bytes });
  }
  return parts;
}

function packageFormat(parts: readonly PackagePart[]): 'docx' | 'xlsx' | 'pptx' {
  if (!parts.some(part => part.name === '[Content_Types].xml')) {
    throw new Error('OFFICE_FIDELITY_INVALID_OOXML: missing [Content_Types].xml');
  }
  if (parts.some(part => part.name.startsWith('word/'))) return 'docx';
  if (parts.some(part => part.name.startsWith('xl/'))) return 'xlsx';
  if (parts.some(part => part.name.startsWith('ppt/'))) return 'pptx';
  throw new Error('OFFICE_FIDELITY_UNSUPPORTED_FORMAT: ZIP is not DOCX, XLSX or PPTX');
}

export function inspectOoxml(bytes: Uint8Array): Record<string, unknown> {
  const parts = readPackage(bytes);
  const format = packageFormat(parts);
  const features: FeatureEvidence[] = [
    matchingFeature(parts, 'macros', 'critical',
      name => name.toLowerCase().endsWith('vbaproject.bin') || name.toLowerCase().includes('macrosheets/'),
      []),
    matchingFeature(parts, 'digital_signatures', 'critical',
      name => name.toLowerCase().startsWith('_xmlsignatures/') || name.toLowerCase().includes('signature'),
      []),
  ];
  if (format === 'docx') {
    features.push(
      matchingFeature(parts, 'tracked_revisions', 'critical', () => false, [
        bytesOf('<w:ins '), bytesOf('<w:ins>'), bytesOf('<w:del '), bytesOf('<w:del>'),
        bytesOf('<w:moveFrom '), bytesOf('<w:moveFrom>'), bytesOf('<w:moveTo '), bytesOf('<w:moveTo>'),
      ]),
      matchingFeature(parts, 'content_controls', 'critical', () => false,
        [bytesOf('<w:sdt>'), bytesOf('<w:sdt ')]),
      matchingFeature(parts, 'toc_crossref_fields', 'critical', () => false,
        [bytesOf(' TOC \\o'), bytesOf(' TOC \\h'), bytesOf('PAGEREF '), bytesOf(' REF '), bytesOf('NOTEREF ')]),
      matchingFeature(parts, 'images', 'critical', name => name.startsWith('word/media/'), []),
      matchingFeature(parts, 'embedded_ole', 'critical',
        name => name.startsWith('word/embeddings/') || name.startsWith('word/activeX/'),
        [bytesOf('oleObject')]),
      // RUST-FIX(RF-W04-docx-onoff-false-headers): office_fidelity_executor.rs:388 matches the tag bytes
      // alone, so an explicit w:val="false" (our own docx writer's output) blocks every docx edit.
      matchingFeatureIf(parts, 'complex_headers_footers', 'critical', part =>
        hasEnabledOnOff(part.bytes, '<w:evenAndOddHeaders') || hasEnabledOnOff(part.bytes, '<w:titlePg')),
      matchingFeature(parts, 'headers_footers', 'high',
        name => name.startsWith('word/header') || name.startsWith('word/footer'), []),
      matchingFeatureIf(parts, 'comments', 'high',
        part => part.name === 'word/comments.xml' && containsBytes(part.bytes, bytesOf('<w:comment '))),
      matchingFeatureIf(parts, 'footnotes_endnotes', 'high', part =>
        (part.name === 'word/footnotes.xml' && hasRealNote(part.bytes, bytesOf('<w:footnote ')))
        || (part.name === 'word/endnotes.xml' && hasRealNote(part.bytes, bytesOf('<w:endnote ')))),
      matchingFeature(parts, 'fields', 'medium', () => false,
        [bytesOf('<w:fldSimple'), bytesOf('<w:instrText'), bytesOf('<w:fldChar')]),
    );
  } else if (format === 'xlsx') {
    features.push(
      matchingFeature(parts, 'formulas', 'high', name => name.startsWith('xl/calcChain'),
        [bytesOf('<f>'), bytesOf('<f ')]),
      matchingFeature(parts, 'defined_names', 'high', () => false,
        [bytesOf('<definedNames'), bytesOf('<definedName')]),
      matchingFeature(parts, 'data_validation', 'high', () => false,
        [bytesOf('<dataValidations'), bytesOf('<dataValidation')]),
      matchingFeature(parts, 'charts', 'high', name => name.startsWith('xl/charts/'), []),
      matchingFeature(parts, 'pivot_tables', 'high',
        name => name.startsWith('xl/pivotTables/') || name.startsWith('xl/pivotCache/'), []),
      matchingFeature(parts, 'external_links', 'critical',
        name => name.startsWith('xl/externalLinks/'), [bytesOf('externalLink')]),
    );
  } else {
    features.push(
      matchingFeature(parts, 'media', 'critical', name => name.startsWith('ppt/media/'), []),
      matchingFeature(parts, 'embedded_ole', 'critical',
        name => name.startsWith('ppt/embeddings/'), [bytesOf('oleObject')]),
      matchingFeature(parts, 'slide_masters', 'high',
        name => name.startsWith('ppt/slideMasters/') || name.startsWith('ppt/slideLayouts/'), []),
      matchingFeature(parts, 'speaker_notes', 'high',
        name => name.startsWith('ppt/notesSlides/') || name.startsWith('ppt/notesMasters/'), []),
      matchingFeature(parts, 'animations_timing', 'high', () => false,
        [bytesOf('<p:timing'), bytesOf('<p:anim'), bytesOf('<p:transition')]),
      matchingFeature(parts, 'charts', 'high', name => name.startsWith('ppt/charts/'), []),
      matchingFeature(parts, 'diagrams', 'high', name => name.startsWith('ppt/diagrams/'), []),
    );
  }
  return inventoryResult(format, bytes, features, true);
}

/** 与 Rust `inspect_bytes` 的格式分派一致。 */
export function inspectBytes(bytes: Uint8Array): Record<string, unknown> {
  if (Buffer.from(bytes.subarray(0, 5)).equals(bytesOf('%PDF-'))) return inspectPdf(bytes);
  if (Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return inspectOoxml(bytes);
  }
  const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length >= 8 && cfb.every((byte, i) => bytes[i] === byte)) {
    const first = bytes.subarray(0, Math.min(512, bytes.length));
    const feature: FeatureEvidence = {
      feature: 'encryption_or_legacy_compound_container',
      present: true,
      risk: 'critical',
      count: 1,
      evidenceParts: ['cfb-header'],
      featureHash: sha256Hex(first),
    };
    return inventoryResult('encrypted_office_or_legacy_cfb', bytes, [feature], false);
  }
  throw new Error('OFFICE_FIDELITY_UNSUPPORTED_FORMAT: expected DOCX, XLSX, PPTX or PDF signature');
}

export function preflightForEdit(bytes: Uint8Array): EditPreflight {
  const report = inspectBytes(bytes);
  const criticalFeatures: string[] = [];
  const highFeatures: string[] = [];
  for (const feature of (report.features as FeatureEvidence[])) {
    if (!feature.present) continue;
    if (feature.risk === 'critical') criticalFeatures.push(feature.feature);
    else if (feature.risk === 'high') highFeatures.push(feature.feature);
  }
  return {
    format: report.format as string,
    risk: report.risk as string,
    sourceSha256: report.sourceSha256 as string,
    featureSetHash: report.featureSetHash as string,
    criticalFeatures,
    highFeatures,
  };
}

export function hasCritical(preflight: EditPreflight): boolean {
  return preflight.criticalFeatures.length > 0;
}

/** critical 特征门禁：错误为结构化 JSON（含特征清单与副本模式提示）。 */
export function enforceEditPreflight(
  preflight: EditPreflight,
  wording: EditGateWording,
): void {
  if (!hasCritical(preflight)) return;
  const payload = {
    error_code: 'OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES',
    critical_features: preflight.criticalFeatures,
    source_sha256: preflight.sourceSha256,
    reason: `源文件包含 critical 保真特征，${wording.writePath}会静默丢失这些特征，已拒绝编辑`,
    hint: `可改用副本模式：在 ${wording.officeApps} 中打开原文件手动编辑，`
      + '或先另存为去除上述特征的副本后再对本工具编辑副本；'
      + '完整特征清单可用 builtin-office_fidelity_inspect 查看',
  };
  throw new Error(`OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES: ${JSON.stringify(payload)}`);
}

/** 构建交付结果中的 fidelity warning；无 high 特征且无附加明细时返回 null。 */
export function buildEditFidelityWarning(
  preflight: EditPreflight,
  wording: EditGateWording,
  extraFields: ReadonlyArray<readonly [string, string[]]>,
): Record<string, unknown> | null {
  const extrasEmpty = extraFields.every(([, values]) => values.length === 0);
  if (preflight.highFeatures.length === 0 && extrasEmpty) return null;
  const message = wording.highFeaturesDropped
    ? `源文件包含的特征在${wording.writePath}中会被丢弃（产物仅保留受支持的文本与表格结构），`
      + `且未做编辑后结构对比，建议在 ${wording.officeApps} 中打开产物核对`
    : `源文件包含高保真风险特征，本次编辑未做编辑后结构对比，建议在 ${wording.officeApps} 中打开产物核对`;
  const warning: Record<string, unknown> = {
    contract: OFFICE_FIDELITY_CONTRACT,
    risk: preflight.risk,
    source_sha256: preflight.sourceSha256,
    feature_set_hash: preflight.featureSetHash,
    preserved_at_risk_features: preflight.highFeatures,
    post_edit_comparison: 'not_performed',
    message,
  };
  if (wording.highFeaturesDropped) {
    warning.write_path_semantics = 'text_only_rebuild_drops_listed_features';
  }
  for (const [key, values] of extraFields) warning[key] = values;
  return warning;
}
