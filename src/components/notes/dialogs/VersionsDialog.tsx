import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogBody, NotionDialogFooter } from '../../ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useNotes } from "../NotesContext";
import { NotesAPI, type NoteItem } from "../../../utils/notesApi";
import { getErrorMessage } from "../../../utils/errorUtils";
import { History, RotateCcw, Diff } from "lucide-react";

export default function VersionsDialog() {
  const { t } = useTranslation(["notes", "common"]);
  const { versionsOpen, setVersionsOpen, active, notify, setActive, forceRefreshNoteContent } = useNotes();

  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<Array<{ version_id: string; created_at: string }>>([]);
  const [compare, setCompare] = useState<{ left?: { title: string; content_md: string }; right?: { title: string; content_md: string } } | null>(null);

  const loadVersions = useCallback(async () => {
    if (!versionsOpen || !active?.id) return;
    setLoading(true);
    try {
      const rows = await NotesAPI.listVersions(active.id);
      setVersions(rows);
    } catch (e: unknown) {
      notify({ title: t('notes:versions.load_failed', '加载版本失败'), description: getErrorMessage(e), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [versionsOpen, active?.id, notify, t]);

  useEffect(() => { if (versionsOpen) { loadVersions(); } }, [versionsOpen, loadVersions]);

  const handleRevert = async (versionId: string, asNew?: boolean) => {
    if (!active?.id) return;
    try {
      let note: NoteItem;
      if (asNew) {
        note = await NotesAPI.revertAsNewVersion(active.id, versionId, 'rollback');
      } else {
        note = await NotesAPI.revertVersion(active.id, versionId);
      }
      setActive(note);
      notify({ title: t('notes:versions.revert_success', '已回滚到所选版本'), variant: 'success' });
      // 强制刷新正文（绕过 loadedContentIds 缓存）
      await forceRefreshNoteContent(note.id);
      setVersionsOpen(false);
    } catch (e: unknown) {
      notify({ title: t('notes:versions.revert_failed', '回滚失败'), description: getErrorMessage(e), variant: 'destructive' });
    }
  };

  const handleCompare = async (versionId: string) => {
    if (!active?.id) return;
    try {
      const left = await NotesAPI.getVersion(active.id, versionId);
      // 使用当前 active 笔记作为右侧（当前版本），无需再次请求
      const right = { title: active.title, content_md: active.content_md };
      setCompare({ left: { title: left.title, content_md: left.content_md }, right: { title: right.title, content_md: right.content_md } });
    } catch (e: unknown) {
      notify({ title: t('notes:versions.load_failed', '加载版本失败'), description: getErrorMessage(e), variant: 'destructive' });
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
        <div className="border rounded overflow-auto p-2 text-xs bg-background">
          {rows.map((row, idx) => (
            <div key={idx} className={`px-1 ${row.changed ? 'bg-red-50 dark:bg-red-900/20' : ''}`}>{row.left}</div>
          ))}
        </div>
        <div className="border rounded overflow-auto p-2 text-xs bg-background">
          {rows.map((row, idx) => (
            <div key={idx} className={`px-1 ${row.changed ? 'bg-green-50 dark:bg-green-900/20' : ''}`}>{row.right}</div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <NotionDialog open={versionsOpen} onOpenChange={setVersionsOpen} maxWidth="max-w-2xl">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {t('notes:versions.title', '版本历史')}
          </NotionDialogTitle>
        </NotionDialogHeader>
        <NotionDialogBody>
          {loading ? (
            <div className="flex justify-center py-8"><span className="loading loading-spinner loading-md" /></div>
          ) : versions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <History className="h-12 w-12 mb-4 opacity-20" />
              <p>{t('notes:versions.empty', '暂无历史版本')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {versions.map(v => (
                <div key={v.version_id} className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-card">
                  <div className="text-sm text-muted-foreground">
                    {new Date(v.created_at).toLocaleString()}
                  </div>
                  <div className="flex items-center gap-1">
                    <NotionButton variant="ghost" size="sm" onClick={() => handleRevert(v.version_id)}>
                      <RotateCcw className="h-4 w-4 mr-1" />{t('notes:versions.revert', '回滚')}
                    </NotionButton>
                    <NotionButton variant="ghost" size="sm" onClick={() => handleRevert(v.version_id, true)}>
                      {t('notes:versions.revert_as_new', '作为新版本回滚')}
                    </NotionButton>
                    <NotionButton variant="ghost" size="sm" onClick={() => handleCompare(v.version_id)}>
                      {t('notes:versions.compare', '对比')}
                    </NotionButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </NotionDialogBody>
        {compare && (
          <div className="px-5 py-4 border-t border-border/40">
            <div className="flex items-center gap-2 mb-2 text-sm text-muted-foreground">
              <Diff className="h-4 w-4" />
              {t('notes:versions.compare', '对比')}
            </div>
            {renderDiff()}
          </div>
        )}
        <NotionDialogFooter>
          <NotionButton variant="ghost" size="sm" onClick={() => setVersionsOpen(false)}>{t('common:actions.close')}</NotionButton>
        </NotionDialogFooter>
    </NotionDialog>
  );
}
