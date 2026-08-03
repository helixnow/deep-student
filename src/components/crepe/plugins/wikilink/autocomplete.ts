/**
 * 输入 [[ 触发笔记标题补全浮层（共享 suggestOverlay 定位）
 *
 * 
 * - `[[query`            → 笔记标题补全（按 匹配档位 → 最近编辑 → 标题 排序）
 * - `[[target|label`     → 别名编辑：仍按 target 匹配，选中后写入 label
 * - `[[target#heading`   → 标题补全：target 可解析时异步读取该笔记的标题列表
 * 候选行展示所在文件夹路径；同名笔记附 ID 尾缀消歧。
 */

import i18next from 'i18next';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

import { normalizeWikiLinkHeading } from '@/features/notes/wikilinks';

import {
  anchorRectFromView,
  appendHighlightedText,
  createSuggestOverlay,
} from '../shared/suggestOverlay';
import { shouldSkipWikilinkContext } from './codeContext';
import { fuzzyMatchNotes } from './fuzzy';
import { loadNoteHeadings } from './noteContent';
import { WIKILINK_NODE_NAME } from './schema';
import {
  normalizeResolve,
  type WikilinkNoteCandidate,
  type WikilinkPluginConfig,
} from './types';

export const wikilinkAutocompleteKey = new PluginKey('crepeWikilinkAutocomplete');

/** 选中候选后写入 atom 的目标 / 别名 */
export interface WikilinkInsertSpec {
  target: string;
  label: string;
}

export type WikilinkMenuItem =
  | {
    kind: 'note';
    note: WikilinkNoteCandidate;
    insert: WikilinkInsertSpec;
    meta?: string;
    /** 触发高亮的查询子串（target 段） */
    query?: string;
  }
  | { kind: 'heading'; heading: string; insert: WikilinkInsertSpec; meta?: string; query?: string }
  | { kind: 'create'; title: string; insert: WikilinkInsertSpec };

interface ActiveTrigger {
  from: number;
  query: string;
}

/**
 * 从光标前回溯，检测未闭合的 `[[query`。
 * 返回 trigger 在 textBefore 内的起始偏移与 query；无触发时返回 null。
 */
export function detectWikilinkTrigger(
  textBefore: string,
): { triggerStartInText: number; query: string } | null {
  const open = textBefore.lastIndexOf('[[');
  if (open < 0) return null;
  const after = textBefore.slice(open + 2);
  if (after.includes(']]') || after.includes('\n')) return null;
  return { triggerStartInText: open, query: after };
}

export interface WikilinkQueryParts {
  /** `#` 与 `|` 之前的目标文本（未 trim，匹配时再 trim） */
  target: string;
  /** `#` 之后、`|` 之前的标题查询；未输入 `#` 时为 null */
  heading: string | null;
  /** 第一个 `|` 之后的别名文本；未输入 `|` 时为 null */
  label: string | null;
}

/** 与 format.ts 的 `target#heading|label` 语义一致地切分补全查询。 */
export function parseWikilinkQuery(query: string): WikilinkQueryParts {
  const pipe = query.indexOf('|');
  const beforePipe = pipe === -1 ? query : query.slice(0, pipe);
  const label = pipe === -1 ? null : query.slice(pipe + 1);
  const hash = beforePipe.indexOf('#');
  const target = hash === -1 ? beforePipe : beforePipe.slice(0, hash);
  const heading = hash === -1 ? null : beforePipe.slice(hash + 1);
  return { target, heading, label };
}

const CLASS = 'crepe-wikilink-suggest';

/** '/folder/sub/note_1' → '/folder/sub'；根目录或缺失时返回 '' */
function folderFromPath(path: string | undefined): string {
  if (!path) return '';
  const cut = path.lastIndexOf('/');
  return cut > 0 ? path.slice(0, cut) : '';
}

