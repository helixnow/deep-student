/**
 * 添加引用下拉菜单组件
 *
 * 根据文档19《Prompt 6》实现：
 * - 在工具栏提供"添加引用"入口
 * - 下拉菜单包含"添加教材引用"选项
 * - 点击后打开对应的选择器（ReferenceSelector，由 Prompt 7 实现）
 *
 * 约束：
 * - 使用 i18n 国际化
 * - 支持 light/dark 主题
 * - 根据当前选中的文件夹决定引用添加位置
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LinkIcon, BookOpen, ChevronDown } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import {
    AppMenu,
    AppMenuContent,
    AppMenuItem,
    AppMenuTrigger,
    AppMenuGroup,
    AppMenuSeparator,
} from '../../ui/app-menu';
import { useNotes } from '../NotesContext';
import { cn } from '../../../lib/utils';
import { ReferenceSelector, type ReferenceSelectResult } from '../reference-selector';

interface AddReferenceDropdownProps {
    /** 当前选中的文件夹 ID（用于确定引用添加位置） */
    selectedFolderId?: string;
    /** 是否禁用 */
    disabled?: boolean;
    /** 自定义类名 */
    className?: string;
    /** 紧凑模式（仅显示图标） */
    compact?: boolean;
}

/**
 * 添加引用下拉菜单
 */
export const AddReferenceDropdown: React.FC<AddReferenceDropdownProps> = ({
    selectedFolderId,
    disabled = false,
    className,
    compact = false,
}) => {
    const { t } = useTranslation(['notes', 'common']);
    const { addTextbookRef, notify, references } = useNotes();

    // 选择器对话框状态（由 Prompt 7 的 ReferenceSelector 组件提供）
    const [textbookSelectorOpen, setTextbookSelectorOpen] = useState(false);

    // 已存在的引用列表（用于在选择器中禁用已引用的资源）
    const existingRefs = useMemo(() => {
        return Object.values(references).map(ref => ({
            sourceDb: ref.sourceDb,
            sourceId: ref.sourceId,
        }));
    }, [references]);

    /**
     * 处理添加教材引用 - 打开选择器
     */
    const handleAddTextbook = useCallback(() => {
        setTextbookSelectorOpen(true);
    }, []);

    /**
     * 处理教材选择
     */
    const handleTextbookSelect = useCallback(async (result: ReferenceSelectResult) => {
        try {
            await addTextbookRef(result.sourceId, selectedFolderId);
            notify({
                title: t('notes:reference.add_success'),
                variant: 'success',
            });
        } catch (error: unknown) {
            console.error('Failed to add textbook ref:', error);
        }
    }, [selectedFolderId, addTextbookRef, notify, t]);

    return (
        <>
        <AppMenu>
            <AppMenuTrigger asChild>
                <NotionButton
                    variant="ghost"
                    size={compact ? 'icon' : 'sm'}
                    className={cn(
                        'text-muted-foreground/70 hover:text-foreground',
                        compact ? 'h-8 w-8' : 'h-8 px-2 gap-1',
                        className
                    )}
                    disabled={disabled}
                    title={t('notes:reference.add_reference')}
                >
                    <LinkIcon className="h-4 w-4" />
                    {!compact && (
                        <>
                            <span className="text-xs hidden sm:inline">
                                {t('notes:reference.add_reference')}
                            </span>
                            <ChevronDown className="h-3 w-3 opacity-50" />
                        </>
                    )}
                </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="start" width={200}>
                <AppMenuGroup label={t('notes:reference.add_reference')}>
                    <AppMenuItem
                        icon={<BookOpen className="h-4 w-4" />}
                        onClick={handleAddTextbook}
                    >
                        {t('notes:reference.add_textbook')}
                    </AppMenuItem>
                </AppMenuGroup>

                <AppMenuSeparator />

                <div className="px-2 py-1.5 text-[10px] text-muted-foreground/60">
                    {selectedFolderId
                        ? t('notes:reference.add_to_folder')
                        : t('notes:reference.add_to_root')
                    }
                </div>
            </AppMenuContent>
        </AppMenu>

        {/* 教材选择器弹窗 */}
        <ReferenceSelector
            open={textbookSelectorOpen}
            onOpenChange={setTextbookSelectorOpen}
            type="textbook"
            onSelect={handleTextbookSelect}
            existingRefs={existingRefs}
        />
        </>
    );
};

export default AddReferenceDropdown;
