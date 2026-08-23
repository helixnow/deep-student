import i18next from 'i18next';
import { type NoteItem } from "../../utils/notesApi";
import type { ReferenceNode } from "./types/reference";
import { deriveNoteTitleText } from "../../utils/notesTitle";

export { deriveNoteTitleText };

// ----------------------------------------------------------------------
// Tree Data Types
// （原 DndFileTree/types.ts，组件 2026-08 零挂载删除后类型迁至此处；
//   ReferenceNode 等引用类型仍以 ./types/reference 为唯一来源，勿在此重复定义）
// ----------------------------------------------------------------------

/**
 * 节点类型标识
 * - note: 笔记节点（原生）
 * - folder: 文件夹节点
 * - reference: 引用节点
 */
export type NodeType = 'note' | 'folder' | 'reference';

/**
 * 引用节点附加数据
 */
export interface ReferenceData {
    /** 引用节点信息 */
    referenceNode: ReferenceNode;
    /** 是否失效（原数据已删除） */
    isInvalid?: boolean;
    /** 是否正在校验中 */
    isValidating?: boolean;
}

export interface TreeNode {
    id: string;
    title: string;
    isFolder: boolean;
    children?: string[];
    data?: any;
    canMove?: boolean;
    canRename?: boolean;
    /** 节点类型（用于区分笔记/文件夹/引用） */
    nodeType?: NodeType;
    /** 引用节点数据（仅 nodeType='reference' 时存在） */
    referenceData?: ReferenceData;
}

export type TreeData = Record<string, TreeNode>;

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------

export interface TreeBuildParams {
    notes: NoteItem[];
    folders: Record<string, { title: string; children: string[] }>;
    rootChildren: string[];
    noteRootLabel: string;
    untitledLabel: string;
    sortMethod?: string;
}

// ----------------------------------------------------------------------
// Content Normalization
// ----------------------------------------------------------------------

/**
 * 归一化笔记原始内容供编辑器使用。
 *
 * 旧版笔记可能把 ProseMirror/Tiptap 的 JSON 文档直接存进 content 字段；
 * 此函数尝试把这类 JSON 抽取为纯文本（拼接所有 text 节点），
 * 无法解析或抽取结果为空时原样返回（trim 后）。
 *
 * @param raw 原始内容（可能为 markdown、JSON 文档或空）
 * @returns 可供 markdown 编辑器使用的文本
 */
export function normalizeContentForEditor(raw: string | undefined | null): string {
    const s = (raw ?? "").trim();
    if (!s) return "";
    if (s.startsWith("{") || s.startsWith("[")) {
        try {
            const v = JSON.parse(s);
            const parts: string[] = [];
            const visit = (node: any) => {
                // JSON 里可能出现 null / 原始值节点，跳过避免中断整棵树的抽取
                if (!node || typeof node !== "object") return;
                if (typeof node.text === "string" && node.text) parts.push(node.text);
                if (node.content && Array.isArray(node.content)) {
                    node.content.forEach(visit);
                }
            };
            if (Array.isArray(v)) {
                v.forEach(visit);
            } else if (v && typeof v === "object") {
                visit(v);
            }
            const out = parts
                .join("")
                .replace(/\n{3,}/g, "\n\n")
                .trim();
            return out || s;
        } catch {
            return s;
        }
    }
    return s;
}

// ----------------------------------------------------------------------
// Content Stats（字数 / 词数 / 阅读时间）
// ----------------------------------------------------------------------

/** 阅读速度基准：300 字（中文字符 + 英文单词合计）/ 分钟 */
export const NOTE_READING_UNITS_PER_MINUTE = 300;

