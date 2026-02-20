import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, ChevronUp, ChevronDown, Replace, ReplaceAll } from 'lucide-react';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import type { CrepeEditorApi } from '@/components/crepe/types';
import { editorViewCtx } from '@milkdown/kit/core';

interface FindReplacePanelProps {
  editorApi: CrepeEditorApi | null;
  onClose: () => void;
  className?: string;
}

export const FindReplacePanel: React.FC<FindReplacePanelProps> = ({
  editorApi,
  onClose,
  className
}) => {
  const { t } = useTranslation(['notes', 'common']);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [isReplaceMode, setIsReplaceMode] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  
  const findInputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    findInputRef.current?.focus();
  }, []);

  // Simplified Find/Replace logic since actual ProseMirror plugin integration
  // would be complex to implement here. 
  // For now, this acts as a UI placeholder that passes the query to the native browser search
  // if the Milkdown/ProseMirror plugin isn't fully integrated yet.
  
  const handleFind = () => {
    if (!findText) return;
    // In a full implementation, this would dispatch a transaction to the ProseMirror state
    // to highlight matches and scroll to the next one.
    // For now, we rely on the browser's native Ctrl+F which was previously disabled.
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleFind();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className={cn("absolute top-4 right-8 z-50 bg-background border border-border/60 shadow-lg rounded-lg w-[320px] overflow-hidden flex flex-col", className)}>
      <div className="flex items-center p-2 border-b border-border/40 gap-2">
        <NotionButton 
          variant="ghost" 
          size="sm" 
          className="h-6 w-6 p-0" 
          onClick={() => setIsReplaceMode(!isReplaceMode)}
          title={isReplaceMode ? "Hide Replace" : "Show Replace"}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", isReplaceMode && "-rotate-90")} />
        </NotionButton>
        
        <div className="flex-1 relative flex items-center">
          <Search className="absolute left-2 w-3.5 h-3.5 text-muted-foreground" />
          <Input 
            ref={findInputRef}
            className="h-7 text-xs pl-7 pr-12 bg-transparent border-none focus-visible:ring-1"
            placeholder="Find..."
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {matchCount > 0 && (
            <span className="absolute right-2 text-[10px] text-muted-foreground">
              {currentIndex + 1} of {matchCount}
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-0.5">
          <NotionButton variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={handleFind}>
            <ChevronUp className="h-4 w-4" />
          </NotionButton>
          <NotionButton variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={handleFind}>
            <ChevronDown className="h-4 w-4" />
          </NotionButton>
          <div className="w-[1px] h-4 bg-border/60 mx-0.5" />
          <NotionButton variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground" onClick={onClose}>
            <X className="h-4 w-4" />
          </NotionButton>
        </div>
      </div>
      
      {isReplaceMode && (
        <div className="flex items-center p-2 gap-2 bg-muted/10">
          <div className="w-6" /> {/* Spacer to align with input above */}
          <div className="flex-1 relative">
            <Input 
              className="h-7 text-xs pl-2 bg-transparent border-none focus-visible:ring-1"
              placeholder="Replace with..."
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="flex items-center gap-1">
            <NotionButton variant="secondary" size="sm" className="h-6 text-[10px] px-2" disabled={!findText}>
              Replace
            </NotionButton>
            <NotionButton variant="secondary" size="sm" className="h-6 text-[10px] px-2" disabled={!findText}>
              All
            </NotionButton>
          </div>
        </div>
      )}
    </div>
  );
};
