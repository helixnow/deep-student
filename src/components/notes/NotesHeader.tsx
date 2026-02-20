import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
    Save,
    MoreVertical,
    PanelLeft,
    ChevronRight,
    Calendar,
    Tag,
    FileText,
    Folder,
    FileArchive,
    Printer,
    Link,
    Copy,
    History,
    Trash2,
    ArrowRight,
    FolderOpen,
} from "lucide-react";
import { NotionButton } from '@/components/ui/NotionButton';
import { Separator } from "../ui/shad/Separator";
import {
    AppMenu,
    AppMenuContent,
    AppMenuItem,
    AppMenuTrigger,
    AppMenuGroup,
    AppMenuSeparator,
} from "../ui/app-menu";
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
        setVersionsOpen,
        setLibraryOpen,
        deleteItems
    } = useNotes();

    // Map tab IDs to NoteItems for the TabsBar
    const tabs = openTabs.map(id => notes.find(n => n.id === id)).filter((n): n is NonNullable<typeof n> => !!n);

    const handleExport = async () => {
        if (isMobilePlatform()) {
            showGlobalNotification('error', t('notes:header.export_failed') + ": " + t('notes:header.export_single_mobile_hint'));
            return;
        }
        try {
            showGlobalNotification('info', t('notes:header.exporting', 'Exporting notes...'));
            const res = await NotesAPI.exportNotes({});
            showGlobalNotification('success', t('notes:header.export_success', 'Exported to: {{path}}', { path: res.output_path }));
        } catch (error: unknown) {
            console.error("Export failed", error);
            showGlobalNotification('error', t('notes:header.export_failed', 'Export failed') + ": " + getErrorMessage(error));
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
            showGlobalNotification('error', t('notes:header.print_failed', 'Print failed: No content to print'));
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
                filters: [{ name: t('notes:header.export_filter_name', 'Markdown Note Export'), extensions: ['zip'] }],
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
                        <NotionButton 
                            variant="ghost" 
                            iconOnly size="sm" 
                            className="h-7 w-7 shrink-0 text-muted-foreground/70 hover:text-foreground md:hidden"
                            onClick={onMobileMenuClick}
                        >
                            <PanelLeft className="h-4 w-4" />
                        </NotionButton>
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
                    {/* Spacer to push actions to right */}
                    <div className="flex-1" />

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
                        <NotionButton
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs font-medium text-muted-foreground hover:text-foreground hidden sm:flex"
                            onClick={() => showGlobalNotification('info', t('notes:common.auto_save_enabled'))}
                        >
                            <span className="flex items-center gap-1.5">
                            {t('notes:actions.save')}
                            </span>
                        </NotionButton>
                        <NotionButton
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                            onClick={() => setLibraryOpen(true)}
                        >
                            <span className="flex items-center gap-1.5">
                                <FileArchive className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">{t('notes:toolbar.export_library')}</span>
                                <span className="sm:hidden">{t('notes:toolbar.export_library')}</span>
                            </span>
                        </NotionButton>

                        <Separator className="h-4 w-px mx-1 bg-border/40" />

                        <AppMenu>
                            <AppMenuTrigger asChild>
                                <NotionButton variant="ghost" iconOnly size="sm" className="h-7 w-7 text-muted-foreground">
                                    <MoreVertical className="h-3.5 w-3.5" />
                                </NotionButton>
                            </AppMenuTrigger>
                            <AppMenuContent align="end" width={240}>
                                <AppMenuGroup label={t('notes:menu.page_actions', '页面操作')}>
                                    <AppMenuItem
                                        icon={<Link className="h-4 w-4" />}
                                        shortcut="⌥⌘L"
                                        onClick={() => {
                                            if (active) {
                                                const noteUrl = `note://${active.id}`;
                                                copyTextToClipboard(noteUrl);
                                                showGlobalNotification('success', t('notes:menu.link_copied', '链接已复制'));
                                            }
                                        }}
                                    >
                                        {t('notes:menu.copy_link', '拷贝链接')}
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
                                        {t('notes:menu.reveal_in_sidebar', '在侧边栏中显示')}
                                    </AppMenuItem>
                                    <AppMenuItem
                                        icon={<Trash2 className="h-4 w-4" />}
                                        destructive
                                        onClick={() => {
                                            if (active) {
                                                deleteItems([active.id]);
                                            }
                                        }}
                                    >
                                        {t('notes:menu.move_to_trash', '移至垃圾箱')}
                                    </AppMenuItem>
                                </AppMenuGroup>

                                <AppMenuSeparator />

                                <AppMenuGroup label={t('notes:menu.export_import', '导入导出')}>
                                    <AppMenuItem icon={<FileArchive className="h-4 w-4" />} onClick={handleExport}>
                                        {t('notes:toolbar.export')}
                                    </AppMenuItem>
                                    <AppMenuItem icon={<FileText className="h-4 w-4" />} onClick={handleExportCurrentNote}>
                                        {t('notes:header.export_single')}
                                    </AppMenuItem>
                                </AppMenuGroup>

                                <AppMenuSeparator />

                                <AppMenuGroup label={t('notes:menu.history', '历史')}>
                                    <AppMenuItem 
                                        icon={<History className="h-4 w-4" />} 
                                        onClick={() => setVersionsOpen(true)}
                                    >
                                        {t('notes:header.versions', '版本历史')}
                                    </AppMenuItem>
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