/** CJK 统一表意文字 + 日文假名 + 兼容区（"中文按字"口径） */
const CJK_CHAR_RE = /[\u2E80-\u2EFF\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;

/** 拉丁词：字母数字连串，允许词内连字符/撇号（don't、state-of-the-art 记 1 词） */
const LATIN_WORD_RE = /[A-Za-z0-9]+(?:['’\u2019-][A-Za-z0-9]+)*/g;

export interface NoteContentStats {
    /** 非空白字符数（与编辑器既有 charCount 口径一致） */
    charCount: number;
    /** CJK 字符数 */
    cjkCharCount: number;
    /** 拉丁单词数 */
    latinWordCount: number;
    /** 词数 = CJK 按字 + 英文按词 */
    wordCount: number;
    /** 预计阅读分钟数（300 字/分，向上取整；空内容为 0） */
    readingMinutes: number;
}

/**
 * 由阅读单位数（中文字 + 英文词）估算阅读分钟数。
 * 空内容返回 0；非空内容至少 1 分钟。
 */
export function estimateReadingMinutes(units: number): number {
    if (!Number.isFinite(units) || units <= 0) return 0;
    return Math.max(1, Math.ceil(units / NOTE_READING_UNITS_PER_MINUTE));
}

/**
 * 统计笔记 markdown 的字数 / 词数 / 阅读时间。
 *
 * 口径：
 * - charCount：非空白字符数（与 NotesCrepeEditor.countNoteChars 一致）；
 * - wordCount：中文（CJK）按单字计，英文按单词计，两者相加；
 * - readingMinutes：wordCount / 300 向上取整，空内容为 0。
 *
 * 直接对原始 markdown 计数（不剥离语法标记），与既有字数统计行为保持一致，
 * 保证 header 上"N 字"与展开详情之间数字自洽。
 */
export function computeNoteStats(markdown: string | null | undefined): NoteContentStats {
    const source = markdown ?? '';
    if (!source) {
        return { charCount: 0, cjkCharCount: 0, latinWordCount: 0, wordCount: 0, readingMinutes: 0 };
    }

    const charCount = source.replace(/\s/g, '').length;
    const cjkCharCount = source.match(CJK_CHAR_RE)?.length ?? 0;
    const latinWordCount = source.match(LATIN_WORD_RE)?.length ?? 0;
    const wordCount = cjkCharCount + latinWordCount;

    return {
        charCount,
        cjkCharCount,
        latinWordCount,
        wordCount,
        readingMinutes: estimateReadingMinutes(wordCount),
    };
}

// ----------------------------------------------------------------------
// Tree Sorting
// ----------------------------------------------------------------------

/** 树排序方法（'manual' 表示保持持久化顺序，不在此函数处理） */
export type TreeSortMethod =
    | 'name_asc'
    | 'name_desc'
    | 'modified_desc'
    | 'modified_asc'
    | 'created_desc'
    | 'created_asc';

/**
 * 对一层树子节点排序（纯函数，返回新数组，不修改入参）。
 *
 * 规则：文件夹永远排在笔记前；同类内按 sortMethod 比较；
 * 节点缺失（items 中查不到）时视为相等，保持相对顺序。
 *
 * @param children 子节点 ID 列表
 * @param items 树节点映射
 * @param sortMethod 排序方法
 * @returns 排序后的新 ID 数组
 */
export const sortTreeChildren = (
    children: string[],
    items: TreeData,
    sortMethod: TreeSortMethod
): string[] => {
    return [...children].sort((aId, bId) => {
        const nodeA = items[aId];
        const nodeB = items[bId];
        if (!nodeA || !nodeB) return 0;

        // Folders always first
        if (nodeA.isFolder && !nodeB.isFolder) return -1;
        if (!nodeA.isFolder && nodeB.isFolder) return 1;

        let valA: any;
        let valB: any;

        switch (sortMethod) {
            case 'name_asc':
            case 'name_desc':
                valA = (nodeA.title || '').toLowerCase();
                valB = (nodeB.title || '').toLowerCase();
                break;
            case 'modified_desc':
            case 'modified_asc':
                valA = nodeA.data?.note?.updated_at || 0;
                valB = nodeB.data?.note?.updated_at || 0;
                break;
            case 'created_desc':
            case 'created_asc':
                valA = nodeA.data?.note?.created_at || 0;
                valB = nodeB.data?.note?.created_at || 0;
                break;
        }

        let result = 0;
        if (valA < valB) result = -1;
        else if (valA > valB) result = 1;

        if (sortMethod.endsWith('_desc')) {
            result *= -1;
        }

        return result;
    });
};

// ----------------------------------------------------------------------
// Path Helper
// ----------------------------------------------------------------------

/**
 * 计算从根到指定节点的面包屑路径（NotesEditorHeader / 侧栏依赖）。
 *
 * 支持传入笔记 ID 或文件夹 ID；未找到时返回空数组（调用方可安全 map）。
 *
 * 健壮性保障：
 * - 空白标题回退到「未命名」文案（与 buildTreeData 的 trim 语义一致）；
 * - 用 visited 集合防御文件夹环引用（坏数据下不会产生重复段或死循环），
 *   并保留 MAX_DEPTH 作为二级保险；
 * - 一个节点出现在多个文件夹 children 中时，取遍历到的第一个父级（既有语义）。
 *
 * @param noteId 笔记或文件夹 ID
 * @param folders 文件夹映射（fld_xxx -> { title, children }）
 * @param notes 全量笔记列表
 * @returns 从根到该节点的路径段数组（含节点自身）
 */
export const getPathToNote = (
    noteId: string,
    folders: Record<string, { title: string; children: string[] }>,
    notes: NoteItem[]
): { id: string; title: string; type: 'folder' | 'note' }[] => {
    const path: { id: string; title: string; type: 'folder' | 'note' }[] = [];
    if (!noteId || !folders || !notes) return path;

    // Check if it's a note
    const note = notes.find(n => n.id === noteId);
    if (note) {
        const title = (note.title ?? '').trim() || i18next.t('notes:common.untitled');
        path.unshift({ id: note.id, title, type: 'note' });
    } else if (folders[noteId]) {
        // Or if it's a folder
        const title = (folders[noteId].title ?? '').trim() || i18next.t('notes:common.untitled');
        path.unshift({ id: noteId, title, type: 'folder' });
    } else {
        return path;
    }

    // 预构建 child -> parent 映射（一次 O(F) 扫描替代逐层全表扫描）。
    // 一个节点出现在多个文件夹 children 中时，保留遍历到的第一个父级（既有语义）。
    const parentOf = new Map<string, string>();
    for (const [folderId, folder] of Object.entries(folders)) {
        for (const childId of folder.children ?? []) {
            if (!parentOf.has(childId)) {
                parentOf.set(childId, folderId);
            }
        }
    }

    // Find parents recursively
    let currentId = noteId;

    // 防环：记录已经进入路径的文件夹；深度上限作为二级保险
    const visited = new Set<string>([noteId]);
    let depth = 0;
    const MAX_DEPTH = 20;

    while (depth < MAX_DEPTH) {
        const parentId = parentOf.get(currentId);
        if (!parentId || !folders[parentId]) break;
        if (visited.has(parentId)) {
            // 环引用（坏数据）：终止向上回溯，保留已构建的路径
            console.warn('[notes] getPathToNote detected circular folder reference', {
                folderId: parentId,
                noteId,
            });
            return path;
        }
        visited.add(parentId);
        const title = (folders[parentId].title ?? '').trim() || i18next.t('notes:common.untitled');
        path.unshift({ id: parentId, title, type: 'folder' });
        currentId = parentId;
        depth++;
    }

    return path;
};

// ----------------------------------------------------------------------
// Tree Building (Standard Notes)
// ----------------------------------------------------------------------

/**
 * 从笔记列表 + 文件夹结构构建文件树数据（TreeData）。
 *
 * 行为要点：
 * - 顶层顺序优先采用持久化的 rootChildren，缺失项按标题字典序补齐；
 * - 环状文件夹引用会被检测并跳过（console.warn），不会死循环；
 * - sortMethod 非 'manual' 时对根与所有文件夹递归排序（见 sortTreeChildren）。
 *
 * @param params 构建参数（见 TreeBuildParams）
 * @returns 树数据映射 TreeData（含 root 节点）
 */
export const buildTreeData = ({
    notes,
    folders,
    rootChildren,
    noteRootLabel,
    untitledLabel,
    sortMethod = 'manual',
}: TreeBuildParams): TreeData => {
    const items: TreeData = {
        root: {
            id: "root",
            title: noteRootLabel,
            isFolder: true,
            canMove: false,
            canRename: false,
            children: [],
            data: { parentId: null },
        },
    };

    // 1. Identify top-level folders
    const folderChildrenRef = new Set<string>();
    Object.values(folders).forEach((folder) =>
        (folder.children || []).forEach((childId) => {
            if (childId.startsWith("fld_")) folderChildrenRef.add(childId);
        }),
    );
    const topFolderIds = Object.keys(folders).filter(
        (fid) => !folderChildrenRef.has(fid),
    );

    const noteMap: Record<string, NoteItem> = Object.fromEntries(
        notes.map((n) => [n.id, n]),
    );
    const visitedFolders = new Set<string>();

    // Recursive folder builder
    const appendFolderRecursive = (
        folderId: string,
        parentId: string,
        trail: string[] = [],
    ) => {
        const folder = folders[folderId];
        if (!folder) return;
        if (visitedFolders.has(folderId)) {
            console.warn("[notes] detected circular folder reference", {
                path: [...trail, folderId],
            });
            return;
        }
        visitedFolders.add(folderId);
        items[folderId] = {
            id: folderId,
            title: folder.title,
            isFolder: true,
            children: [],
            canMove: true,
            canRename: true,
            data: { parentId },
        };
        for (const childId of folder.children || []) {
            if (childId.startsWith("fld_") && folders[childId]) {
                items[folderId].children!.push(childId);
                appendFolderRecursive(childId, folderId, [...trail, folderId]);
            } else if (noteMap[childId]) {
                items[childId] = {
                    id: childId,
                    title: (noteMap[childId].title ?? "").trim() || untitledLabel,
                    isFolder: false,
                    children: [],
                    canMove: true,
                    canRename: true,
                    data: { note: noteMap[childId], parentId: folderId },
                };
                items[folderId].children!.push(childId);
            }
        }
    };

    // Identify loose notes (not in any folder)
    const looseNotes = notes.filter(
        (n) =>
            !Object.values(folders).some((folder) => (folder.children || []).includes(n.id)),
    );

    // Build root order
    const rootSet = new Set<string>([
        ...topFolderIds,
        ...looseNotes.map((n) => n.id),
    ]);

    const persistedOrder = (rootChildren || []).filter((id) => rootSet.has(id));

    const missingFolders = topFolderIds
        .filter((id) => !persistedOrder.includes(id))
        .sort((a, b) =>
            (folders[a].title || "").localeCompare(folders[b].title || ""),
        );
    const missingNotes = looseNotes
        .map((n) => n.id)
        .filter((id) => !persistedOrder.includes(id))
        .sort((a, b) =>
            (noteMap[a].title || "").localeCompare(noteMap[b].title || ""),
        );

    const finalRootOrder = [
        ...persistedOrder,
        ...missingFolders,
        ...missingNotes,
    ];

    // Build the tree
    for (const fid of topFolderIds) {
        appendFolderRecursive(fid, 'root');
    }
    for (const n of looseNotes) {
        items[n.id] = {
            id: n.id,
            title: (n.title ?? "").trim() || untitledLabel,
            isFolder: false,
            children: [],
            canMove: true,
            canRename: true,
            data: { note: n, parentId: 'root' },
        };
    }
    items.root.children = finalRootOrder;

    // Apply sorting
    if (sortMethod && sortMethod !== 'manual') {
        const sm = sortMethod as any;
        if (items.root.children && items.root.children.length > 0) {
            items.root.children = sortTreeChildren(items.root.children, items, sm);
        }

        const sortFolderChildren = (folderId: string) => {
            const folder = items[folderId];
            if (folder && folder.isFolder && folder.children && folder.children.length > 0) {
                folder.children = sortTreeChildren(folder.children, items, sm);
                folder.children.forEach(childId => {
                    const child = items[childId];
                    if (child && child.isFolder) {
                        sortFolderChildren(childId);
                    }
                });
            }
        };

        topFolderIds.forEach(fid => sortFolderChildren(fid));
    }

    return items;
};