function noteMeta(note: WikilinkNoteCandidate, titleIsDuplicated: boolean): string | undefined {
  const parts: string[] = [];
  const folder = folderFromPath(note.path);
  if (folder) parts.push(folder);
  if (titleIsDuplicated && note.id) parts.push(`…${note.id.slice(-6)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function createOverlay() {
  return createSuggestOverlay<WikilinkMenuItem>({
    className: CLASS,
    decorateItem(row, item) {
      if (item.kind === 'create') {
        row.classList.add(`${CLASS}__item--create`);
        row.textContent = i18next.t('notes:wikilink.create', {
          defaultValue: '创建 "{{title}}"',
          title: item.title,
        });
        row.dataset.kind = 'create';
        return;
      }

      row.dataset.kind = item.kind;
      const title = document.createElement('span');
      title.className = `${CLASS}__item-title`;
      const text = item.kind === 'heading' ? item.heading : item.note.title;
      if (item.kind === 'heading') {
        row.classList.add(`${CLASS}__item--heading`);
      }
      appendHighlightedText(title, text, item.query ?? '', `${CLASS}__item-match`);
      row.appendChild(title);

      if (item.meta) {
        const meta = document.createElement('span');
        meta.className = `${CLASS}__item-meta`;
        meta.textContent = item.meta;
        row.appendChild(meta);
      }
    },
    renderPlaceholder() {
      const empty = document.createElement('div');
      empty.className = `${CLASS}__empty`;
      empty.textContent = i18next.t('notes:wikilink.empty', {
        defaultValue: '无匹配笔记',
      });
      return empty;
    },
  });
}

async function loadNotes(
  getNotes: WikilinkPluginConfig['getNotes'],
): Promise<readonly WikilinkNoteCandidate[]> {
  if (!getNotes) return [];
  try {
    return await Promise.resolve(getNotes());
  } catch {
    return [];
  }
}

export function buildAutocompleteItems(
  notes: readonly WikilinkNoteCandidate[],
  query: string,
  maxSuggestions: number,
): WikilinkMenuItem[] {
  const parts = parseWikilinkQuery(query);
  // `#` 标题模式需要异步内容，由 buildHeadingAutocompleteItems 处理
  if (parts.heading !== null) return [];

  const label = (parts.label ?? '').trim();
  const matched = fuzzyMatchNotes(notes, parts.target, maxSuggestions);

  // 同名判定基于全量数据源而非截断后的 matched，
  // 否则重名笔记恰好只有一篇进入前 N 条时会误判为唯一而写入 title
  const titleCounts = new Map<string, number>();
  for (const note of notes) {
    if (typeof note?.title !== 'string') continue;
    const key = note.title.trim().toLocaleLowerCase();
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }

  const items: WikilinkMenuItem[] = matched.map((note) => {
    const duplicated = (titleCounts.get(note.title.trim().toLocaleLowerCase()) ?? 0) > 1;
    // 同名笔记：title target 消歧后仍歧义，改写稳定的 note id 作 target，
    // title（或用户别名）作 label 显示，渲染与 markdown 阅读均不受影响
    const insert: WikilinkInsertSpec = duplicated && note.id
      ? { target: note.id, label: label || note.title.trim() }
      : { target: note.title.trim(), label };
    return {
      kind: 'note',
      note,
      insert,
      meta: noteMeta(note, duplicated),
      query: parts.target.trim(),
    };
  });

  const q = parts.target.trim();
  if (q) {
    const exact = matched.some((n) => n.title.trim() === q);
    if (!exact) {
      items.push({ kind: 'create', title: q, insert: { target: q, label } });
    }
  }
  return items;
}

/** `[[target#heading` 模式：从目标笔记标题列表构建候选；无匹配时回退为手输标题项。 */
export function buildHeadingAutocompleteItems(
  headings: readonly string[],
  parts: WikilinkQueryParts,
  maxSuggestions: number,
): WikilinkMenuItem[] {
  const target = parts.target.trim();
  if (!target) return [];
  const label = (parts.label ?? '').trim();
  const typed = (parts.heading ?? '').trim();
  // 与 headingTargetBridge / wikilinks 共用锚点规范化：大小写、全半角、
  // 中文标点、空白折叠后做子串匹配，补全可选中的锚点跳转时必然可命中
  const headingQuery = normalizeWikiLinkHeading(typed);

  const matched = headings
    .filter((heading) => !headingQuery || normalizeWikiLinkHeading(heading).includes(headingQuery))
    .slice(0, Math.max(0, maxSuggestions));

  const items: WikilinkMenuItem[] = matched.map((heading) => ({
    kind: 'heading',
    heading,
    insert: { target: `${target}#${heading}`, label },
    meta: target,
    query: typed,
  }));

  // 有真实标题命中时不再追加手输项：避免与命中项重复，且手输锚点大概率是断链
  if (typed && matched.length === 0) {
    items.push({
      kind: 'heading',
      heading: typed,
      insert: { target: `${target}#${typed}`, label },
      meta: target,
      query: typed,
    });
  }
  return items;
}

/** '|别名' / '#标题' 模式的浮层底部提示文案；普通模式返回 null。 */
export function buildModeHint(parts: WikilinkQueryParts): string | null {
  if (parts.label !== null) {
    const label = parts.label.trim() || '…';
    const fallback = `别名模式：插入后显示「${label}」`;
    return i18next.t('notes:wikilink.aliasHint', { defaultValue: fallback, label }) || fallback;
  }
  if (parts.heading !== null) {
    const target = parts.target.trim();
    const fallback = `标题模式：链接到「${target}」中的标题`;
    return i18next.t('notes:wikilink.headingHint', { defaultValue: fallback, target }) || fallback;
  }
  return null;
}

export function insertWikilink(
  view: EditorView,
  from: number,
  to: number,
  target: string,
  label = '',
): void {
  const type = view.state.schema.nodes[WIKILINK_NODE_NAME];
  if (!type) return;
  const node = type.create({ target, label });
  view.dispatch(view.state.tr.replaceWith(from, to, node).scrollIntoView());
}

export function createWikilinkAutocompletePlugin(config: WikilinkPluginConfig = {}) {
  const maxSuggestions = config.maxSuggestions ?? 8;

  const loadItems = async (query: string): Promise<WikilinkMenuItem[]> => {
    const parts = parseWikilinkQuery(query);
    if (parts.heading !== null) {
      const target = parts.target.trim();
      if (!target) return [];
      const resolution = normalizeResolve(config.resolve, target);
      const headings = resolution.resolved && resolution.noteId
        ? await loadNoteHeadings(resolution.noteId)
        : [];
      return buildHeadingAutocompleteItems(headings, parts, maxSuggestions);
    }
    const notes = await loadNotes(config.getNotes);
    return buildAutocompleteItems(notes, query, maxSuggestions);
  };

  return $prose(() => {
    const overlay = createOverlay();
    let active: ActiveTrigger | null = null;
    let requestId = 0;
    let lastSignature = '';

    const closeAll = () => {
      requestId += 1;
      overlay.close();
      active = null;
      lastSignature = '';
    };

    const applyPick = (view: EditorView, item: WikilinkMenuItem) => {
      if (!active) return;
      const from = active.from;
      const to = view.state.selection.from;
      insertWikilink(view, from, to, item.insert.target, item.insert.label);
      closeAll();
    };

    return new Plugin({
      key: wikilinkAutocompleteKey,
      view(editorView) {
        const refresh = () => {
          const editable = editorView.editable;
          if (!editable) {
            if (overlay.isOpen()) closeAll();
            return;
          }

          const { state } = editorView;
          const { selection } = state;
          if (!(selection instanceof TextSelection) || !selection.empty) {
            if (overlay.isOpen()) closeAll();
            return;
          }

          // 代码块 / 行内 code 中不补全（与解析层跳过一致）
          if (shouldSkipWikilinkContext(state)) {
            if (overlay.isOpen()) closeAll();
            return;
          }

          const $from = selection.$from;
          const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
          const detected = detectWikilinkTrigger(textBefore);
          if (!detected) {
            if (overlay.isOpen()) closeAll();
            return;
          }

          const from = $from.start() + detected.triggerStartInText;
          const query = detected.query;
          const signature = `${from}:${query}`;
          active = { from, query };

          if (signature === lastSignature && overlay.isOpen()) {
            overlay.moveAnchor(anchorRectFromView(editorView, selection.from));
            return;
          }
          lastSignature = signature;

          const myRequest = ++requestId;
          void loadItems(query).then((items) => {
            if (myRequest !== requestId) return;
            if (!editorView.dom.isConnected) return;

            const rect = anchorRectFromView(editorView, editorView.state.selection.from);

            if (overlay.isOpen()) {
              overlay.moveAnchor(rect);
              overlay.update(items, 0);
            } else {
              overlay.open(rect, items, (item) => applyPick(editorView, item));
            }
            overlay.setHint(buildModeHint(parseWikilinkQuery(query)));
          });
        };

        return {
          update(view, prevState) {
            if (
              view.state.doc.eq(prevState.doc)
              && view.state.selection.eq(prevState.selection)
            ) {
              return;
            }
            refresh();
          },
          destroy() {
            closeAll();
          },
        };
      },
      props: {
        handleKeyDown(view, event) {
          if (!overlay.isOpen() || !active) return false;

          if (event.key === 'Escape') {
            event.preventDefault();
            closeAll();
            return true;
          }
          if (event.key === 'ArrowDown') {
            if (overlay.getItems().length === 0) return false;
            event.preventDefault();
            overlay.setSelected(overlay.getSelectedIndex() + 1);
            return true;
          }
          if (event.key === 'ArrowUp') {
            if (overlay.getItems().length === 0) return false;
            event.preventDefault();
            overlay.setSelected(overlay.getSelectedIndex() - 1);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const items = overlay.getItems();
            if (items.length === 0) return false;
            event.preventDefault();
            const item = items[overlay.getSelectedIndex()];
            if (!item) return false;
            applyPick(view, item);
            return true;
          }
          return false;
        },
      },
    });
  });
}
