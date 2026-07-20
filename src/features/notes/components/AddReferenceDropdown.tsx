/**
 * 添加引用入口按钮
 *
 * 改造说明（对齐 Notion 内联体验）：
 * - 原为 AppMenu 二级菜单（仅一项"添加教材引用"）→ 现在按钮直接展开
 *   锚定在按钮下方的 ReferenceSelector 内联面板，少一次点击。
 * - 添加失败时给出 toast 反馈（原先仅 console.error 吞错）。
 * - 题目集（exam_session）类型：ReferenceSelector 已支持列表，但 NotesContext
 *   尚无 addExamRef 写入路径，故本入口暂只提供教材引用。
 *
 * 约束：
 * - 使用 i18n 国际化
 * - 支持 light/dark 主题
 * - 根据当前选中的文件夹决定引用添加位置
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { LinkSimple, CaretDown } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
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
 * 添加引用按钮（单击直接展开锚定的引用选择面板）
 */
export const AddReferenceDropdown: React.FC<AddReferenceDropdownProps> = ({
    selectedFolderId,
    disabled = false,
    className,
    compact = false,
}) => {
    const { t } = useTranslation(['notes', 'common']);
    const { addTextbookRef, notify, references } = useNotes();

    const [selectorOpen, setSelectorOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement | null>(null);

    // 已存在的引用列表（用于在选择器中禁用已引用的资源）
    const existingRefs = useMemo(() => {
        return Object.values(references).map(ref => ({
            sourceDb: ref.sourceDb,
            sourceId: ref.sourceId,
        }));
    }, [references]);

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
            notify({
                title: t('notes:reference.add_failed'),
                variant: 'destructive',
            });
        }
    }, [selectedFolderId, addTextbookRef, notify, t]);

    return (
        <>
            <NotionButton
                ref={triggerRef}
                variant="ghost"
                size={compact ? 'icon' : 'sm'}
                className={cn(
                    'text-muted-foreground/70 hover:text-foreground',
                    compact ? 'h-8 w-8' : 'h-8 px-2 gap-1',
                    className
                )}
                disabled={disabled}
                title={t('notes:reference.add_textbook')}
                aria-haspopup="dialog"
                aria-expanded={selectorOpen}
                onClick={() => setSelectorOpen(prev => !prev)}
            >
                <LinkSimple className="h-4 w-4" aria-hidden="true" />
                {!compact && (
                    <>
                        <span className="text-xs hidden sm:inline">
                            {t('notes:reference.add_reference')}
                        </span>
                        <CaretDown
                            className={cn(
                                'h-3 w-3 opacity-50 transition-transform duration-150',
                                selectorOpen && 'rotate-180'
                            )}
                            aria-hidden="true"
                        />
                    </>
                )}
            </NotionButton>

            {/* 教材选择内联面板（锚定在按钮下方展开） */}
            <ReferenceSelector
                open={selectorOpen}
                onOpenChange={setSelectorOpen}
                type="textbook"
                onSelect={handleTextbookSelect}
                existingRefs={existingRefs}
                anchorRef={triggerRef}
                hint={selectedFolderId
                    ? t('notes:reference.add_to_folder')
                    : t('notes:reference.add_to_root')}
            />
        </>
    );
};

export default AddReferenceDropdown;
