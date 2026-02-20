import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotesAPI, type NoteItem } from "@/utils/notesApi";
import { getErrorMessage } from "@/utils/errorUtils";
import { History, RotateCcw, Diff } from "lucide-react";
import { showGlobalNotification } from '@/components/UnifiedNotification';

interface DstuVersionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noteId: string;
  currentTitle: string;
  currentContent: string;
  onRevertSuccess: () => void;
}

export const DstuVersionsDialog: React.FC<DstuVersionsDialogProps> = ({
  open,
  onOpenChange,
  noteId,
  currentTitle,
  currentContent,
  onRevertSuccess
}) => {
  const { t } = useTranslation(["notes", "common"]);

  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<Array<{ version_id: string; created_at: string }>>([]);
  const [compare, setCompare] = useState<{ left?: { title: string; content_md: string }; right?: { title: string; content_md: string } } | null>(null);

  const loadVersions = useCallback(async () => {
    if (!open || !noteId) return;
    setLoading(true);
    try {
      const rows = await NotesAPI.listVersions(noteId);
      setVersions(rows);
    } catch (e: unknown) {
      showGlobalNotification('error', t('notes:versions.load_failed', '加载版本失败') + ': ' + getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [open, noteId, t]);

  useEffect(() => { if (open) { loadVersions(); } }, [open, loadVersions]);

  const handleRevert = async (versionId: string, asNew?: boolean) => {
    if (!noteId) return;
    try {
      if (asNew) {
        await NotesAPI.revertAsNewVersion(noteId, versionId, 'rollback');
      } else {
        await NotesAPI.revertVersion(noteId, versionId);
      }
      showGlobalNotification('success', t('notes:versions.revert_success', '已回滚到所选版本'));
      onRevertSuccess();
      onOpenChange(false);
    } catch (e: unknown) {
      showGlobalNotification('error', t('notes:versions.revert_failed', '回滚失败') + ': ' + getErrorMessage(e));
    }
  };

  const handleCompare = async (versionId: string) => {
    if (!noteId) return;
    try {
      const left = await NotesAPI.getVersion(noteId, versionId);
      // 使用当前笔记作为右侧（当前版本），无需再次请求
      const right = { title: currentTitle, content_md: currentContent };
      setCompare({ left: { title: left.title, content_md: left.content_md }, right: { title: right.title, content_md: right.content_md } });
    } catch (e: unknown) {
      showGlobalNotification('error', t('notes:versions.load_failed', '加载版本失败') + ': ' + getErrorMessage(e));
    }
  };

  const renderDiff = () => {
    if (!compare?.left || !compare?.right) return null;
    const a = (compare.left.content_md || '').split('\n');
    const b = (compare.right.content_md || '').split('\n');
    const max = Math.max(a.length, b.length);
    const rows = [] as Array<{ left?: string; right?: string; changed: boolean }>;
    for (let i = 0; i < max; i++) {
      const l = a[i] ?? '';
      const r = b[i] ?? '';
      rows.push({ left: l, right: r, changed: l !== r });
    }
    return (
      <div className="grid grid-cols-2 gap-2 h-[40vh]">
        <div className="border border-border/40 rounded-lg overflow-auto p-3 text-xs bg-background/50 leading-relaxed font-mono">
          {rows.map((row, idx) => (
            <div key={idx} className={`px-2 py-0.5 rounded ${row.changed ? 'bg-red-500/10 text-red-500' : 'text-muted-foreground'}`}>{row.left || ' '}</div>
          ))}
        </div>
        <div className="border border-border/40 rounded-lg overflow-auto p-3 text-xs bg-background/50 leading-relaxed font-mono">
          {rows.map((row, idx) => (
            <div key={idx} className={`px-2 py-0.5 rounded ${row.changed ? 'bg-green-500/10 text-green-500' : 'text-muted-foreground'}`}>{row.right || ' '}</div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-4xl">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {t('notes:versions.title', '版本历史')}
          </NotionDialogTitle>
        </NotionDialogHeader>
        <NotionDialogBody>
          {loading ? (
            <div className="flex justify-center py-12"><span className="loading loading-spinner loading-md" /></div>
          ) : versions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <History className="h-12 w-12 mb-4 opacity-20" />
              <p>{t('notes:versions.empty', '暂无历史版本')}</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[30vh] overflow-y-auto pr-2">
              {versions.map(v => (
                <div key={v.version_id} className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-card hover:bg-accent/50 transition-colors group">
                  <div className="text-sm font-medium">
                    {new Date(v.created_at).toLocaleString()}
                  </div>
                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <NotionButton variant="ghost" size="sm" onClick={() => handleCompare(v.version_id)} className="h-8">
                      {t('notes:versions.compare', '对比')}
                    </NotionButton>
                    <NotionButton variant="ghost" size="sm" onClick={() => handleRevert(v.version_id)} className="h-8 text-primary hover:text-primary">
                      <RotateCcw className="h-3.5 w-3.5 mr-1.5" />{t('notes:versions.revert', '回滚')}
                    </NotionButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </NotionDialogBody>
        {compare && (
          <div className="px-6 py-5 border-t border-border/40 bg-muted/10">
            <div className="flex items-center gap-2 mb-3 text-sm font-medium text-foreground">
              <Diff className="h-4 w-4 text-primary" />
              {t('notes:versions.compare', '对比改动')}
            </div>
            {renderDiff()}
          </div>
        )}
        <NotionDialogFooter>
          <NotionButton variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('common:actions.close', '关闭')}</NotionButton>
        </NotionDialogFooter>
    </NotionDialog>
  );
}
