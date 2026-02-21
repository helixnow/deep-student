import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { CrepeEditorApi } from "../crepe/types";
import type { NoteItem } from "../../utils/notesApi";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
// ★ DSTU API 导入 (Prompt 8)
import { dstu, pathUtils } from "@/dstu";
import type { DstuNode } from "@/dstu/types";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { showGlobalNotification } from "../UnifiedNotification";
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { useFolderStorage, type ReferenceNode } from "./hooks/useFolderStorage";
import { Result, VfsError, reportError, ok, err } from '@/shared/result';
import { debugLog } from '../../debug-panel/debugMasterSwitch';
// Canvas 智能笔记类型（原从 ./canvas/types 导入，白板功能移除后内联定义）
export type CanvasAIStatus = 'idle' | 'thinking' | 'writing' | 'error';
export interface CanvasNoteMetadata {
    id: string;
    title: string;
    wordCount: number;
    structure: string[];
    summary: string;
    updatedAt: string;
}
export interface CanvasModeState {
    activeNoteId: string | null;
    activeNoteTitle: string | null;
    activeNoteContent: string | null;
    wordCount: number;
    structure: string[];
    summary: string | null;
    updatedAt: string | null;
    noteHistory: string[];
}
import { type PreviewType, type SourceDatabase, getSourceDbPreviewType } from "./types/reference";
// Prompt 10: 引用有效性校验
import { useReferenceValidation, type UseReferenceValidationReturn } from "./hooks/useReferenceValidation";
// Learning Hub - 引用到对话 (Prompt 9)
import type { ContextRef } from "@/chat-v2/resources/types";
import { sessionManager } from "@/chat-v2/core/session";
import { NOTE_TYPE_ID } from "@/chat-v2/context/definitions/note";
import { TEXTBOOK_TYPE_ID } from "@/chat-v2/context/definitions/textbook";
import { EXAM_TYPE_ID } from "@/chat-v2/context/definitions/exam";
// 统一资源库修复：使用同步服务（写入 resources.db）
import { 
    syncNote, 
    syncExam, 
    syncTextbookPages, 
    createResource,
    type SyncResult 
} from "@/services/resourceSyncService";

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// ★ DSTU 兼容层 (Prompt 8)
// ============================================================================

/**
 * 将 DstuNode 转换为 NoteItem（兼容层）
 */
function dstuNodeToNoteItem(node: DstuNode): NoteItem {
    return {
        id: node.id,
        title: node.name,
        content_md: '', // 内容需要单独加载
        tags: (node.metadata?.tags as string[]) || [],
        created_at: new Date(node.createdAt).toISOString(),
        updated_at: new Date(node.updatedAt).toISOString(),
        is_favorite: (node.metadata?.isFavorite as boolean) || false,
    };
}

// ============================================================================
// 学习资源管理器 - 内容获取结果类型
// ============================================================================

/**
 * 学习资源内容（从后端获取）
 */
export interface LearningHubContent {
    /** 来源数据库 */
    sourceDb: SourceDatabase;
    /** 来源 ID */
    sourceId: string;
    /** 内容类型 */
    contentType: 'markdown' | 'html' | 'json' | 'binary';
    /** 内容（文本或 base64） */
    content: string;
    /** 元数据 */
    metadata?: Record<string, unknown>;
}

interface NotesContextType {
    // State
    notes: NoteItem[];
    folders: Record<string, { title: string; children: string[] }>;
    rootChildren: string[];
    loading: boolean;
    active: NoteItem | null;
    loadedContentIds: Set<string>;

    // Tabs State
    openTabs: string[]; // Array of Note IDs
    activeTabId: string | null;

    // Dialogs State
    trashOpen: boolean;
    libraryOpen: boolean;

    // Search State
    searchQuery: string;
    searchResults: Array<{ id: string; title: string; snippet?: string }>;
    isSearching: boolean;
    searchError: string | null;
    setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
    performSearch: (query: string, tags?: string[]) => Promise<void>;
    renameTagAcrossNotes: (oldName: string, newName: string, skipId?: string) => Promise<number>;
    
    // Sidebar Control
    sidebarRevealId: string | null;
    setSidebarRevealId: React.Dispatch<React.SetStateAction<string | null>>;

    // AI Assistant State
    isAssistantOpen: boolean;
    setAssistantOpen: React.Dispatch<React.SetStateAction<boolean>>;
    assistantInitialMode: 'chat' | 'selection';
    setAssistantInitialMode: React.Dispatch<React.SetStateAction<'chat' | 'selection'>>;

    // Actions
    setNotes: React.Dispatch<React.SetStateAction<NoteItem[]>>;
    setActive: React.Dispatch<React.SetStateAction<NoteItem | null>>;
    setTrashOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setLibraryOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setEditor: React.Dispatch<React.SetStateAction<CrepeEditorApi | null>>;

    // CRUD Actions
    createNote: (parentId?: string) => Promise<string | null>;
    createFolder: (parentId?: string) => Promise<string | null>;
    deleteItems: (ids: string[]) => Promise<void>;
    renameItem: (id: string, newName: string) => Promise<void>;
    moveItem: (dragIds: string[], parentId: string | null, index: number) => Promise<void>;
    saveNoteContent: (id: string, content: string, title?: string) => Promise<void>;
    updateNoteTags: (id: string, tags: string[]) => Promise<void>;
    toggleFavorite: (id: string) => Promise<void>;

    // Tab Actions
    openTab: (noteId: string) => void;
    closeTab: (noteId: string) => void;
    activateTab: (noteId: string) => void;
    reorderTabs: (newOrder: string[]) => void;

    // Utils
    notify: (props: { title?: string; description?: string; variant?: "success" | "destructive" | "default" | "warning" }) => void;
    refreshNotes: () => Promise<void>;
    ensureNoteContent: (noteId: string) => Promise<void>;
    forceRefreshNoteContent: (noteId: string) => Promise<void>;

    // Editor bridge
    editor: CrepeEditorApi | null;

    editorPortalNoteId: string | null;
    requestEditorPortal: (noteId: string, target: HTMLElement) => void;
    releaseEditorPortal: (noteId: string) => void;

    // ========== Canvas 智能笔记扩展（Chat V2） ==========
    
    /** Canvas 侧边栏是否打开 */
    canvasSidebarOpen: boolean;
    
    /** Canvas 当前绑定的笔记 ID */
    canvasNoteId: string | null;
    
    /** Canvas 笔记历史列表（按访问时间倒序，最多 10 个） */
    canvasNoteHistory: string[];
    
    /** AI 操作状态 */
    canvasAIStatus: CanvasAIStatus;
    
    /** 切换 Canvas 侧边栏 */
    toggleCanvasSidebar: () => void;
    
    /** 打开 Canvas 并指定笔记 */
    openCanvasWithNote: (noteId: string) => void;
    
    /** 创建新笔记并在 Canvas 中打开 */
    createAndOpenInCanvas: (title?: string, content?: string) => Promise<string | null>;
    
    /** 关闭 Canvas 侧边栏 */
    closeCanvasSidebar: () => void;
    
    /** 设置 AI 操作状态 */
    setCanvasAIStatus: (status: CanvasAIStatus) => void;
    
    /** 获取 Canvas 笔记元数据（供 buildSystemPrompt 使用） */
    getCanvasNoteMetadata: () => CanvasNoteMetadata | null;
    
    /** 获取 Canvas 模式状态（供 SendOptions 使用） */
    getCanvasModeState: () => CanvasModeState | null;

    // ========== Learning Hub - 引用到对话（Chat V2） ==========

