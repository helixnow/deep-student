import i18next from 'i18next';
import { type NoteItem } from "../../utils/notesApi";
import type { TreeData } from "./DndFileTree";
// ★ 图谱模块已废弃 - 本地占位类型
type TagHierarchy = { tag: { id: string; name: string }; children?: TagHierarchy[] };
type ProblemCard = { id: string; content_problem: string; content_insight?: string; title?: string; tags?: string[]; notes?: string };
import { deriveNoteTitleText } from "../../utils/notesTitle";

export { deriveNoteTitleText };

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

export function normalizeContentForEditor(raw: string | undefined | null): string {
    const s = (raw ?? "").trim();
    if (!s) return "";
    if (s.startsWith("{") || s.startsWith("[")) {
        try {
            const v = JSON.parse(s);
            const parts: string[] = [];
            const visit = (node: any) => {
                if (node.text) parts.push(node.text);
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
// Tree Sorting
// ----------------------------------------------------------------------

export const sortTreeChildren = (
    children: string[],
    items: TreeData,
    sortMethod: 'name_asc' | 'name_desc' | 'modified_desc' | 'modified_asc' | 'created_desc' | 'created_asc'
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

export const getPathToNote = (
    noteId: string,
    folders: Record<string, { title: string; children: string[] }>,
    notes: NoteItem[]
): { id: string; title: string; type: 'folder' | 'note' }[] => {
    const path: { id: string; title: string; type: 'folder' | 'note' }[] = [];
    
    // Check if it's a note
    const note = notes.find(n => n.id === noteId);
    if (note) {
        path.unshift({ id: note.id, title: note.title || i18next.t('notes:common.untitled', 'Untitled'), type: 'note' });
    } else if (folders[noteId]) {
        // Or if it's a folder
        path.unshift({ id: noteId, title: folders[noteId].title, type: 'folder' });
    } else {
        return path;
    }

    // Find parents recursively
    let currentId = noteId;
    let foundParent = true;
    
    // Prevent infinite loops with a max depth
    let depth = 0;
    const MAX_DEPTH = 20;

    while (foundParent && depth < MAX_DEPTH) {
        foundParent = false;
        // Search in all folders to see who has currentId as child
        for (const [folderId, folder] of Object.entries(folders)) {
            if (folder.children.includes(currentId)) {
                path.unshift({ id: folderId, title: folder.title, type: 'folder' });
                currentId = folderId;
                foundParent = true;
                break;
            }
        }
        depth++;
    }

    return path;
};

// ----------------------------------------------------------------------
// Tree Building (Standard Notes)
// ----------------------------------------------------------------------

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

// ----------------------------------------------------------------------
// Tree Building (Graph Notes)
// ----------------------------------------------------------------------

export const buildGraphTreeData = (
    hierarchy: TagHierarchy[],
    cards: ProblemCard[],
    sortMethod?: string,
    uncategorizedLabel: string = 'Uncategorized',
): TreeData => {
    const items: TreeData = {
        root: {
            id: 'root',
            title: i18next.t('notes:graph_notes.root_title', 'Graph Notes Root'),
            isFolder: true,
            children: [],
            canMove: false,
            canRename: false,
            data: {},
        },
    };

    // 1. Build hierarchy based tags
    const processedCardIds = new Set<string>();

    const buildTagNode = (th: TagHierarchy, parentId: string): string => {
        const tagId = `tag_${th.tag.id}`;
        items[tagId] = {
            id: tagId,
            title: th.tag.name,
            isFolder: true,
            children: [],
            canMove: false,
            canRename: false, // Tags renaming should be done via graph management
            data: { tag: th.tag, parentId },
        };

        for (const child of th.children || []) {
            const childId = buildTagNode(child, tagId);
            items[tagId].children!.push(childId);
        }

        const tagCards = cards.filter(card =>
            card.tags && card.tags.includes(th.tag.id)
        );
        for (const card of tagCards) {
            const cardId = card.id;
            
            // For graph view, we might want to see the note under multiple tags
            // But DndFileTree requires unique IDs. 
            // We use a composite ID: noteId_tagId to allow duplicates in tree but unique keys
            const treeId = `${cardId}__${th.tag.id}`;
            
            if (items[treeId]) continue;

            items[treeId] = {
                id: treeId,
                title: deriveNoteTitleText(card.notes, card.content_problem) || i18next.t('notes:common.untitledNote', 'Untitled note'),
                isFolder: false,
                children: [],
                canMove: true,
                canRename: true,
                data: { graphCard: card, parentId: tagId, originalId: cardId },
            };
            items[tagId].children!.push(treeId);
            processedCardIds.add(cardId);
        }

        return tagId;
    };

    for (const th of hierarchy) {
        const tagId = buildTagNode(th, 'root');
        items.root.children!.push(tagId);
    }

    // 2. Handle Uncategorized Notes
    const uncategorizedCards = cards.filter(c => !processedCardIds.has(c.id));
    if (uncategorizedCards.length > 0) {
        const uncategorizedId = 'uncategorized_root';
        items[uncategorizedId] = {
            id: uncategorizedId,
            title: uncategorizedLabel,
            isFolder: true,
            children: [],
            canMove: false,
            canRename: false,
            data: { parentId: 'root', isUncategorized: true },
        };
        items.root.children!.push(uncategorizedId);

        for (const card of uncategorizedCards) {
            // For uncategorized, treeId can just be cardId as it appears once
            // But to be consistent and safe, we can prefix or just use cardId if no conflict
            // Since these cards are NOT in processedCardIds, they haven't been added yet.
            // However, if we use composite IDs above, we need to be careful.
            // Let's use cardId for simplicity here, as it won't conflict with `${cardId}__${tagId}`
            const treeId = card.id;
            
            items[treeId] = {
                id: treeId,
                title: deriveNoteTitleText(card.notes, card.content_problem) || i18next.t('notes:common.untitledNote', 'Untitled note'),
                isFolder: false,
                children: [],
                canMove: true,
                canRename: true,
                data: { graphCard: card, parentId: uncategorizedId, originalId: card.id },
            };
            items[uncategorizedId].children!.push(treeId);
        }
    }

    if (sortMethod && sortMethod !== 'manual') {
        const sortChildren = (nodeId: string) => {
            const node = items[nodeId];
            if (node && node.children) {
                node.children.sort((a, b) => {
                    const nodeA = items[a];
                    const nodeB = items[b];
                    return (nodeA.title || '').localeCompare(nodeB.title || '');
                });
                node.children.forEach(sortChildren);
            }
        };
        sortChildren('root');
    }

    return items;
};
