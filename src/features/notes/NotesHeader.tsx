import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    FloppyDisk,
    DotsThreeVertical,
    SidebarSimple,
    CaretRight,
    Calendar,
    FileText,
    FileArchive,
    Printer,
    Link,
    Copy,
    Trash,
    ArrowRight,
    FolderOpen,
} from "@phosphor-icons/react";
import { DsButton } from '@/components/ui/DsButton';
import { Separator } from "@/components/ui/shad/Separator";
import {
    AppMenu,
    AppMenuContent,
    AppMenuItem,
    AppMenuTrigger,
    AppMenuGroup,
    AppMenuSeparator,
} from "@/components/ui/app-menu";
import NotesTabsBar from "./NotesTabsBar";
import { useNotes } from "./NotesContext";
import { getPathToNote } from "./notesUtils";
import { NoteTagsEditor } from "./components/NoteTagsEditor";
import { NotesAPI } from "../../utils/notesApi";
import { getErrorMessage } from "../../utils/errorUtils";
import { fileManager } from "../../utils/fileManager";
import { isMobilePlatform } from "../../utils/platform";

import { showGlobalNotification } from '@/components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface NotesHeaderProps {
    onMobileMenuClick?: () => void;
}

export const NotesHeader: React.FC<NotesHeaderProps> = ({ 
    onMobileMenuClick
}) => {
    const { t } = useTranslation(['notes', 'common']);
    const {
        active,
        notes,
        folders,
        openTabs,
        activeTabId,
        activateTab,
        closeTab,
        reorderTabs,
        updateNoteTags,
        setSidebarRevealId,
        setLibraryOpen,
        deleteItems,
        editor,
        saveNoteContent,
    } = useNotes();

    // Map tab IDs to NoteItems for the TabsBar
    const tabs = openTabs.map(id => notes.find(n => n.id === id)).filter((n): n is NonNullable<typeof n> => !!n);

    // 面包屑：当前笔记的文件夹路径（getPathToNote 末项为笔记本身）
    const breadcrumb = useMemo(
        () => (active ? getPathToNote(active.id, folders, notes) : []),
        [active, folders, notes],
    );

    // 更多菜单（受控）：删除采用内联两步确认，需保持菜单打开
    const [menuOpen, setMenuOpen] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const confirmResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (!menuOpen) setConfirmingDelete(false);
        return () => {
            if (confirmResetTimer.current) {
                clearTimeout(confirmResetTimer.current);
                confirmResetTimer.current = null;
            }
        };
    }, [menuOpen]);

    const handleDeleteClick = useCallback(() => {
        if (!active) return;
        if (!confirmingDelete) {
            // 第一步：进入确认态，3 秒后自动还原
            setConfirmingDelete(true);
            if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current);
            confirmResetTimer.current = setTimeout(() => setConfirmingDelete(false), 3000);
            return;
        }
        if (confirmResetTimer.current) {
            clearTimeout(confirmResetTimer.current);
            confirmResetTimer.current = null;
        }
        setConfirmingDelete(false);
        setMenuOpen(false);
        void deleteItems([active.id]);
    }, [active, confirmingDelete, deleteItems]);

    // 真实强制保存：读取编辑器当前 Markdown 并落盘（与命令面板 NOTES_FORCE_SAVE 一致）
    const [saving, setSaving] = useState(false);
    const handleForceSave = useCallback(async () => {
        if (!active) {
            showGlobalNotification('error', t('notes:notifications.noActiveNote'));
            return;
        }
        if (!editor) {
            // 编辑器尚未就绪时退回原提示
            showGlobalNotification('info', t('notes:common.auto_save_enabled'));
            return;
        }
        setSaving(true);
        try {
            const content = editor.getMarkdown() || '';
            await saveNoteContent(active.id, content);
            showGlobalNotification('success', t('notes:actions.save_success'));
        } catch (error: unknown) {
            // saveNoteContent 内部已发出失败通知，这里仅记录
            console.error('[NotesHeader] Force save failed', error);
        } finally {
            setSaving(false);
        }
    }, [active, editor, saveNoteContent, t]);

    // P2-12：移动平台不支持库导出（后端依赖桌面文件系统对话框）。
    // 移动端改为「复制 Markdown」，桌面保留导出入口。
    const onMobilePlatform = isMobilePlatform();

    const handleCopyMarkdown = async () => {
        if (!active) {
            showGlobalNotification('error', t('notes:notifications.noActiveNote'));
            return;
        }
        const markdown = editor?.getMarkdown?.() ?? active.content_md ?? '';
        const copied = await copyTextToClipboard(markdown);
        if (copied) {
            showGlobalNotification('success', t('notes:header.copy_markdown_success', '已复制 Markdown'));
        } else {
            showGlobalNotification('error', t('notes:header.copy_markdown_failed', '复制失败'));
        }
    };

    const handleExport = async () => {
        if (isMobilePlatform()) {
            showGlobalNotification('error', t('notes:header.export_failed') + ": " + t('notes:header.export_single_mobile_hint'));
            return;
        }
        try {
            showGlobalNotification('info', t('notes:header.exporting'));
            const res = await NotesAPI.exportNotes({});
            showGlobalNotification('success', t('notes:header.export_success', 'Exported to: {{path}}', { path: res.output_path }));
        } catch (error: unknown) {
            console.error("Export failed", error);
            showGlobalNotification('error', t('notes:header.export_failed') + ": " + getErrorMessage(error));
        }
    };

    const handlePrint = () => {
        if (!active) {
            showGlobalNotification('error', t('notes:notifications.noActiveNote'));
            return;
        }
        // 使用浏览器原生打印功能
        // 创建一个临时的打印容器
        const printContent = document.querySelector('.crepe-editor-wrapper');
        if (!printContent) {
            showGlobalNotification('error', t('notes:header.print_failed'));
            return;
        }
        
        // 打开打印对话框
        window.print();
    };

    const handleExportCurrentNote = async () => {
        if (!active) {
            showGlobalNotification('error', t('notes:notifications.noActiveNote'));
            return;
        }

        if (isMobilePlatform()) {
            showGlobalNotification('error', t('notes:header.export_single_mobile_hint'));
            return;
        }

        const sanitizedTitle = (active.title || "note").replace(/[\\/:*?"<>|]/g, "_");
        const defaultFileName = `note_${sanitizedTitle}_${active.id.slice(0, 8)}.zip`;

        let outputPath: string | undefined;
        try {
            outputPath = await fileManager.pickSavePath({
                title: t('notes:header.export_single_title'),
                defaultFileName,
                filters: [{ name: t('notes:header.export_filter_name'), extensions: ['zip'] }],
            }) ?? undefined;
            if (!outputPath) {
                return;
            }
        } catch (error: unknown) {
            console.error("Failed to pick save path", error);
            showGlobalNotification('error', t('notes:header.export_single_failed', { error: getErrorMessage(error) }));
            return;
        }

        showGlobalNotification('info', t('notes:header.exporting_single'));
        try {
            const res = await NotesAPI.exportSingleNote({
                noteId: active.id,
                outputPath,
                includeVersions: true,
            });
            showGlobalNotification('success', t('notes:header.export_single_success', { path: res.output_path }));
        } catch (error: unknown) {
            console.error("Export single note failed", error);
            showGlobalNotification('error', t('notes:header.export_single_failed', { error: getErrorMessage(error) }));
        }
    };

    return (
        <div className="notes-header-container flex flex-col border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-10 transition-all">
            {/* Tabs Bar */}
            <div className="flex items-stretch h-9 px-1 gap-1 bg-muted/10">
                {/* Mobile Menu Toggle */}
                {onMobileMenuClick && (
                    <>
                        <DsButton 
                            variant="ghost" 
                            iconOnly size="sm" 
                            className="h-7 w-7 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9 shrink-0 text-muted-foreground/70 hover:text-foreground md:hidden"
                            onClick={onMobileMenuClick}
                        >
                            <SidebarSimple className="h-4 w-4" />
                        </DsButton>
                        <Separator className="h-4 w-px mx-1 bg-border/40 md:hidden" />
                    </>
                )}
                
                <div className="flex-1 min-w-0 overflow-hidden h-full">
                    <NotesTabsBar
                        activeId={activeTabId}
                        tabs={tabs}
                        onActivate={activateTab}
                        onClose={closeTab}
                        onReorder={(newTabs) => reorderTabs(newTabs.map(t => t.id))}
                    />
                </div>
            </div>

            {/* Toolbar (only visible if active note) */}
            {active && (
                <div className="flex items-center h-12 px-4 gap-3 border-t border-border/20">
                    {/* 面包屑：文件夹路径 + 笔记标题 */}
                    <nav
                        aria-label={t('notes:menu.reveal_in_sidebar')}
                        className="flex items-center gap-1 min-w-0 flex-1 text-xs text-muted-foreground/70"
                    >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
                        {breadcrumb.map((segment, index) => {
                            const isLast = index === breadcrumb.length - 1;
                            return (
                                <React.Fragment key={segment.id}>
                                    {index > 0 && (
                                        <CaretRight className="h-3 w-3 shrink-0 text-muted-foreground/40" aria-hidden="true" />
                                    )}
                                    {/* 触屏下扩大面包屑命中区（父容器 h-12，垂直方向有富余） */}
                                    <button
                                        type="button"
                                        className={
                                            isLast
                                                ? "truncate max-w-[220px] font-medium text-foreground/80 cursor-default"
                                                : "truncate max-w-[140px] rounded px-0.5 [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-1.5 hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150"
                                        }
                                        title={segment.title}
                                        onClick={() => {
                                            if (!isLast) setSidebarRevealId(segment.id);
                                        }}
                                    >
                                        {segment.title}
                                    </button>
                                </React.Fragment>
                            );
                        })}
                    </nav>

                    {/* Meta Info (Date, etc.) - Optional, hidden on small screens */}
                    <div className="hidden lg:flex items-center gap-3 text-[10px] text-muted-foreground/50">
                        <div className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            <span>{new Date(active.updated_at).toLocaleDateString()}</span>
                        </div>
                        
                        {/* Tags Editor */}
                        <NoteTagsEditor 
                            noteId={active.id}
                            initialTags={active.tags || []}
                            onTagsChange={async (tags) => {
                                await updateNoteTags(active.id, tags);
                            }}
                            readonly={false}
                        />
                    </div>


                    <div className="flex items-center gap-1 ml-2">
                        {/* 触屏（pointer:coarse）下放大到 40px 触控高度 */}
                        <DsButton
                            variant="ghost"
                            size="sm"
                            className="h-7 [@media(pointer:coarse)]:h-10 px-2 text-xs font-medium text-muted-foreground hover:text-foreground hidden sm:flex"
                            disabled={saving}
                            onClick={() => { void handleForceSave(); }}
                        >
                            <span className="flex items-center gap-1.5">
                                <FloppyDisk className="h-3.5 w-3.5" />
                                {saving ? t('notes:editor.save_status.saving') : t('notes:actions.save')}
                            </span>
                        </DsButton>
                        {onMobilePlatform ? (
                            // P2-12：移动平台库导出不可用（依赖桌面文件对话框），改「复制 Markdown」
                            <DsButton
                                variant="ghost"
                                size="sm"
                                className="h-7 [@media(pointer:coarse)]:h-10 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                                onClick={() => { void handleCopyMarkdown(); }}
                            >
                                <span className="flex items-center gap-1.5">
                                    <Copy className="h-3.5 w-3.5" />
                                    <span>{t('notes:header.copy_markdown', '复制 Markdown')}</span>
                                </span>
                            </DsButton>
                        ) : (
                            <DsButton
                                variant="ghost"
                                size="sm"
                                className="h-7 [@media(pointer:coarse)]:h-10 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                                onClick={() => setLibraryOpen(true)}
                            >
                                <span className="flex items-center gap-1.5">
                                    <FileArchive className="h-3.5 w-3.5" />
                                    <span>{t('notes:toolbar.export_library')}</span>
                                </span>
                            </DsButton>
                        )}

                        <Separator className="h-4 w-px mx-1 bg-border/40" />

                        <AppMenu open={menuOpen} onOpenChange={setMenuOpen}>
                            <AppMenuTrigger asChild>
                                <DsButton variant="ghost" iconOnly size="sm" className="h-7 w-7 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 text-muted-foreground">
                                    <DotsThreeVertical className="h-3.5 w-3.5" />
                                </DsButton>
                            </AppMenuTrigger>
                            <AppMenuContent align="end" width={240}>
                                <AppMenuGroup label={t('notes:menu.page_actions')}>
                                    <AppMenuItem
                                        icon={<Link className="h-4 w-4" />}
                                        shortcut="⌥⌘L"
                                        onClick={() => {
                                            if (active) {
                                                const noteUrl = `note://${active.id}`;
                                                copyTextToClipboard(noteUrl);
                                                showGlobalNotification('success', t('notes:menu.link_copied'));
                                            }
                                        }}
                                    >
                                        {t('notes:menu.copy_link')}
                                    </AppMenuItem>
                                    <AppMenuItem 
                                        icon={<ArrowRight className="h-4 w-4" />}
                                        shortcut="⌘⇧P"
                                        onClick={() => {
                                            if (active) {
                                                setSidebarRevealId(active.id);
                                            }
                                        }}
                                    >
                                        {t('notes:menu.reveal_in_sidebar')}
                                    </AppMenuItem>
                                    {/* 删除：内联两步确认（第一次点击进入红色确认态，不弹 Modal，不自动关闭菜单） */}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className={
                                            confirmingDelete
                                                ? "app-menu-item app-menu-item-destructive bg-destructive/10 font-medium"
                                                : "app-menu-item app-menu-item-destructive"
                                        }
                                        onClick={handleDeleteClick}
                                    >
                                        <span className="app-menu-item-icon"><Trash className="h-4 w-4" /></span>
                                        <span className="app-menu-item-content">
                                            {confirmingDelete
                                                ? t('notes:tree.delete_confirm.title')
                                                : t('notes:menu.move_to_trash')}
                                        </span>
                                    </button>
                                </AppMenuGroup>

                                <AppMenuSeparator />

                                <AppMenuGroup label={t('notes:menu.export_import')}>
                                    {onMobilePlatform ? (
                                        // P2-12：移动端隐藏必然失败的导出项，提供复制 Markdown
                                        <AppMenuItem icon={<Copy className="h-4 w-4" />} onClick={() => { void handleCopyMarkdown(); }}>
                                            {t('notes:header.copy_markdown', '复制 Markdown')}
                                        </AppMenuItem>
                                    ) : (
                                        <>
                                            <AppMenuItem icon={<FileArchive className="h-4 w-4" />} onClick={handleExport}>
                                                {t('notes:toolbar.export')}
                                            </AppMenuItem>
                                            <AppMenuItem icon={<FileText className="h-4 w-4" />} onClick={handleExportCurrentNote}>
                                                {t('notes:header.export_single')}
                                            </AppMenuItem>
                                        </>
                                    )}
                                </AppMenuGroup>

                                <AppMenuSeparator />

                                <AppMenuGroup label={t('notes:menu.history')}>
                                    <AppMenuItem 
                                        icon={<Printer className="h-4 w-4" />}
                                        shortcut="⌘P"
                                        onClick={handlePrint}
                                    >
                                        {t('notes:toolbar.print')}
                                    </AppMenuItem>
                                </AppMenuGroup>
                            </AppMenuContent>
                        </AppMenu>

                    </div>
                </div>
            )}
        </div>
    );
};
