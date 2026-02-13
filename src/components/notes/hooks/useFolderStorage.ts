import { useState, useCallback, useRef, useEffect } from 'react';
import { nanoid } from 'nanoid';
import { NotesAPI, type NoteItem } from '../../../utils/notesApi';
import { batchValidateReferences as batchValidateViaApi } from '../learningHubApi';
import {
  type ReferenceNode,
  type SourceDatabase,
  type PreviewType,
  generateRefId,
  isReferenceId,
  createReferenceNode,
  isValidReferenceNode,
  REFERENCE_ID_PREFIX,
} from '../types/reference';

export interface FolderStructure {
    folders: Record<string, { title: string; children: string[] }>;
    rootChildren: string[];
    /** ★ 新增：引用节点映射 ref_xxx -> ReferenceNode，可选以兼容旧数据 */
    references?: Record<string, ReferenceNode>;
}

/**
 * 添加引用的参数（不含 createdAt）
 */
export type AddReferenceParams = Omit<ReferenceNode, 'createdAt'>;

/**
 * 引用校验结果
 */
export interface ReferenceValidateResult {
    sourceDb: string;
    sourceId: string;
    valid: boolean;
}

// 重新导出 ReferenceNode 类型以便外部使用
export type { ReferenceNode } from '../types/reference';