    /**
     * 将节点引用到当前对话
     * 支持笔记节点和引用节点（教材、错题等）
     * @param nodeId 节点 ID（笔记 ID 或引用节点 ID）
     */
    referenceToChat: (nodeId: string) => Promise<void>;

    /**
     * 检查节点是否可以引用到对话
     * @param nodeId 节点 ID
     * @returns 是否可以引用
     */
    canReferenceToChat: (nodeId: string) => boolean;

    // ========== Learning Hub - 引用节点管理（Prompt 6） ==========

    /** 引用节点映射 */
    references: Record<string, ReferenceNode>;

    /**
     * 添加教材引用
     * @param textbookId 教材 ID
     * @param parentId 父文件夹 ID（可选）
     * @returns 新创建的引用节点 ID
     */
    addTextbookRef: (textbookId: string, parentId?: string) => Promise<string>;

    /**
     * 移除引用节点
     * @param refId 引用节点 ID
     */
    removeRef: (refId: string) => void;

    /**
     * 获取引用节点的原生内容
     * @param refId 引用节点 ID
     * @returns 内容对象
     */
    fetchRefContent: (refId: string) => Promise<LearningHubContent>;

    /**
     * 获取引用节点的预览类型
     * @param refId 引用节点 ID
     * @returns 预览类型
     */
    getRefPreviewType: (refId: string) => PreviewType | undefined;

    // ========== Learning Hub - 引用有效性校验（Prompt 10） ==========

    /**
     * 校验单个引用是否有效
     * @param refId 引用节点 ID
     * @returns 是否有效
     */
    validateReference: (refId: string) => Promise<boolean>;

    /**
     * 批量校验引用有效性
     * @param refIds 引用节点 ID 列表
     * @returns 校验结果映射
     */
    batchValidateReferences: (refIds: string[]) => Promise<Record<string, boolean>>;

    /**
     * 检查引用是否失效（从缓存读取）
     * @param refId 引用节点 ID
     * @returns true=失效, false=有效, undefined=未校验
     */
    isReferenceInvalid: (refId: string) => boolean | undefined;

    /**
     * 清理所有失效引用
     * @returns 清理数量
     */
    cleanupInvalidReferences: () => Promise<number>;

    /**
     * 刷新引用标题（从原数据更新）
     * @param refId 引用节点 ID
     */
    refreshReferenceTitle: (refId: string) => Promise<void>;

    /**
     * 校验中的引用 ID 集合（用于显示加载状态）
     */
    validatingRefIds: Set<string>;
}

const NotesContext = createContext<NotesContextType | null>(null);

export const useNotes = () => {
    const context = useContext(NotesContext);
    if (!context) {
        throw new Error("useNotes must be used within a NotesProvider");
    }
    return context;
};

/**
 * 可选的 useNotes hook（用于 DSTU 模式）
 * 
 * 在没有 NotesProvider 时返回 null 而不是抛出错误。
 * 用于 Learning Hub 中的 NoteContentView 等组件，这些组件在 DSTU 模式下
 * 不需要 NotesContext。
 */
export const useNotesOptional = (): NotesContextType | null => {
    return useContext(NotesContext);
};

