/** Executes the actual declarations/callbacks extracted from production TS/TSX.
 * No rewritten switch oracle: both revisions go through the same AST extraction.
 * UI/service boundaries are symbolic so the snapshot records returned components,
 * JSX props, events and invoked actions rather than mounting the whole application.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as lookup from '../lookup';
import * as official from '../official';

export const BASE = 'e73e0d98';
export const INPUTS = [
  'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'mindmap',
  'all', 'folder', 'retrieval', 'acme.flashcard', '', '__proto__', 'constructor',
  'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable',
  'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  'todo', 'skill', 'skill_instruction', 'selection', 'attachment',
];

const chat = 'src/features/chat/';
const hub = 'src/features/learning-hub/';
const bench = 'src/features/workbench/apps/';
type Target = { file: string; name: string; kind?: 'callback' | 'jsx'; mode?: string; baselineFile?: string };
export const TARGETS: Target[] = [
  { file: `${chat}components/ContextRefsDisplay.tsx`, name: 'getResourceIconComponent' },
  { file: `${chat}components/groups/GroupEditorDialog.tsx`, name: 'getResourceTypeIcon' },
  ...['getTypeIcon', 'getTypeLabelKey', 'getTypeColorClass'].map(name => ({ file: `${chat}components/input-bar/ContextRefChips.tsx`, name })),
  ...['getSourceTypeIcon', 'getSourceTypeColor'].map(name => ({ file: `${chat}components/panels/MultimodalSourceCard.tsx`, name })),
  { file: `${chat}context/definitions/folder.ts`, name: 'getItemXmlTag' },
  { file: `${chat}pages/ChatV2Page.tsx`, name: 'getAppIcon' },
  { file: `${chat}pages/ChatV2Page.tsx`, name: 'handleOpenInLearningHub', kind: 'callback', mode: 'open' },
  { file: `${hub}apps/UnifiedAppPanel.tsx`, name: 'contentView', kind: 'callback', mode: 'view' },
  { file: `${hub}sidebar/SidebarContextMenu.tsx`, name: 'onCreateItem', kind: 'jsx', mode: 'create' },
  ...['getResourceType', 'getTypeId'].map(name => ({ file: `${hub}useReferenceToChat.ts`, name })),
  { file: `${bench}content/ContentSkeleton.tsx`, name: 'skeletonVariantForType' },
  { file: `${bench}content/typeMap.ts`, name: 'resourceTypeToAppTypeId' },
  { file: `${bench}files/useFilesHoverPreview.tsx`, name: 'typeLabel', mode: 'label' },
  { file: `${bench}files/useResourceDragOut.ts`, name: 'glyphForType' },
  { file: 'src/services/multimodalRagService.ts', name: 'normalizeSourceType' },
  { file: 'src/ui-plugins/official/content/menu.ts', name: 'menuTargetContext', mode: 'menu' },
  ...['itemTypeToResourceType', 'itemTypeToPreviewType', 'nodeTypeToFolderItemType', 'mapDstuTypeToFolderItemType', 'itemTypeToSourceDb'].map(name => ({ file: `${hub}types.ts`, name })),
  { file: `${hub}sidebar/useSidebarChatActions.ts`, name: 'useSidebarReferenceToChat', mode: 'reference' },
  { file: `${hub}sidebar/useSidebarChatActions.ts`, name: 'batchAddSelectionToChat', mode: 'batch' },
  { file: `${hub}hooks/useVfsContextInject.ts`, name: 'injectToChat', kind: 'callback', mode: 'inject' },
  { file: `${hub}useLearningHubPageController.tsx`, baselineFile: `${hub}LearningHubPage.tsx`, name: 'handleInjectToChat', kind: 'callback', mode: 'pageInject' },
];

const read = (file: string, baseline: boolean, revision?: string) => baseline || revision
  ? fs.readFileSync(`tests/fixtures/plugin-consolidation/${baseline ? BASE : revision}/${file}.txt`, 'utf8')
  : fs.readFileSync(file, 'utf8');

function extract(target: Target, baseline: boolean, revision?: string) {
  const file = baseline ? target.baselineFile ?? target.file : target.file;
  const source = read(file, baseline, revision);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map<string, ts.Node>();
  for (const node of sf.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node);
    if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) declarations.set(d.name.text, d);
    }
  }
  let selected: ts.Node | undefined;
  const walk = (node: ts.Node) => {
    if (target.kind === 'jsx' && ts.isJsxAttribute(node) && node.name.getText(sf) === target.name) {
      const initializer = node.initializer as ts.JsxExpression;
      const conditional = initializer.expression as ts.ConditionalExpression;
      selected = conditional.whenTrue;
    } else if (ts.isVariableDeclaration(node) && node.name.getText(sf) === target.name) {
      selected = target.kind === 'callback' ? (node.initializer as ts.CallExpression).arguments[0] : node;
    } else if (!target.kind && ts.isFunctionDeclaration(node) && node.name?.text === target.name) selected = node;
    ts.forEachChild(node, walk);
  };
  walk(sf);
  if (!selected) throw new Error(`Missing production declaration ${file}:${target.name}`);
  const codeFor = (node: ts.Node) => ts.isVariableDeclaration(node) ? `const ${node.getText(sf)};` : node.getText(sf).replace(/^export\s+(default\s+)?/, '');
  const included = new Set<ts.Node>([selected]);
  const dependencies: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const d = declarations.get(node.text);
      if (d && !included.has(d) && !node.text.endsWith('ContentView')) {
        included.add(d);
        ts.forEachChild(d, visit);
        dependencies.push(codeFor(d));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(selected, visit);
  const entry = target.kind ? `const __entry = ${selected.getText(sf)};` : `${codeFor(selected)}\nconst __entry = ${target.name};`;
  const js = ts.transpileModule(`${dependencies.join('\n')}\n${entry}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  return js;
}

function normalize(value: any): any {
  if (value === undefined) return '<undefined>';
  if (typeof value === 'function') return `<function:${value.displayName ?? value.name}>`;
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) === null && Object.keys(value).length === 0) return '<Object.prototype>';
  if (Array.isArray(value)) return value.map(normalize);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
}

export async function consumerMatrix(baseline: boolean, revision?: string, targets = TARGETS) {
  const matrix: Record<string, unknown> = {};
  for (const target of targets) {
    const js = extract(target, baseline, revision);
    const rows: Record<string, unknown> = {};
    for (const type of INPUTS) {
      const calls: unknown[] = [];
      const effect = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
      const t = (key: string, options?: unknown) => options ? { key, options } : key;
      const injectToChat = async (...args: unknown[]) => { calls.push(['injectToChat', ...args]); return { success: true, contextRef: { resourceId: 'ref' } }; };
      const globals: Record<string, any> = {
        ...official, ...lookup, t,
        React: { createElement: (element: unknown, props: unknown, ...children: unknown[]) => ({ element, props, ...(children.length ? { children } : {}) }) },
        useCallback: (fn: unknown) => fn,
        openApp: { type, id: 'resource-id', title: 'Title', filePath: '/folder/resource-id' },
        node: { id: 'resource-id' }, commonProps: { resourceId: 'resource-id', title: 'Title' },
        resolvedType: type, hostWindowId: 'host', isActive: true, focusOnActive: true,
        handleTitleChange: effect('title'), handleSaveStateChange: effect('save'),
        handleCloseApp: effect('close'), setMobileResourcePanelOpen: effect('panel'),
        canInject: () => true, injectToChat, activeTab: { type, resourceId: 'resource-id', title: 'Title' },
        setIsInjecting: effect('injecting'), showGlobalNotification: effect('notification'),
        debugLog: { log() {}, error() {}, warn() {} },
        getErrorMessage: (error: Error) => error.message,
        pLimit: () => (fn: () => unknown) => fn(),
        sessionManager: { getCurrentSessionId: () => 'session', has: () => true, get: () => ({ getState: () => ({ addContextRef: effect('contextRef'), addAttachment: effect('attachment') }) }) },
        getResourceRefsV2: async () => ({ ok: true, value: { refs: [{}], truncated: false } }),
        resourceStoreApi: { createOrReuse: async () => ({ resourceId: 'ref', hash: 'hash' }) },
        mimeTypeFromFileName: () => undefined,
        getAttachmentMediaType: (mime: unknown) => mime === 'image/png' ? 'image' : 'document',
        isCurrentChatModelMultimodal: async () => false,
        fetchLibraryAttachmentProcessing: async () => undefined,
        buildDefaultInjectModes: () => undefined,
        Date: { now: () => 0 },
        CustomEvent: class { type: string; detail: unknown; constructor(name: string, opts?: { detail: unknown }) { this.type = name; this.detail = opts?.detail; } },
        window: { dispatchEvent: effect('event') },
      };
      for (const name of ['NoteIcon', 'TextbookIcon', 'ExamIcon', 'EssayIcon', 'TranslationIcon', 'MindmapIcon', 'GenericFileIcon', 'FileText', 'BookOpen', 'ClipboardText', 'PenNib', 'ImageIcon', 'Brain', 'ListChecks', 'FileIcon', 'PencilSimple', 'Translate', 'Folder', 'FolderSimple', 'Lightning', 'Quotes', 'Paperclip', 'Image', 'File', 'NoteContentView', 'TextbookContentView', 'ExamContentView', 'TranslationContentView', 'EssayContentView', 'ImageContentView', 'FileContentView', 'MindMapContentView']) {
        globals[name] = Object.assign(function Icon() {}, { displayName: name });
      }
      for (const name of ['NOTE', 'TEXTBOOK', 'EXAM', 'ESSAY', 'TRANSLATION', 'FILE', 'IMAGE']) globals[`${name}_TYPE_ID`] = name.toLowerCase();
      for (const name of ['Note', 'Exam', 'Textbook', 'Translation', 'Essay', 'MindMap']) globals[`handleNew${name}`] = effect(`create${name}`);
      const context = vm.createContext(globals);
      const fn = vm.runInContext(`${js}\n__entry`, context);
      let result: unknown;
      switch (target.mode) {
        case 'label': result = fn(t, type); break;
        case 'menu': result = fn({ type: 'folderItem', item: { itemId: 'resource-id', itemType: type } }, false); break;
        case 'open': case 'view': case 'pageInject': result = await fn(); break;
        case 'create': result = fn(type, 'folder-id'); break;
        case 'reference': result = await fn({ canInject: () => true, injectToChat, onReferenceToChat: effect('reference'), t })({ type: 'resource', resource: { type, id: 'resource-id', title: 'Title' } }); break;
        case 'batch': result = await fn({ selectedIds: new Set(['resource-id']), canAddToChatInCurrentView: true, canInject: () => true, t, setIsBatchProcessing: effect('processing'), items: [{ type, id: 'resource-id', name: 'Title' }], injectToChat, isMountedRef: { current: true }, clearSelection: effect('clear'), setSelectedIds: effect('select') }); break;
        case 'inject': result = await fn({ sourceId: 'resource-id', sourceType: type, name: 'Title', metadata: {} }); break;
        default: result = fn(type);
      }
      rows[type] = normalize({ result, calls });
    }
    matrix[`${target.file}:${target.name}`] = rows;
  }
  return matrix;
}