export function useFolderStorage(notes: NoteItem[], setNotes: React.Dispatch<React.SetStateAction<NoteItem[]>>) {
    const [folders, setFolders] = useState<Record<string, { title: string; children: string[] }>>({});
    const [rootChildren, setRootChildren] = useState<string[]>([]);
    // ★ 新增：引用节点状态
    const [references, setReferences] = useState<Record<string, ReferenceNode>>({});
    // ★ 修复闭包过期：使用 useRef 始终追踪最新 references
    const referencesRef = useRef(references);
    useEffect(() => { referencesRef.current = references; }, [references]);

    // ★ 扩展：保存时包含 references
    const saveStructureToPref = useCallback(async (
        newFolders: Record<string, { title: string; children: string[] }>,
        newRootChildren: string[],
        newReferences: Record<string, ReferenceNode>
    ) => {
        try {
            const data = JSON.stringify({
                folders: newFolders,
                rootChildren: newRootChildren,
                references: newReferences
            });
            await NotesAPI.setPref('notes_folders', data);
        } catch (e) {
            console.error("Failed to save folders pref", e);
        }
    }, []);

    // 保持旧的 saveFoldersToPref 兼容性（内部使用，通过 ref 获取最新 references）
    const saveFoldersToPref = useCallback(async (newFolders: any, newRootChildren: any) => {
        await saveStructureToPref(newFolders, newRootChildren, referencesRef.current);
    }, [saveStructureToPref]);

    const createFolder = useCallback(async (parentId?: string, t?: (key: string) => string) => {
        const id = `fld_${nanoid(8)}`;
        const title = t ? t('notes:sidebar.actions.new_folder') : 'New Folder';
        const newFolder = { title, children: [] };
        
        let newFolders = { ...folders, [id]: newFolder };
        let newRoot = [...rootChildren];

        if (parentId && newFolders[parentId]) {
            newFolders[parentId] = {
                ...newFolders[parentId],
                children: [...newFolders[parentId].children, id]
            };
        } else {
            newRoot = [...newRoot, id];
        }

        setFolders(newFolders);
        setRootChildren(newRoot);
        saveFoldersToPref(newFolders, newRoot);
        return id;
    }, [folders, rootChildren, saveFoldersToPref]);

    const addToStructure = useCallback((noteId: string, parentId?: string) => {
        let newFolders = { ...folders };
        let newRoot = [...rootChildren];

        if (parentId && folders[parentId]) {
            newFolders[parentId] = {
                ...newFolders[parentId],
                children: [...newFolders[parentId].children, noteId]
            };
        } else {
            newRoot = [...newRoot, noteId];
        }
        
        setFolders(newFolders);
        setRootChildren(newRoot);
        saveFoldersToPref(newFolders, newRoot);
    }, [folders, rootChildren, saveFoldersToPref]);

    const removeFromStructure = useCallback((ids: string[]) => {
        // Separate folders and notes logic handled in parent usually, but here we just remove IDs from structure
        let newFolders = { ...folders };
        let newRoot = [...rootChildren];
        let newReferences = { ...references };

        // We need to remove these IDs from their parents
        // And if any ID is a folder, we remove the folder entry (and maybe move its children to root?)
        
        // For simplicity, we iterate all folders to find parents
        // Ideally we'd have a parent map
        
        // Remove from children arrays
        const removeId = (id: string) => {
            if (newRoot.includes(id)) {
                newRoot = newRoot.filter(c => c !== id);
            }
            Object.keys(newFolders).forEach(fid => {
                if (newFolders[fid].children.includes(id)) {
                    newFolders[fid] = {
                        ...newFolders[fid],
                        children: newFolders[fid].children.filter(c => c !== id)
                    };
                }
            });
        };

        ids.forEach(id => {
            removeId(id);
            
            // If it is a folder, delete the folder object
            if (newFolders[id]) {
                // Move children to root to prevent data loss (orphaned notes)
                const children = newFolders[id].children;
                newRoot.push(...children);
                delete newFolders[id];
            }
            
            // ★ 新增：如果是引用节点，从 references 中删除
            if (isReferenceId(id) && newReferences[id]) {
                delete newReferences[id];
            }
        });

        setFolders(newFolders);
        setRootChildren(newRoot);
        setReferences(newReferences);
        saveStructureToPref(newFolders, newRoot, newReferences);
        
        return { newFolders, newRoot, newReferences };
    }, [folders, rootChildren, references, saveStructureToPref]);

    const moveItem = useCallback(async (dragIds: string[], parentId: string | null, index: number) => {
        let newFolders = { ...folders };
        let newRoot = [...rootChildren];

        // 1. Remove all dragIds from their current parents
        dragIds.forEach(id => {
            // Check root
            if (newRoot.includes(id)) {
                newRoot = newRoot.filter(c => c !== id);
            }
            // Check folders
            Object.keys(newFolders).forEach(fid => {
                if (newFolders[fid].children.includes(id)) {
                    newFolders[fid] = {
                        ...newFolders[fid],
                        children: newFolders[fid].children.filter(c => c !== id)
                    };
                }
            });
        });

        // 2. Insert into new parent
        if (parentId && newFolders[parentId]) {
            const targetChildren = [...newFolders[parentId].children];
            // Insert at index (clamped)
            const insertIdx = Math.min(Math.max(0, index), targetChildren.length);
            targetChildren.splice(insertIdx, 0, ...dragIds);
            newFolders[parentId] = { ...newFolders[parentId], children: targetChildren };
        } else {
            // Insert into root
            const insertIdx = Math.min(Math.max(0, index), newRoot.length);
            newRoot.splice(insertIdx, 0, ...dragIds);
        }

        setFolders(newFolders);
        setRootChildren(newRoot);
        saveFoldersToPref(newFolders, newRoot);
    }, [folders, rootChildren, saveFoldersToPref]);

    const renameFolder = useCallback((id: string, newName: string) => {
        if (folders[id]) {
            const newFolders = { ...folders };
            newFolders[id] = { ...newFolders[id], title: newName };
            setFolders(newFolders);
            saveFoldersToPref(newFolders, rootChildren);
        }
    }, [folders, rootChildren, saveFoldersToPref]);

    const loadFolders = useCallback(async (noteItems: NoteItem[]) => {
        try {
            const pref = await NotesAPI.getPref('notes_folders');
            if (pref) {
                const parsed = JSON.parse(pref);
                const loadedFolders = parsed.folders || {};
                const loadedRoot = parsed.rootChildren || [];
                // ★ 新增：加载 references（旧数据无此字段时自动初始化为 {}）
                const loadedReferences: Record<string, ReferenceNode> = parsed.references || {};
                
                // Cleanup: Remove IDs that don't exist in notes
                const noteIds = new Set(noteItems.map(n => n.id));
                const cleanFolders = { ...loadedFolders };
                
                // ★ 新增：引用 ID 集合
                const refIds = new Set(Object.keys(loadedReferences));
                
                // 扩展过滤逻辑：笔记 ID、文件夹 ID、引用 ID 都保留
                let cleanRoot = loadedRoot.filter((id: string) => 
                    noteIds.has(id) || cleanFolders[id] || refIds.has(id)
                );
                
                // Also clean children of folders（扩展：支持引用 ID）
                Object.keys(cleanFolders).forEach(fid => {
                    if (cleanFolders[fid].children) {
                        cleanFolders[fid].children = cleanFolders[fid].children.filter((cid: string) => 
                            noteIds.has(cid) || cleanFolders[cid] || refIds.has(cid)
                        );
                    }
                });

                setFolders(cleanFolders);
                setRootChildren(cleanRoot);
                setReferences(loadedReferences);
            } else {
                setFolders({});
                setRootChildren([]);
                setReferences({});
            }
        } catch (e) {
            console.error("Failed to load folders", e);
            setFolders({});
            setRootChildren([]);
            setReferences({});
        }
    }, []);

    // ============================================================================
    // ★ 引用管理方法
    // ============================================================================

    /**
     * 添加引用节点
     * @param params 引用参数（不含 createdAt）
     * @param parentId 父文件夹 ID（可选，不传则添加到根级别）
     * @returns 生成的引用 ID
     * @throws 如果同科目下已存在相同 (sourceDb, sourceId) 的引用
     */
    const addReference = useCallback((params: AddReferenceParams, parentId?: string): string => {
        // 约束1：检查同科目下 (sourceDb, sourceId) 唯一性
        const existingRefId = Object.entries(references).find(
            ([_, ref]) => ref.sourceDb === params.sourceDb && ref.sourceId === params.sourceId
        )?.[0];
        
        if (existingRefId) {
            console.warn(`Reference already exists for (${params.sourceDb}, ${params.sourceId}): ${existingRefId}`);
            // 返回已存在的引用 ID，而不是抛出错误（更友好的处理方式）
            return existingRefId;
        }

        const refId = generateRefId();
        const newRef: ReferenceNode = {
            ...params,
            createdAt: Date.now(),
        };

        // 更新引用映射
        const newReferences = { ...references, [refId]: newRef };
        
        // 更新结构（添加到文件夹或根级别）
        let newFolders = { ...folders };
        let newRoot = [...rootChildren];
        
        if (parentId && folders[parentId]) {
            newFolders[parentId] = {
                ...newFolders[parentId],
                children: [...newFolders[parentId].children, refId]
            };
        } else {
            newRoot = [...newRoot, refId];
        }

        setReferences(newReferences);
        setFolders(newFolders);
        setRootChildren(newRoot);
        saveStructureToPref(newFolders, newRoot, newReferences);
        
        return refId;
    }, [references, folders, rootChildren, saveStructureToPref]);

    /**
     * 移除引用节点
     * @param refId 引用 ID
     */
    const removeReference = useCallback((refId: string): void => {
        if (!isReferenceId(refId) || !references[refId]) {
            console.warn(`Invalid reference ID: ${refId}`);
            return;
        }

        // 从引用映射中移除
        const newReferences = { ...references };
        delete newReferences[refId];

        // 从结构中移除
        let newFolders = { ...folders };
        let newRoot = rootChildren.filter(id => id !== refId);
        
        // 从所有文件夹的 children 中移除
        Object.keys(newFolders).forEach(fid => {
            if (newFolders[fid].children.includes(refId)) {
                newFolders[fid] = {
                    ...newFolders[fid],
                    children: newFolders[fid].children.filter(c => c !== refId)
                };
            }
        });

        setReferences(newReferences);
        setFolders(newFolders);
        setRootChildren(newRoot);
        saveStructureToPref(newFolders, newRoot, newReferences);
    }, [references, folders, rootChildren, saveStructureToPref]);

    /**
     * 获取引用节点
     * @param refId 引用 ID
     * @returns 引用节点或 undefined
     */
    const getReference = useCallback((refId: string): ReferenceNode | undefined => {
        return references[refId];
    }, [references]);

    /**
     * 检查引用是否存在（按 refId）
     * @param refId 引用 ID
     * @returns 是否存在
     */
    const referenceExistsById = useCallback((refId: string): boolean => {
        return refId in references;
    }, [references]);

    /**
     * 检查是否已存在相同来源的引用（同 sourceDb + sourceId）
     * 符合文档19约束：用于唯一性检查
     * @param sourceDb 来源数据库
     * @param sourceId 来源 ID
     * @returns 是否已存在
     */
    const referenceExists = useCallback((sourceDb: string, sourceId: string): boolean => {
        return Object.values(references).some(
            ref => ref.sourceDb === sourceDb && ref.sourceId === sourceId
        );
    }, [references]);

    /**
     * 获取所有引用列表
     * 符合文档19签名：返回 Array<{ id: string } & ReferenceNode>
     * @returns 包含 id 字段的引用数组
     */
    const listReferences = useCallback((): Array<{ id: string } & ReferenceNode> => {
        return Object.entries(references).map(([id, ref]) => ({ id, ...ref }));
    }, [references]);

    /**
     * 根据来源筛选引用
     * @param sourceDb 来源数据库
     * @returns 匹配的引用数组
     */
    const getRefsBySource = useCallback((sourceDb: SourceDatabase): [string, ReferenceNode][] => {
        return Object.entries(references).filter(([_, ref]) => ref.sourceDb === sourceDb);
    }, [references]);

    /**
     * 更新引用节点（仅允许更新 title, icon）
     * @param refId 引用 ID
     * @param updates 更新内容
     */
    const updateReference = useCallback((
        refId: string,
        updates: Partial<Pick<ReferenceNode, 'title' | 'icon'>>
    ): void => {
        if (!references[refId]) {
            console.warn(`Reference not found: ${refId}`);
            return;
        }

        const newReferences = {
            ...references,
            [refId]: {
                ...references[refId],
                ...updates
            }
        };

        setReferences(newReferences);
        saveStructureToPref(folders, rootChildren, newReferences);
    }, [references, folders, rootChildren, saveStructureToPref]);

    /**
     * 检查是否已存在相同来源的引用（避免重复添加）
     * @param sourceDb 来源数据库
     * @param sourceId 来源 ID
     * @returns 已存在的引用 ID 或 null
     */
    const findExistingRef = useCallback((sourceDb: SourceDatabase, sourceId: string): string | null => {
        const entry = Object.entries(references).find(
            ([_, ref]) => ref.sourceDb === sourceDb && ref.sourceId === sourceId
        );
        return entry ? entry[0] : null;
    }, [references]);

    /**
     * 校验引用有效性（批量，异步）
     * 
     * 改造说明（Prompt D）：
     * - 原使用 `learning_hub_batch_validate` 命令已废弃
     * - 现改用 DSTU API (learningHubApi.batchValidateReferences) 校验
     * 
     * @returns 每个引用 ID 的有效性状态
     */
    const validateReferences = useCallback(async (): Promise<Record<string, boolean>> => {
        const refList = Object.entries(references);
        if (refList.length === 0) {
            return {};
        }

        try {
            // 构建批量校验请求
            const refs = refList.map(([_, ref]) => ({
                sourceDb: ref.sourceDb,
                sourceId: ref.sourceId,
            }));

            // 通过 DSTU API 批量校验
            const results = await batchValidateViaApi(refs);

            // 构建结果映射
            const validityMap: Record<string, boolean> = {};
            refList.forEach(([refId, ref]) => {
                const result = results.find(
                    r => r.sourceDb === ref.sourceDb && r.sourceId === ref.sourceId
                );
                validityMap[refId] = result?.valid ?? false;
            });

            return validityMap;
        } catch (error) {
            console.error('[useFolderStorage] Failed to validate references via DSTU:', error);
            // 校验失败时，默认所有引用为有效（避免误删）
            const validityMap: Record<string, boolean> = {};
            refList.forEach(([refId]) => {
                validityMap[refId] = true;
            });
            return validityMap;
        }
    }, [references]);

    return {
        // 现有状态和方法
        folders,
        rootChildren,
        setFolders,
        setRootChildren,
        createFolder,
        addToStructure,
        removeFromStructure,
        moveItem,
        renameFolder,
        loadFolders,
        
        // ★ 新增：引用状态
        references,
        setReferences,
        
        // ★ 新增：引用管理方法
        addReference,
        removeReference,
        updateReference,
        getReference,
        listReferences,
        referenceExists,
        referenceExistsById,
        validateReferences,
        findExistingRef,
    };
}
