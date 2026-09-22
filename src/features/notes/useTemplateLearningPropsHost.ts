import { useEffect, useRef } from 'react';
import { dstu, updatedAtToVersionToken } from '@/dstu';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { learningPropsFromMetadata } from './noteLearningProps';
import { mergeNotePropEdits } from './notePropEdits';
import type { NoteTemplateLearningPropsHost } from './noteTemplates';

/** Uses the existing metadata contract; content's OCC baseline is never advanced. */
export function useTemplateLearningPropsHost(noteId: string | undefined, readOnly: boolean): NoteTemplateLearningPropsHost {
  const current = useRef({ noteId, readOnly });
  current.current = { noteId, readOnly };
  const loaded = useRef<{ noteId: string; props: Record<string, unknown> }>();
  const failure = useRef<unknown>();
  useEffect(() => {
    let active = true;
    loaded.current = undefined; failure.current = undefined;
    if (noteId) void dstu.get(`/${noteId}`).then(result => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error.toUserMessage());
      if (!result.value || result.value.id !== noteId) throw new Error('笔记属性不可用。');
      loaded.current = { noteId, props: { ...learningPropsFromMetadata(result.value.metadata) } };
    }).catch(error => { if (active) failure.current = error; });
    return () => { active = false; };
  }, [noteId]);
  return {
    getProps: () => {
      if (current.current.noteId !== noteId) throw new Error('笔记已切换。');
      if (failure.current) throw failure.current;
      if (!loaded.current || loaded.current.noteId !== noteId) throw new Error('笔记属性仍在加载，请稍后重试预览。');
      return { noteId: loaded.current.noteId, props: { ...loaded.current.props } };
    },
    saveProps: async (next, baseline) => {
      const assertEditable = () => {
        if (!noteId || baseline.noteId !== noteId || current.current.noteId !== noteId || current.current.readOnly) throw new Error('笔记已切换或不可编辑。');
        if (useSystemStatusStore.getState().maintenanceMode) throw new Error('维护期间无法保存属性。');
      };
      assertEditable();
      const fresh = await dstu.get(`/${noteId}`);
      assertEditable();
      if (!fresh.ok) throw new Error(fresh.error.toUserMessage());
      if (!fresh.value || fresh.value.id !== noteId || fresh.value.type !== 'note') throw new Error('笔记属性归属已变化。');
      const props = mergeNotePropEdits(baseline.props, next, learningPropsFromMetadata(fresh.value.metadata));
      const version = updatedAtToVersionToken(fresh.value.updatedAt);
      if (!version) throw new Error('属性保存版本不可用。');
      const result = await dstu.setMetadata(fresh.value.path, { props }, version);
      if (!result.ok) throw new Error(result.error.toUserMessage());
      if (current.current.noteId === noteId) loaded.current = { noteId: noteId!, props };
    },
  };
}
