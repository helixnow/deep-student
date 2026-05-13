import React from "react";
import { useTranslation } from "react-i18next";
import { Type, Info } from "lucide-react";

/**
 * 笔记排版样式面板
 * 
 * 注意：Crepe 编辑器（基于 Milkdown）是纯 Markdown 编辑器，
 * 不支持富文本样式（字体、字号、行高等）。
 * 
 * 此面板暂时显示提示信息。如需样式控制，请通过全局 CSS 变量调整。
 */
export const NotesStylePanel: React.FC = () => {
    const { t } = useTranslation(['notes', 'common']);

    return (
        <div className="flex flex-col gap-2 p-3">
            <div className="flex items-center gap-1.5">
                <Type className="w-3 h-3 text-muted-foreground/70" />
                <h3 className="text-[10px] font-bold text-muted-foreground/70 uppercase tracking-wider">
                    {t('notes:context.typography_title', 'Typography')}
                </h3>
            </div>
            <div className="flex items-start gap-2 p-2 rounded-md bg-muted/30 text-muted-foreground">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <p className="text-[10px] leading-relaxed">
                    {t('notes:context.typography_markdown_hint', 'Markdown editor uses default styling. Rich text formatting (fonts, sizes) is not supported.')}
                </p>
            </div>
        </div>
    );
};