export const NotesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { t } = useTranslation(['common', 'notes']);

    // Core State
    const [notes, setNotes] = useState<NoteItem[]>([]);
    const {
        folders,
        rootChildren,
        references,
        setFolders,
        setRootChildren,
        setReferences,
        createFolder: createFolderHook,
        moveItem: moveFolderItem,
        renameFolder,
        loadFolders,
        removeFromStructure,
        addToStructure,
        // ★ 引用管理方法
        addReference,
        removeReference,
        getReference,
        referenceExists,
        findExistingRef,
    } = useFolderStorage(notes, setNotes);

    // ★ Prompt 10: 引用有效性校验
    const {
        validationCache,
        validatingIds: validatingRefIds,
        validateReference: validateReferenceHook,
        batchValidate,
        isInvalid: isReferenceInvalidHook,
        cleanupInvalidRefs,
        refreshTitle,
        clearCache: clearValidationCache,
    } = useReferenceValidation();
    
    const [loading, setLoading] = useState(false);
    const [active, setActive] = useState<NoteItem | null>(null);
    const [loadedContentIds, setLoadedContentIds] = useState<Set<string>>(new Set());
    const [editor, setEditor] = useState<CrepeEditorApi | null>(null);

    // Tabs State
    const [openTabs, setOpenTabs] = useState<string[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [trashOpen, setTrashOpen] = useState(false);
    const [libraryOpen, setLibraryOpen] = useState(false);

    // Search State
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<Array<{ id: string; title: string; snippet?: string }>>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const searchReqSeqRef = useRef(0);

    // Sidebar Control
    const [sidebarRevealId, setSidebarRevealId] = useState<string | null>(null);

    // AI Assistant State
    const [isAssistantOpen, setAssistantOpen] = useState(false);
    const [assistantInitialMode, setAssistantInitialMode] = useState<'chat' | 'selection'>('chat');

    const [editorPortalNoteId, setEditorPortalNoteId] = useState<string | null>(null);

    // ========== Canvas 智能笔记状态（Chat V2） ==========
    const [canvasSidebarOpen, setCanvasSidebarOpen] = useState(false);
    const [canvasNoteId, setCanvasNoteId] = useState<string | null>(null);
    const [canvasNoteHistory, setCanvasNoteHistory] = useState<string[]>([]); // 🆕 笔记历史列表（按访问时间倒序）
    const [canvasAIStatus, setCanvasAIStatusState] = useState<CanvasAIStatus>('idle');

    const notify = useCallback(
        ({
            title,
            description,
            variant,
        }: {
            title?: string;
            description?: string;
            variant?: "success" | "destructive" | "default" | "warning";
        }) => {
            const typeMap: Record<string, "success" | "error" | "info" | "warning"> = {
                success: "success",
                destructive: "error",
                default: "info",
                warning: "warning",
            };
            const type = typeMap[variant ?? "default"] || "info";
            const normalizedTitle = title?.toString().trim() ?? "";
            const normalizedDescription = description?.toString().trim() ?? "";
            const message =
                normalizedDescription ||
                normalizedTitle ||
                t('notes:notifications.defaultSuccess');
            const notificationTitle = normalizedDescription ? normalizedTitle || undefined : undefined;
            showGlobalNotification(type, message, notificationTitle);
        },
        [t],
    );

    const performSearch = useCallback(async (query: string, tags: string[] = []) => {
        const normalizedQuery = query.trim();
        const normalizedTags = tags.map(tag => tag.trim()).filter(Boolean);
        const seq = ++searchReqSeqRef.current;

        if (!normalizedQuery && normalizedTags.length === 0) {
            setSearchResults([]);
            setSearchError(null);
            setIsSearching(false);
            return;
        }

        setIsSearching(true);
        setSearchError(null);

        console.log('[NotesContext] Using DSTU API to search notes');
        const result = await dstu.search(normalizedQuery, {
            typeFilter: 'note',
            tags: normalizedTags.length > 0 ? normalizedTags : undefined,
        });

        if (result.ok) {
            const results = result.value.map(node => ({
                id: node.id,
                title: node.name,
                snippet: (node.metadata?.snippet as string) || undefined,
            }));

            if (seq === searchReqSeqRef.current) {
                setSearchResults(results || []);
                setSearchError(null);
            }
        } else {
            reportError(result.error, t('notes:errors.search_notes'));
            console.error("Search failed", result.error.toUserMessage());
            if (seq === searchReqSeqRef.current) {
                setSearchResults([]);
                setSearchError(result.error.toUserMessage());
            }
        }

        if (seq === searchReqSeqRef.current) {
            setIsSearching(false);
        }
    }, []);

    // Folder logic extracted to useFolderStorage
    // No longer need saveFoldersToPref here

    const refreshNotes = useCallback(async () => {
        setLoading(true);

        console.log('[NotesContext] Using DSTU API to list notes');
        const result = await dstu.list('/', { typeFilter: 'note' });

        if (result.ok) {
            const items = result.value.map(node => dstuNodeToNoteItem(node));

            setNotes(items || []);
            // Keep loaded mark only for existing notes to avoid stale memory
            setLoadedContentIds(prev => {
                const next = new Set<string>();
                (items || []).forEach(n => {
                    if (prev.has(n.id)) next.add(n.id);
                });
                return next;
            });

            // Load folders
            await loadFolders(items || []);

            // Load tabs prefs
            try {
                const raw = await invoke<string | null>('notes_get_pref', { key: 'notes_tabs' });
                const obj = JSON.parse(raw || '{}');
                const ids: string[] = Array.isArray(obj?.openTabs) ? obj.openTabs : [];
                const allow = new Set((items || []).map(n => n.id));
                const filtered = ids.filter(id => allow.has(id));
                setOpenTabs(filtered);
                const act: string | null = (obj?.activeId && allow.has(obj.activeId)) ? obj.activeId : (filtered[filtered.length - 1] || null);
                setActiveTabId(act);
                if (act) {
                    const note = (items || []).find(n => n.id === act) || null;
                    if (note) setActive(note);
                }
            } catch {}
        } else {
            reportError(result.error, t('notes:errors.load_notes_list'));
            console.error("[notes] load notes failed", result.error.toUserMessage());
            notify({
                title: t('notes:notifications.loadFailed'),
                description: result.error.toUserMessage(),
                variant: "destructive",
            });
        }

        setLoading(false);
    }, [notify, t, loadFolders]);

    const ensureNoteContent = useCallback(async (noteId: string) => {
        if (loadedContentIds.has(noteId)) return;

        console.log('[NotesContext] Using DSTU API to get note content:', noteId);
        const dstuPath = `/${noteId}`;
        const contentResult = await dstu.getContent(dstuPath);
        const nodeResult = await dstu.get(dstuPath);

        if (contentResult.ok && nodeResult.ok) {
            // 合并节点信息和内容
            const full: NoteItem = {
                ...dstuNodeToNoteItem(nodeResult.value),
                content_md: typeof contentResult.value === 'string' ? contentResult.value : '',
            };

            setNotes(prev => {
                const exists = prev.some(n => n.id === noteId);
                if (exists) {
                    return prev.map(n => n.id === noteId ? full : n);
                }
                return [...prev, full];
            });
            setLoadedContentIds(prev => {
                const next = new Set(prev);
                next.add(noteId);
                return next;
            });
            if (active?.id === noteId) {
                setActive(full);
            }
        } else {
            const error = !contentResult.ok ? contentResult.error : nodeResult.error;
            reportError(error, t('notes:errors.load_note_content'));
            console.error("[notes] load note content failed", error.toUserMessage());
            notify({
                title: t('notes:notifications.loadFailed'),
                description: error.toUserMessage(),
                variant: "destructive",
            });
        }
    }, [active?.id, loadedContentIds, notes, notify, t]);

    // 🔧 修复：强制刷新笔记内容（用于后端 Canvas 工具更新后刷新前端显示）
    const forceRefreshNoteContent = useCallback(async (noteId: string) => {
        console.log('[Canvas] Force refreshing note content:', noteId);

        const dstuPath = `/${noteId}`;
        const contentResult = await dstu.getContent(dstuPath);
        const nodeResult = await dstu.get(dstuPath);

        if (contentResult.ok && nodeResult.ok) {
            const full: NoteItem = {
                ...dstuNodeToNoteItem(nodeResult.value),
                content_md: typeof contentResult.value === 'string' ? contentResult.value : '',
            };

            // 更新 notes 数组
            setNotes(prev => {
                const exists = prev.some(n => n.id === noteId);
                if (exists) {
                    return prev.map(n => n.id === noteId ? full : n);
                }
                return [...prev, full];
            });

            // 更新已加载内容标记
            setLoadedContentIds(prev => {
                const next = new Set(prev);
                next.add(noteId);
                return next;
            });

            // 如果是当前激活的笔记，也更新 active
            if (active?.id === noteId) {
                setActive(full);
            }

            // 发送 DOM 事件通知编辑器刷新内容
            window.dispatchEvent(new CustomEvent('canvas:content-changed', {
                detail: { noteId, newContent: full.content_md }
            }));

            console.log('[Canvas] Note content refreshed successfully:', noteId);
        } else {
            const error = !contentResult.ok ? contentResult.error : nodeResult.error;
            reportError(error, t('notes:errors.force_refresh_content'));
            console.error('[Canvas] Failed to refresh note content:', error.toUserMessage());
        }
    }, [active?.id, notes]);

    // 🔧 修复：监听后端 Canvas 工具更新事件
    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        
        const setupListener = async () => {
            try {
                unlisten = await listen<{ noteId: string; toolName: string }>('canvas:note-updated', (event) => {
                    console.log('[Canvas] Received note-updated event from backend:', event.payload);
                    const { noteId } = event.payload;
                    if (noteId) {
                        void forceRefreshNoteContent(noteId);
                    }
                });
                console.log('[Canvas] Listening for canvas:note-updated events');
            } catch (error) {
                console.error('[Canvas] Failed to setup event listener:', error);
            }
        };
        
        void setupListener();
        
        return () => {
            if (unlisten) {
                unlisten();
                console.log('[Canvas] Unlistening canvas:note-updated events');
            }
        };
    }, [forceRefreshNoteContent]);

    // 🔧 Canvas 笔记引用恢复：监听会话加载后的恢复事件（支持多笔记历史）
    useEffect(() => {
        const handleRestoreNote = (event: Event) => {
            const customEvent = event as CustomEvent<{ noteId: string | null; noteHistory?: string[] }>;
            const { noteId, noteHistory } = customEvent.detail;
            
            // 🔧 修复：如果 noteId 为空且历史也为空，清理 Canvas 状态（会话切换时）
            // 如果 noteId 为空但历史有内容，尝试从历史恢复
            if (!noteId && (!noteHistory || noteHistory.length === 0)) {
                console.log('[Canvas] Clearing canvas state for session switch (no history)');
                setCanvasNoteId(null);
                setCanvasNoteHistory([]);
                setCanvasSidebarOpen(false);
                return;
            }
            
            console.log('[Canvas] Restoring note reference from session:', { noteId, noteHistory });
            
            // 过滤出当前科目中存在的笔记
            const validHistory = (noteHistory || []).filter(id => notes.some(n => n.id === id));
            const noteExists = noteId ? notes.some(n => n.id === noteId) : false;
            
            // 🔧 修复：如果 noteId 不存在但历史中有有效笔记，恢复到第一个有效笔记
            const effectiveNoteId = noteExists ? noteId : validHistory[0];
            
            if (effectiveNoteId) {
                // 恢复 Canvas 状态
                setCanvasNoteId(effectiveNoteId);
                setCanvasSidebarOpen(true);
                // 确保笔记在标签页中打开
                setOpenTabs(prev => prev.includes(effectiveNoteId) ? prev : [...prev, effectiveNoteId]);
                
                // 恢复笔记历史列表
                if (validHistory.length > 0) {
                    setCanvasNoteHistory(validHistory);
                    console.log('[Canvas] Restored note history:', validHistory);
                } else {
                    setCanvasNoteHistory([effectiveNoteId]);
                }
                
                if (!noteExists && noteId) {
                    console.log('[Canvas] Original noteId not found, falling back to:', effectiveNoteId);
                }
                console.log('[Canvas] Note reference restored successfully');
            } else {
                console.warn('[Canvas] No valid notes found, clearing state');
                setCanvasNoteId(null);
                setCanvasNoteHistory([]);
                setCanvasSidebarOpen(false);
            }
        };
        
        window.addEventListener('canvas:restore-note', handleRestoreNote);
        return () => window.removeEventListener('canvas:restore-note', handleRestoreNote);
    }, [notes]);

    // Tab Actions
    const openTab = useCallback((noteId: string) => {
        setOpenTabs(prev => {
            if (prev.includes(noteId)) return prev;
            return [...prev, noteId];
        });
        setActiveTabId(noteId);
        // Sync with active note
        const note = notes.find(n => n.id === noteId);
        if (note) setActive(note);
        void ensureNoteContent(noteId);
    }, [notes, ensureNoteContent]);

    const closeTab = useCallback((noteId: string) => {
        setOpenTabs(prev => {
            const newTabs = prev.filter(id => id !== noteId);
            if (activeTabId === noteId) {
                // If closing active tab, activate the last one or null
                const lastTab = newTabs.length > 0 ? newTabs[newTabs.length - 1] : null;
                setActiveTabId(lastTab);
                if (lastTab) {
                    const note = notes.find(n => n.id === lastTab);
                    if (note) setActive(note);
                    else setActive(null);
                } else {
                    setActive(null);
                }
            }
            return newTabs;
        });
    }, [activeTabId, notes]);

    const activateTab = useCallback((noteId: string) => {
        if (openTabs.includes(noteId)) {
            setActiveTabId(noteId);
            const note = notes.find(n => n.id === noteId);
            if (note) setActive(note);
            void ensureNoteContent(noteId);
        }
    }, [openTabs, notes, ensureNoteContent]);

    const reorderTabs = useCallback((newOrder: string[]) => {
        setOpenTabs(newOrder);
    }, []);

    // 编辑器 Portal（保留接口兼容）
    const requestEditorPortal = useCallback((_noteId: string, _target: HTMLElement) => {
    }, []);

    const releaseEditorPortal = useCallback((_noteId: string) => {
    }, []);

    // ========== Canvas 智能笔记方法（Chat V2） ==========
    
    // 切换 Canvas 侧边栏
    const toggleCanvasSidebar = useCallback(() => {
        setCanvasSidebarOpen(prev => {
            const next = !prev;
            window.dispatchEvent(new CustomEvent(next ? 'canvas:opened' : 'canvas:closed'));
            return next;
        });
    }, []);

    // 打开 Canvas 并指定笔记
    const openCanvasWithNote = useCallback((noteId: string) => {
        // 1. 确保笔记在标签页中打开
        openTab(noteId);
        // 2. 设置 Canvas 笔记 ID
        setCanvasNoteId(noteId);
        // 3. 🆕 更新笔记历史（将当前笔记移到最前面，去重，最多保留 10 个）
        setCanvasNoteHistory(prev => {
            const newHistory = [noteId, ...prev.filter(id => id !== noteId)].slice(0, 10);
            return newHistory;
        });
        // 4. 打开侧边栏
        setCanvasSidebarOpen(true);
        // 5. 发送事件
        window.dispatchEvent(new CustomEvent('canvas:opened'));
        
        // 6. 🆕 获取笔记详情并发送包含内容的事件（供 useCanvasContextRef 创建资源）
        const note = notes.find(n => n.id === noteId);
        window.dispatchEvent(new CustomEvent('canvas:note-changed', { 
            detail: { 
                noteId,
                title: note?.title,
                content: note?.content_md || '',
            } 
        }));
    }, [openTab, notes]);

    // 创建新笔记并在 Canvas 中打开
    const createAndOpenInCanvas = useCallback(async (title?: string, content?: string): Promise<string | null> => {
        console.log('[NotesContext] Using DSTU API to create note for Canvas');
        const result = await dstu.create('/', {
            type: 'note',
            name: title || t('notes:canvas.untitled'),
            content: content || '',
            metadata: { tags: [] },
        });

        if (result.ok) {
            const newNote: NoteItem = {
                ...dstuNodeToNoteItem(result.value),
                content_md: content || '',
            };

            setNotes(prev => [...prev, newNote]);
            setLoadedContentIds(prev => {
                const next = new Set(prev);
                next.add(newNote.id);
                return next;
            });

            // Add to folder structure
            addToStructure(newNote.id);

            // 在 Canvas 中打开新笔记
            openCanvasWithNote(newNote.id);

            return newNote.id;
        } else {
            reportError(result.error, t('notes:errors.create_canvas_note'));
            notify({
                title: t('notes:canvas.error.operation_failed'),
                description: result.error.toUserMessage(),
                variant: "destructive"
            });
            return null;
        }
    }, [t, notify, openCanvasWithNote, addToStructure]);

    // 关闭 Canvas 侧边栏
    const closeCanvasSidebar = useCallback(() => {
        setCanvasSidebarOpen(false);
        window.dispatchEvent(new CustomEvent('canvas:closed'));
    }, []);

    // 设置 AI 操作状态
    const setCanvasAIStatus = useCallback((status: CanvasAIStatus) => {
        setCanvasAIStatusState(status);
        window.dispatchEvent(new CustomEvent('canvas:ai-status-changed', { detail: { status } }));
    }, []);

    // 解析笔记结构（提取标题）
    const parseStructure = useCallback((content: string): string[] => {
        const headingRegex = /^(#{1,6})\s+(.+)$/gm;
        const headings: string[] = [];
        let match;
        while ((match = headingRegex.exec(content)) !== null) {
            headings.push(`${match[1]} ${match[2]}`);
        }
        return headings;
    }, []);

    // 生成笔记摘要（取前 N 字符）
    const generateSummary = useCallback((content: string, maxLength: number = 200): string => {
        // 移除 Markdown 标记
        const plainText = content
            .replace(/^#{1,6}\s+/gm, '')  // 移除标题标记
            .replace(/\*\*([^*]+)\*\*/g, '$1')  // 移除粗体
            .replace(/\*([^*]+)\*/g, '$1')  // 移除斜体
            .replace(/`([^`]+)`/g, '$1')  // 移除行内代码
            .replace(/```[\s\S]*?```/g, `[${t('notes:summary.code_block')}]`)  // 替换代码块
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // 移除链接
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, `[${t('notes:summary.image')}]`)  // 替换图片
            .trim();
        
        if (plainText.length <= maxLength) {
            return plainText;
        }
        return plainText.substring(0, maxLength) + '...';
    }, []);

    // 获取 Canvas 笔记元数据
    const getCanvasNoteMetadata = useCallback((): CanvasNoteMetadata | null => {
        if (!canvasNoteId) return null;
        const note = notes.find(n => n.id === canvasNoteId);
        if (!note) return null;
        
        const content = note.content_md || '';
        return {
            id: note.id,
            title: note.title,
            wordCount: content.length,
            structure: parseStructure(content),
            summary: generateSummary(content, 200),
            updatedAt: note.updated_at,
        };
    }, [canvasNoteId, notes, parseStructure, generateSummary]);

    // 获取 Canvas 模式状态（供 SendOptions 使用）
    const getCanvasModeState = useCallback((): CanvasModeState | null => {
        // 🔧 修复：即使当前笔记不存在，也要返回历史（用于跨科目切换时保留历史）
        if (!canvasNoteId && canvasNoteHistory.length === 0) return null;
        
        const note = canvasNoteId ? notes.find(n => n.id === canvasNoteId) : null;
        
        // 如果笔记不存在但有历史，返回仅包含历史的部分状态
        if (!note) {
            if (canvasNoteHistory.length > 0) {
                return {
                    activeNoteId: null,
                    activeNoteTitle: null,
                    activeNoteContent: null,
                    wordCount: 0,
                    structure: [],
                    summary: null,
                    updatedAt: null,
                    noteHistory: canvasNoteHistory,
                };
            }
            return null;
        }
        
        const content = note.content_md || '';
        return {
            activeNoteId: note.id,
            activeNoteTitle: note.title,
            activeNoteContent: content,
            wordCount: content.length,
            structure: parseStructure(content),
            summary: generateSummary(content, 200),
            updatedAt: note.updated_at,
            noteHistory: canvasNoteHistory,
        };
    }, [canvasNoteId, canvasNoteHistory, notes, parseStructure, generateSummary]);

    // 监听 canvas:get-state 事件，返回当前状态
    useEffect(() => {
        const handleGetState = (event: Event) => {
            const customEvent = event as CustomEvent;
            customEvent.detail.state = getCanvasModeState();
        };
        window.addEventListener('canvas:get-state', handleGetState);
        return () => window.removeEventListener('canvas:get-state', handleGetState);
    }, [getCanvasModeState]);

    // 当 canvasNoteId 变化时确保内容已加载
    useEffect(() => {
        if (canvasNoteId && !loadedContentIds.has(canvasNoteId)) {
            void ensureNoteContent(canvasNoteId);
        }
    }, [canvasNoteId, loadedContentIds, ensureNoteContent]);

    // CRUD Actions
    const createNote = useCallback(async (parentId?: string) => {
        console.log('[NotesContext] Using DSTU API to create note');
        const result = await dstu.create('/', {
            type: 'note',
            name: t('notes:common.untitled'),
            content: '',
            metadata: { tags: [] },
        });

        if (result.ok) {
            const newNote: NoteItem = {
                ...dstuNodeToNoteItem(result.value),
                content_md: '',
            };

            setNotes(prev => [...prev, newNote]);
            setLoadedContentIds(prev => {
                const next = new Set(prev);
                next.add(newNote.id);
                return next;
            });

            // Add to folder structure
            addToStructure(newNote.id, parentId);

            setActive(newNote);
            openTab(newNote.id);
            return newNote.id;
        } else {
            reportError(result.error, t('notes:errors.create_note'));
            notify({
                title: t('notes:actions.create_failed'),
                description: result.error.toUserMessage(),
                variant: "destructive"
            });
            return null;
        }
    }, [folders, rootChildren, notify, t, openTab, addToStructure]);

    const createFolder = useCallback(async (parentId?: string) => {
        // Use hook directly
        return await createFolderHook(parentId, t);
    }, [createFolderHook, t]);

    const saveNoteContent = useCallback(async (id: string, content: string, title?: string) => {
        // 🆕 维护模式检查：阻止保存笔记
        if (useSystemStatusStore.getState().maintenanceMode) {
            showGlobalNotification('warning', t('common:maintenance.blocked_note_save', '维护模式下无法保存笔记，请稍后再试。'));
            throw new Error('maintenance_mode');
        }

        console.log('[NotesContext] 💾 saveNoteContent 被调用', {
            id,
            contentLength: content.length,
            contentPreview: content.slice(0, 100),
            title,
            notesCount: notes.length,
        });

        const targetNote = notes.find(n => n.id === id);
        if (!targetNote) {
            console.warn('[NotesContext] ⚠️ saveNoteContent: 目标笔记不存在！', {
                id,
                existingNoteIds: notes.map(n => n.id),
            });
            throw new Error('note_not_found');
        }
        console.log('[NotesContext] 💾 找到目标笔记', { id, title: targetNote.title });

        // Guard: if正文尚未加载，先确保加载后再允许保存
        // 🔒 审计修复 + 审阅修复: 仅检查 loadedContentIds，不检查 content 是否为空
        // 原代码 !content.trim() 会将用户有意清空的内容错误拦截并从后端恢复旧内容
        // content 参数类型是 string（不可能是 undefined），所以只用 loadedContentIds 判断是否已初始化
        if (!loadedContentIds.has(id)) {
            console.warn('[NotesContext] ⚠️ saveNoteContent: 笔记内容尚未加载，先触发加载', { id });
            void ensureNoteContent(id);
            throw new Error('content_not_loaded');
        }

        // Normalize image links: replace preview URLs with relative paths
        let normalizedContent = content;
        try {
            const assets = await invoke<Array<{ absolute_path: string; relative_path: string }>>('notes_list_assets', { subject: '_global', noteId: id });
            const map: Record<string, string> = {};
            (assets || []).forEach(a => {
                const preview = convertFileSrc(a.absolute_path);
                map[preview] = a.relative_path;
                map[a.absolute_path] = a.relative_path;
            });
            // Replace in markdown image/link URLs
            Object.entries(map).forEach(([from, to]) => {
                if (!from) return;
                const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(escaped, 'g');
                normalizedContent = normalizedContent.replace(re, to);
            });
        } catch {}

        console.log('[NotesContext] 💾 准备调用 DSTU API 保存笔记:', id, { contentLength: normalizedContent.length });
        const dstuPath = `/${id}`;

        // 先更新内容
        console.log('[NotesContext] 💾 调用 dstu.update...', { dstuPath });
        const updateResult = await dstu.update(dstuPath, normalizedContent, 'note');

        if (!updateResult.ok) {
            console.error('[NotesContext] ❌ DSTU API 保存失败!', updateResult.error.toUserMessage());
            const msg = updateResult.error.toUserMessage();
            const isConflict = msg.includes('notes.conflict');
            reportError(updateResult.error, t('notes:errors.save_note_content'));
            notify({
                title: isConflict ? t('notes:actions.conflict', '内容已在其他处更新') : t('notes:actions.save_failed'),
                description: isConflict ? t('notes:actions.conflict_hint', '请刷新后再尝试保存或回滚到历史版本') : msg,
                variant: isConflict ? "warning" : "destructive"
            });
            if (isConflict) {
                void ensureNoteContent(id);
            }
            // 避免留下未加载状态
            setLoadedContentIds(prev => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
            throw new Error(isConflict ? 'save_conflict' : 'save_failed');
        }

        console.log('[NotesContext] ✅ DSTU API 内容保存成功!', { id, updatedAt: updateResult.value.updatedAt });

        // M-014 修复：内容保存成功后，立即更新本地内容状态，不受后续标题更新影响
        let effectiveTitle = title || updateResult.value.name;
        let titleFailed = false;

        // 如果有标题更新，单独设置元数据
        if (title !== undefined) {
            const metadataResult = await dstu.setMetadata(dstuPath, { title });
            if (!metadataResult.ok) {
                titleFailed = true;
                effectiveTitle = updateResult.value.name; // 回退到原标题
                reportError(metadataResult.error, t('notes:errors.update_note_title'));
                notify({
                    title: t('notes:actions.title_save_failed', '内容已保存，但标题更新失败'),
                    description: metadataResult.error.toUserMessage(),
                    variant: "warning"
                });
            }
        }

        const updated: NoteItem = {
            ...dstuNodeToNoteItem(updateResult.value),
            content_md: normalizedContent,
            title: effectiveTitle,
        };

        setNotes(prev => prev.map(n => n.id === id ? updated : n));
        setLoadedContentIds(prev => {
            const next = new Set(prev);
            next.add(id);
            return next;
        });
        if (active?.id === id) {
            setActive(updated);
        }

        // Update search results if present (to keep title synced)
        if (searchResults.length > 0 && !titleFailed) {
            setSearchResults(prev => prev.map(res => {
                if (res.id === id) {
                    return {
                        ...res,
                        title: effectiveTitle,
                    };
                }
                return res;
            }));
        }

        // 🆕 发送内容变更事件（供 useCanvasContextRef 监听更新资源）
        window.dispatchEvent(new CustomEvent('canvas:content-changed', {
            detail: {
                noteId: id,
                content: normalizedContent,
                title: updated.title,
            }
        }));
    }, [active, notify, t, searchResults.length, loadedContentIds, ensureNoteContent, notes]);

    const updateNoteTags = useCallback(async (id: string, tags: string[]) => {
        console.log('[NotesContext] Using DSTU API to update note tags:', id);
        const dstuPath = `/${id}`;
        const metadataResult = await dstu.setMetadata(dstuPath, { tags });

        if (!metadataResult.ok) {
            reportError(metadataResult.error, t('notes:errors.update_note_tags'));
            notify({
                title: t('notes:actions.update_failed'),
                description: metadataResult.error.toUserMessage(),
                variant: "destructive"
            });
            return;
        }

        const nodeResult = await dstu.get(dstuPath);
        if (!nodeResult.ok) {
            reportError(nodeResult.error, t('notes:errors.get_updated_note'));
            notify({
                title: t('notes:actions.update_failed'),
                description: nodeResult.error.toUserMessage(),
                variant: "destructive"
            });
            return;
        }

        const existingNote = notes.find(n => n.id === id);
        const updated: NoteItem = {
            ...dstuNodeToNoteItem(nodeResult.value),
            content_md: existingNote?.content_md || '',
            tags,
        };

        setNotes(prev => prev.map(n => n.id === id ? updated : n));
        if (active?.id === id) {
            setActive(updated);
        }
    }, [active, notify, t, notes]);

    const renameTagAcrossNotes = useCallback(async (oldName: string, newName: string, skipId?: string) => {
        const normalizedOld = oldName.trim();
        const normalizedNew = newName.trim();
        if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) {
            return 0;
        }

        const listAllNotes = async (): Promise<NoteItem[] | null> => {
            const pageSize = 200;
            let offset = 0;
            let rounds = 0;
            const collected: NoteItem[] = [];

            while (true) {
                const result = await dstu.list('/', { typeFilter: 'note', limit: pageSize, offset });
                if (!result.ok) {
                    reportError(result.error, t('notes:errors.load_notes_list'));
                    notify({
                        title: t('notes:actions.update_failed'),
                        description: result.error.toUserMessage(),
                        variant: "destructive"
                    });
                    return null;
                }

                const batch = result.value.map(node => dstuNodeToNoteItem(node));
                collected.push(...batch);
                if (batch.length < pageSize) {
                    break;
                }
                offset += pageSize;
                rounds += 1;
                if (rounds > 10_000) {
                    console.info('[NotesContext] renameTagAcrossNotes aborted after too many pages');
                    break;
                }
            }

            return collected;
        };

        const allNotes = await listAllNotes();
        const sourceNotes = allNotes ?? notes;
        const targets = sourceNotes.filter(note => note.id !== skipId && note.tags?.includes(normalizedOld));
        if (targets.length === 0) {
            return 0;
        }

        let updatedCount = 0;
        for (const note of targets) {
            const nextTags = note.tags.map(tag => tag === normalizedOld ? normalizedNew : tag);
            await updateNoteTags(note.id, nextTags);
            updatedCount += 1;
        }

        return updatedCount;
    }, [notes, notify, t, updateNoteTags]);

    const toggleFavorite = useCallback(async (id: string) => {
        const note = notes.find(n => n.id === id);
        if (!note) return;

        const newFavoriteValue = !note.is_favorite;

        console.log('[NotesContext] Using DSTU API to toggle favorite:', id);
        const dstuPath = `/${id}`;
        const result = await dstu.setMetadata(dstuPath, { isFavorite: newFavoriteValue });

        if (result.ok) {
            const updated: NoteItem = {
                ...note,
                is_favorite: newFavoriteValue,
            };

            setNotes(prev => prev.map(n => n.id === id ? updated : n));
            if (active?.id === id) {
                setActive(updated);
            }
            notify({
                title: updated.is_favorite
                    ? t('notes:favorites.toast_marked', '已加入收藏')
                    : t('notes:favorites.toast_unmarked', '已取消收藏'),
                variant: "success"
            });
        } else {
            reportError(result.error, t('notes:errors.toggle_favorite'));
            notify({
                title: t('notes:favorites.toast_error_title', '收藏操作失败'),
                description: result.error.toUserMessage(),
                variant: "destructive"
            });
        }
    }, [notes, active, notify, t]);

    const deleteItems = useCallback(async (ids: string[]) => {
        // Separate folders and notes
        const folderIds = ids.filter(id => folders[id]);
        const noteIds = ids.filter(id => !folders[id]);

        // 1. Delete notes first (Critical)
        if (noteIds.length > 0) {
            console.log('[NotesContext] Using DSTU API to delete notes:', noteIds);
            const deleteResults = await Promise.all(noteIds.map(id => {
                const dstuPath = `/${id}`;
                return dstu.delete(dstuPath);
            }));

            // Check if all deletions succeeded
            const failedDeletes = deleteResults.filter(r => !r.ok);
            if (failedDeletes.length > 0) {
                const firstError = failedDeletes[0].error;
                reportError(firstError, t('notes:errors.delete_notes'));
                notify({
                    title: t('notes:actions.delete_failed'),
                    description: firstError.toUserMessage(),
                    variant: "destructive"
                });
                // If API fails, we haven't called removeFromStructure, so structure is intact.
                void refreshNotes(); // Sync just in case
                return;
            }

            // Update Notes State
            setNotes(prev => prev.filter(n => !noteIds.includes(n.id)));
            setLoadedContentIds(prev => {
                const next = new Set(prev);
                noteIds.forEach(id => next.delete(id));
                return next;
            });

            // Handle Tabs and Active Note
            setOpenTabs(prev => {
                const newTabs = prev.filter(id => !noteIds.includes(id));

                // If active tab is being deleted, switch to the last remaining tab
                if (activeTabId && noteIds.includes(activeTabId)) {
                    const lastTab = newTabs.length > 0 ? newTabs[newTabs.length - 1] : null;
                    setActiveTabId(lastTab);

                    if (lastTab) {
                        const note = notes.find(n => n.id === lastTab);
                        if (note) setActive(note);
                        else setActive(null);
                    } else {
                        setActive(null);
                    }
                }
                return newTabs;
            });
        }

        // 2. Update Structure (Folders & Note references)
        // This handles removing the note IDs from their parents, and removing folder IDs
        // Only executed if API delete succeeds
        removeFromStructure(ids);

        notify({ title: t('notes:actions.delete_success'), variant: "success" });
    }, [folders, removeFromStructure, notify, t, activeTabId, notes, refreshNotes]);

    const renameItem = useCallback(async (id: string, newName: string) => {
        if (folders[id]) {
            renameFolder(id, newName);
        } else {
            // Note
            console.log('[NotesContext] Using DSTU API to rename note:', id);
            const dstuPath = `/${id}`;
            const metadataResult = await dstu.setMetadata(dstuPath, { title: newName });

            if (!metadataResult.ok) {
                reportError(metadataResult.error, t('notes:errors.rename_note'));
                notify({
                    title: t('notes:actions.rename_failed'),
                    description: metadataResult.error.toUserMessage(),
                    variant: "destructive"
                });
                return;
            }

            const nodeResult = await dstu.get(dstuPath);
            if (!nodeResult.ok) {
                reportError(nodeResult.error, t('notes:errors.get_renamed_note'));
                notify({
                    title: t('notes:actions.rename_failed'),
                    description: nodeResult.error.toUserMessage(),
                    variant: "destructive"
                });
                return;
            }

            const updated: NoteItem = {
                ...dstuNodeToNoteItem(nodeResult.value),
                content_md: notes.find(n => n.id === id)?.content_md || '',
                title: newName,
            };

            setNotes(prev => prev.map(n => n.id === id ? updated : n));
        }
    }, [folders, renameFolder, notify, t, notes]);

    const moveItem = useCallback(async (dragIds: string[], parentId: string | null, index: number) => {
        await moveFolderItem(dragIds, parentId, index);
    }, [moveFolderItem]);

    // Sync active note with tabs (if active changes externally)
    useEffect(() => {
        if (active && !openTabs.includes(active.id)) {
            openTab(active.id);
        } else if (active && activeTabId !== active.id) {
            setActiveTabId(active.id);
        }
    }, [active, openTabs, activeTabId, openTab]);

    useEffect(() => {
        const payload = JSON.stringify({ openTabs, activeId: activeTabId });
        void invoke<boolean>('notes_set_pref', { key: 'notes_tabs', value: payload });
    }, [openTabs, activeTabId]);


    // Initial Load
    useEffect(() => {
        refreshNotes();
    }, [refreshNotes]);

    useEffect(() => {
        if (active?.id && !loadedContentIds.has(active.id)) {
            void ensureNoteContent(active.id);
        }
    }, [active?.id, ensureNoteContent, loadedContentIds]);

    // ============================================================================
    // ★ Learning Hub - 引用节点管理方法（Prompt 6）
    // ============================================================================

    /**
     * 添加教材引用
     *
     * 改造说明（Prompt D）：
     * - 原使用 `learning_hub_get_textbook_info` 命令已废弃
     * - 现改用 DSTU API (dstu.get) 获取教材信息
     */
    const addTextbookRef = useCallback(async (textbookId: string, parentId?: string): Promise<string> => {
        // 检查是否已存在相同引用
        const existingRefId = findExistingRef('textbooks', textbookId);
        if (existingRefId) {
            notify({
                title: t('notes:reference.already_exists', '引用已存在'),
                variant: 'warning',
            });
            return existingRefId;
        }

        // 通过 DSTU API 获取教材信息
        let title = t('notes:reference.textbook_ref_fallback', { id: textbookId.slice(0, 8) });
        const dstuPath = `/${textbookId}`;
        const result = await dstu.get(dstuPath);

        if (result.ok && result.value?.name) {
            title = result.value.name;
        } else if (!result.ok) {
            console.warn('[NotesContext] Failed to get textbook info via DSTU:', result.error.toUserMessage());
        }

        const refId = addReference(
            {
                sourceDb: 'textbooks',
                sourceId: textbookId,
                title,
                previewType: 'pdf',
            },
            parentId
        );

        notify({
            title: t('notes:reference.add_success', '已添加引用'),
            variant: 'success',
        });

        return refId;
    }, [findExistingRef, addReference, notify, t]);

    /**
     * 移除引用节点
     */
    const removeRef = useCallback((refId: string): void => {
        removeReference(refId);
        notify({
            title: t('notes:reference.remove_success', '已移除引用'),
            variant: 'success',
        });
    }, [removeReference, notify, t]);

    /**
     * 获取引用节点的原生内容
     * 
     * 改造说明（Prompt D）：
     * - 原使用 `learning_hub_fetch_content` 命令已废弃
     * - 现改用 DSTU API (dstu.getContent, dstu.get) 获取内容
     */
    const fetchRefContent = useCallback(async (refId: string): Promise<LearningHubContent> => {
        const ref = getReference(refId);
        if (!ref) {
            throw new Error(`Reference not found: ${refId}`);
        }

        try {
            // 通过 DSTU API 获取内容
            const { fetchReferenceContent } = await import('./learningHubApi');
            const result = await fetchReferenceContent({
                sourceDb: ref.sourceDb,
                sourceId: ref.sourceId,
            });

            if (!result.ok) {
                throw new Error(result.error?.message || 'Failed to fetch content');
            }

            return {
                sourceDb: ref.sourceDb,
                sourceId: ref.sourceId,
                contentType: (result.value.metadata?.contentType as 'markdown' | 'html' | 'json' | 'binary') || 'markdown',
                content: result.value.content || '',
                metadata: result.value.metadata,
            };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error('[NotesContext] Failed to fetch reference content via DSTU:', errorMsg);
            throw new Error(errorMsg);
        }
    }, [getReference]);

    /**
     * 获取引用节点的预览类型
     */
    const getRefPreviewType = useCallback((refId: string): PreviewType | undefined => {
        const ref = getReference(refId);
        return ref?.previewType;
    }, [getReference]);

    /**
     * 将节点引用到当前对话
     * 
     * 支持笔记节点和引用节点（教材、错题等）：
     * - 笔记节点：直接使用笔记内容创建资源
     * - 引用节点：先获取原生内容，再创建资源
     * 
     * 类型映射：
     * | sourceDb      | ResourceType | typeId     |
     * |---------------|-------------|------------|
     * | notes         | 'note'      | 'note'     |
     * | textbooks     | 'file'      | 'textbook' |
     * | chat_v2       | 'file'      | 'file'     |
     * | exam_sessions | 'exam'      | 'exam'     |
     */
    const referenceToChat = useCallback(async (nodeId: string): Promise<void> => {
        // 1. 获取当前活跃的会话
        const sessionIds = sessionManager.getAllSessionIds();
        if (sessionIds.length === 0) {
            notify({
                title: t('notes:reference.no_active_session'),
                description: t('notes:reference.no_active_session_desc'),
                variant: 'warning',
            });
            return;
        }

        // 使用最近访问的会话（第一个）
        const activeSessionId = sessionIds[0];
        const store = sessionManager.get(activeSessionId);
        if (!store) {
            notify({
                title: t('notes:reference.session_not_found'),
                variant: 'destructive',
            });
            return;
        }

        try {
            let syncResult: SyncResult;
            let typeId: string;

            // 2. 判断节点类型并同步到 VFS
            const note = notes.find(n => n.id === nodeId);
            const ref = references[nodeId];

            if (note) {
                // 笔记节点：直接同步到 VFS
                console.log('[NotesContext] Syncing note to resources.db:', note.id);
                syncResult = await syncNote(note.id);
                typeId = NOTE_TYPE_ID;
                console.log('[NotesContext] Note sync result:', syncResult);
            } else if (ref) {
                // Prompt 10: 检查引用是否失效
                const invalid = isReferenceInvalidHook(nodeId);
                if (invalid === true) {
                    notify({
                        title: t('notes:reference.cannotAddToChat'),
                        description: t('notes:reference.invalid'),
                        variant: 'warning',
                    });
                    return;
                }

                // 根据 sourceDb 映射类型并同步到 VFS
                switch (ref.sourceDb) {
                    case 'textbooks': {
                        // 同步到 VFS（不指定页面范围，同步全部）
                        console.log('[NotesContext] Syncing textbook to resources.db:', ref.sourceId);
                        const textbookResults = await syncTextbookPages(ref.sourceId);
                        // 使用第一个结果（整体资源）
                        if (textbookResults.length === 0) {
                            throw new Error('Textbook sync returned no results');
                        }
                        syncResult = textbookResults[0];
                        typeId = TEXTBOOK_TYPE_ID;
                        break;
                    }
                    case 'exam_sessions': {
                        // 题目集识别同步到 VFS
                        console.log('[NotesContext] Syncing exam to resources.db:', ref.sourceId);
                        syncResult = await syncExam(ref.sourceId);
                        typeId = EXAM_TYPE_ID;
                        break;
                    }
                    default: {
                        // 默认作为文件处理，通过 createResource 写入 VFS
                        console.log('[NotesContext] Creating file resource:', ref.sourceId);
                        const hubContent = await fetchRefContent(nodeId);
                        syncResult = await createResource({
                            resourceType: 'file',
                            data: hubContent.content,
                            sourceId: ref.sourceId,
                            metadata: {
                                title: ref.title || '',
                                ...hubContent.metadata,
                            },
                        });
                        typeId = 'file';
                    }
                }
            } else {
                // 节点不存在
                notify({
                    title: t('notes:reference.node_not_found'),
                    variant: 'destructive',
                });
                return;
            }

            console.log('[NotesContext] Resource sync/create result:', syncResult);

            // 3. 构建 ContextRef 并添加到 chatStore（使用同步服务返回的结果）
            const contextRef: ContextRef = {
                resourceId: syncResult.resourceId,
                hash: syncResult.hash,
                typeId,
            };

            store.getState().addContextRef(contextRef);

            // 4. 通知用户
            notify({
                title: t('notes:reference.to_chat_success'),
                description: syncResult.isNew 
                    ? t('notes:reference.to_chat_created_new')
                    : t('notes:reference.to_chat_reused'),
                variant: 'success',
            });

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error('[NotesContext] referenceToChat failed:', errorMsg);
            notify({
                title: t('notes:reference.to_chat_failed'),
                description: errorMsg,
                variant: 'destructive',
            });
        }
    }, [notes, references, loadedContentIds, fetchRefContent, notify, t, isReferenceInvalidHook]);

    /**
     * 检查节点是否可以引用到对话
     * 
     * 条件：
     * 1. 有活跃的会话
     * 2. 节点存在（笔记或引用节点）
     * 3. 如果是引用节点，不能是失效状态（Prompt 10）
     */
    const canReferenceToChat = useCallback((nodeId: string): boolean => {
        // 检查是否有活跃会话
        const sessionIds = sessionManager.getAllSessionIds();
        if (sessionIds.length === 0) {
            return false;
        }

        // 检查节点是否存在
        const isNote = notes.some(n => n.id === nodeId);
        const isRef = nodeId in references;

        if (!isNote && !isRef) {
            return false;
        }

        // Prompt 10: 失效引用不允许引用到对话
        if (isRef) {
            const invalid = isReferenceInvalidHook(nodeId);
            if (invalid === true) {
                return false;
            }
        }

        return true;
    }, [notes, references, isReferenceInvalidHook]);

    // ========== Prompt 10: 引用有效性校验包装函数 ==========

    /**
     * 校验单个引用是否有效
     */
    const validateReference = useCallback(async (refId: string): Promise<boolean> => {
        const ref = references[refId];
        if (!ref) {
            console.warn('[NotesContext] validateReference: ref not found', refId);
            return false;
        }
        return validateReferenceHook(refId, ref);
    }, [references, validateReferenceHook]);

    /**
     * 批量校验引用有效性
     */
    const batchValidateReferences = useCallback(async (refIds: string[]): Promise<Record<string, boolean>> => {
        const refs = refIds
            .map(id => ({ id, node: references[id] }))
            .filter((item): item is { id: string; node: ReferenceNode } => !!item.node);
        return batchValidate(refs);
    }, [references, batchValidate]);

    /**
     * 检查引用是否失效（从缓存读取）
     */
    const isReferenceInvalid = useCallback((refId: string): boolean | undefined => {
        return isReferenceInvalidHook(refId);
    }, [isReferenceInvalidHook]);

    /**
     * 清理所有失效引用
     */
    const cleanupInvalidReferences = useCallback(async (): Promise<number> => {
        const count = await cleanupInvalidRefs(references, removeReference);
        if (count > 0) {
            notify({
                title: t('notes:reference.cleanupSuccess', { count }),
                variant: 'success',
            });
        } else {
            notify({
                title: t('notes:reference.cleanupNone'),
                variant: 'default',
            });
        }
        return count;
    }, [references, removeReference, cleanupInvalidRefs, notify, t]);

    /**
     * 刷新引用标题（从原数据更新）
     */
    const refreshReferenceTitle = useCallback(async (refId: string): Promise<void> => {
        const ref = references[refId];
        if (!ref) {
            console.warn('[NotesContext] refreshReferenceTitle: ref not found', refId);
            return;
        }
        try {
            await refreshTitle(refId, ref, (id, updates) => {
                // 使用 setReferences 更新标题
                setReferences(prev => ({
                    ...prev,
                    [id]: { ...prev[id], ...updates },
                }));
            });
            notify({
                title: t('notes:reference.refreshSuccess'),
                variant: 'success',
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            notify({
                title: t('notes:reference.refreshFailed', { error: errorMsg }),
                variant: 'destructive',
            });
        }
    }, [references, setReferences, refreshTitle, notify, t]);

    const value = {
        notes,
        folders,
        rootChildren,
        loading,
        active,
        loadedContentIds,
        openTabs,
        activeTabId,
        trashOpen,
        libraryOpen,
        setNotes,
        setActive,
        setTrashOpen,
        setLibraryOpen,
        editor,
        setEditor,
        openTab,
        closeTab,
        activateTab,
        reorderTabs,
        notify,
        refreshNotes,
        ensureNoteContent,
        forceRefreshNoteContent,
        createNote,
        createFolder,
        deleteItems,
        renameItem,
        moveItem,
        saveNoteContent,
        updateNoteTags,
        renameTagAcrossNotes,
        toggleFavorite,
        isAssistantOpen,
        setAssistantOpen,
        assistantInitialMode,
        setAssistantInitialMode,
        searchQuery,
        searchResults,
        isSearching,
        searchError,
        setSearchQuery,
        performSearch,
        sidebarRevealId,
        setSidebarRevealId,
        editorPortalNoteId,
        requestEditorPortal,
        releaseEditorPortal,
        // Canvas 智能笔记扩展（Chat V2）
        canvasSidebarOpen,
        canvasNoteId,
        canvasNoteHistory, // 🆕 笔记历史列表
        canvasAIStatus,
        toggleCanvasSidebar,
        openCanvasWithNote,
        createAndOpenInCanvas,
        closeCanvasSidebar,
        setCanvasAIStatus,
        getCanvasNoteMetadata,
        getCanvasModeState,
        // ★ Learning Hub - 引用管理（Prompt 6）
        references,
        addTextbookRef,
        removeRef,
        fetchRefContent,
        getRefPreviewType,
        referenceToChat,
        canReferenceToChat,
        // ★ Learning Hub - 引用有效性校验（Prompt 10）
        validateReference,
        batchValidateReferences,
        isReferenceInvalid,
        cleanupInvalidReferences,
        refreshReferenceTitle,
        validatingRefIds,
    };

    return (
        <NotesContext.Provider value={value}>
            {children}
        </NotesContext.Provider>
    );
};
