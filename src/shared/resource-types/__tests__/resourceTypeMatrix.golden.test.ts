/**
 * `resource.types` × 操作全矩阵 golden（W37 第一步）。
 *
 * 覆盖：
 * - 8 个官方资源类型（note/textbook/exam/translation/essay/image/file/mindmap）；
 * - 非资源值与未知类型（all/folder/retrieval/插件自有/空串/原型链键）；
 * - 9 个契约操作（open/preview/rename/move/delete/copy/favorite/add-to-chat/add-to-desktop）；
 * - 消费者 UI 投影（图标 token、色标、预览类型、骨架、拖拽字形、XML 标签、MIME、
 *   聊天打开事件、回收站分组、RAG 来源类型）。
 *
 * 改造前这张表由现有 switch 的返回值逐项对齐（`legacyParity`），改造后同一张表必须
 * 零差异；golden 文件只能由 `DS_RESOURCE_TYPES_UPDATE=1` 显式重录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RESOURCE_TYPE_CONFIG, itemTypeToPreviewType, itemTypeToSourceDb, type ResourceType } from '@/features/learning-hub/types';
import { resourceTypeToAppTypeId } from '@/features/workbench/apps/content/typeMap';
import { skeletonVariantForType } from '@/features/workbench/apps/content/ContentSkeleton';
import { typeLabel as filesPreviewTypeLabel } from '@/features/workbench/apps/files/useFilesHoverPreview';
import { glyphForType } from '@/features/workbench/apps/files/useResourceDragOut';
import { getItemXmlTag } from '@/features/chat/context/definitions/folder';
import { normalizeSourceType } from '@/services/multimodalRagService';
import { getResourceType, getTypeId, type SourceType } from '@/features/learning-hub/useReferenceToChat';

import { OFFICIAL_RESOURCE_OPERATIONS, OFFICIAL_RESOURCE_TYPES, OFFICIAL_RESOURCE_TYPE_UI, type OfficialResourceType } from '../official';
import { getOfficialResourceTypeDefinition, getOfficialResourceTypeUi, supportsResourceOperation } from '../lookup';

const UPDATE = process.env.DS_RESOURCE_TYPES_UPDATE === 'update';
const GOLDEN = path.resolve('src/shared/resource-types/__golden__/resource-type-matrix.json');

const UNKNOWN_TYPES = ['all', 'folder', 'retrieval', 'acme.flashcard', '', '__proto__', 'constructor'] as const;

const scanTypes = [...Object.keys(OFFICIAL_RESOURCE_TYPES), ...UNKNOWN_TYPES];

type MatrixRow = {
  contract: {
    present: boolean;
    labelKey: string | null;
    icon: string | null;
    order: number | null;
    preview: string | null;
    operations: string[];
  };
  supported: Record<string, boolean>;
  ui: {
    iconToken: string | null;
    color: string | null;
    previewType: string | null;
    skeleton: string | null;
    previewLabelKey: string | null;
    dragGlyph: string | null;
    xmlTag: string | null;
    vfsType: string | null;
    mime: string | null;
    chatIconToken: string | null;
    refIconToken: string | null;
    editorIconToken: string | null;
    chatOpenEvent: string | null;
    trashType: string | null;
    multimodalSourceType: string | null;
  };
  legacy: {
    config: { labelKey: string; icon: string; color: string } | null;
    previewType: string;
    sourceDb: string | null;
    appTypeId: string | null;
    skeleton: string;
    filesPreviewLabel: string;
    glyph: string;
    xmlTag: string;
    multimodalSourceType: string;
    referenceResourceType: string;
    referenceTypeId: string;
  };
};

function legacyString(value: unknown): string {
  return typeof value === 'string' ? value : '<non-string>';
}

function legacyRow(type: string): MatrixRow['legacy'] {
  const folderType = type as Parameters<typeof itemTypeToPreviewType>[0];
  const config = Object.prototype.hasOwnProperty.call(RESOURCE_TYPE_CONFIG, type)
    ? RESOURCE_TYPE_CONFIG[type as ResourceType]
    : null;
  return {
    config: config ? { labelKey: config.labelKey, icon: config.icon, color: config.color } : null,
    previewType: legacyString(itemTypeToPreviewType(folderType)),
    sourceDb: legacyString(itemTypeToSourceDb(folderType)),
    appTypeId: resourceTypeToAppTypeId(type),
    skeleton: skeletonVariantForType(type),
    filesPreviewLabel: filesPreviewTypeLabel((key) => key, type),
    glyph: glyphForType(type),
    xmlTag: getItemXmlTag(type),
    multimodalSourceType: normalizeSourceType(type),
    referenceResourceType: getResourceType(type as SourceType),
    referenceTypeId: getTypeId(type as SourceType),
  };
}

function row(type: string): MatrixRow {
  const definition = getOfficialResourceTypeDefinition(type);
  const ui = getOfficialResourceTypeUi(type);
  return {
    contract: {
      present: Boolean(definition),
      labelKey: definition?.labelKey ?? null,
      icon: definition?.icon ?? null,
      order: definition?.order ?? null,
      preview: definition?.preview ?? null,
      operations: definition ? [...definition.operations] : [],
    },
    supported: Object.fromEntries(OFFICIAL_RESOURCE_OPERATIONS.map((operation) => [operation, supportsResourceOperation(type, operation)])),
    ui: {
      iconToken: ui?.iconToken ?? null,
      color: ui?.color ?? null,
      previewType: ui?.previewType ?? null,
      skeleton: ui?.skeleton ?? null,
      previewLabelKey: ui?.previewLabelKey ?? null,
      dragGlyph: ui?.dragGlyph ?? null,
      xmlTag: ui?.xmlTag ?? null,
      vfsType: ui?.vfsType ?? null,
      mime: ui?.mime ?? null,
      chatIconToken: ui?.chatIconToken ?? null,
      refIconToken: ui?.refIconToken ?? null,
      editorIconToken: ui?.editorIconToken ?? null,
      chatOpenEvent: ui?.chatOpenEvent ?? null,
      trashType: ui?.trashType ?? null,
      multimodalSourceType: ui?.multimodalSourceType ?? null,
    },
    legacy: legacyRow(type),
  };
}

function matrix(): Record<string, MatrixRow> {
  return Object.fromEntries(scanTypes.map((type) => [type, row(type)]));
}

describe('resource type × operation matrix (W37 golden)', () => {
  it('matches the recorded matrix', () => {
    const actual = matrix();
    if (UPDATE) {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    expect(fs.existsSync(GOLDEN), `missing ${path.relative(process.cwd(), GOLDEN)}; run DS_RESOURCE_TYPES_UPDATE=update vitest run ${__filename}`).toBe(true);
    expect(actual).toEqual(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
  });

  it('keeps every contract/UI projection in step with the pre-refactor switch behaviour', () => {
    for (const type of scanTypes) {
      const row = matrix()[type]!;
      if (!row.contract.present) {
        expect(row.supported, type).toEqual(Object.fromEntries(OFFICIAL_RESOURCE_OPERATIONS.map((operation) => [operation, false])));
        expect(row.ui.iconToken, type).toBeNull();
        continue;
      }
      // 官方类型的 UI 投影与旧 switch/映射表逐项一致。
      expect(row.ui.color, type).toBe(row.legacy.config!.color);
      expect(row.ui.previewType, type).toBe(row.legacy.previewType);
      expect(row.ui.skeleton, type).toBe(row.legacy.skeleton);
      expect(row.ui.previewLabelKey, type).toBe(row.legacy.filesPreviewLabel);
      expect(row.ui.dragGlyph, type).toBe(row.legacy.glyph);
      expect(row.ui.xmlTag, type).toBe(row.legacy.xmlTag);
      expect(row.ui.multimodalSourceType, type).toBe(row.legacy.multimodalSourceType);
      expect(row.legacy.appTypeId, type).toBe(
        type === 'note' || type === 'mindmap' ? 'notes'
          : type === 'exam' || type === 'translation' || type === 'essay' ? type
            : 'file-preview',
      );
      expect(row.legacy.sourceDb, type).toBe(
        type === 'note' ? 'notes'
          : type === 'textbook' ? 'textbooks'
            : type === 'exam' ? 'exam_sessions'
              : type === 'translation' ? 'translations'
                : type === 'essay' ? 'essays'
                  : type === 'mindmap' ? 'mindmaps'
                    : 'attachments',
      );
      // `SourceType` 不含 mindmap：引用到对话的旧行为把 mindmap 兜底成 file（已知缺口，golden 固定住，不在本轮改动）。
      const referenceType = type === 'mindmap' ? 'file' : type;
      expect(row.legacy.referenceTypeId, type).toBe(referenceType);
      expect(row.legacy.referenceResourceType, type).toBe(referenceType);
    }
  });

  it('keeps the official contribution and UI table the same size and order', () => {
    const ids = Object.keys(OFFICIAL_RESOURCE_TYPES) as OfficialResourceType[];
    expect(ids).toEqual(Object.keys(OFFICIAL_RESOURCE_TYPE_UI));
    expect(new Set(ids).size).toBe(ids.length);
    for (const type of ids) {
      const definition = OFFICIAL_RESOURCE_TYPES[type];
      expect(definition.type).toBe(type);
      expect(definition.operations).toBe(OFFICIAL_RESOURCE_OPERATIONS);
      expect(definition.labelKey.startsWith('learningHub:resourceType.')).toBe(true);
    }
  });
});
