import { dstu, updatedAtToVersionToken, type DstuNode } from '@/dstu';
import { fillUnsetTemplateLearningProps, renderNoteTemplate, type NoteTemplate } from './noteTemplates';
import { learningPropsFromMetadata, updateNoteLearningProps, type LearningField } from './noteLearningProps';
import { mergeNotePropEdits } from './notePropEdits';
import { validateNoteTitle } from './noteInputLimits';
import i18n from '@/i18n';

export interface CreateLearningNoteInput {
  title: string;
  course: string;
  template?: NoteTemplate;
  folderId?: string | null;
  /** Explicit form edits take precedence over defaults, including empty/unset. */
  changes?: Partial<Record<LearningField, string>>;
}
export class LearningNoteInitializationError extends Error {
  constructor(public readonly node: DstuNode, public readonly props: Record<string, unknown>, cause: unknown) {
    super(i18n.t('notes:learning.create.props_failed', { defaultValue: '笔记正文已创建，属性尚未保存：{{error}}', error: cause instanceof Error ? cause.message : String(cause) }));
  }
}

/** Resume only metadata after a failed initialization; never create the body twice. */
export async function finishLearningNoteCreation(node: DstuNode, props: Record<string, unknown>): Promise<DstuNode> {
  if (!Object.keys(props).length) return node;
  try {
    const fresh = await dstu.get(node.path);
    if (!fresh.ok) throw new Error(fresh.error.toUserMessage());
    if (fresh.value.id !== node.id || fresh.value.type !== 'note') throw new Error(i18n.t('notes:learning.errors.identity_changed'));
    const next = mergeNotePropEdits(learningPropsFromMetadata(node.metadata), props, learningPropsFromMetadata(fresh.value.metadata));
    const version = updatedAtToVersionToken(fresh.value.updatedAt);
    if (!version) throw new Error(i18n.t('notes:learning.errors.version_unavailable'));
    const saved = await dstu.setMetadata(fresh.value.path, { props: next }, version);
    if (!saved.ok) throw new Error(saved.error.toUserMessage());
    const result = await dstu.get(fresh.value.path);
    if (!result.ok) throw new Error(result.error.toUserMessage());
    return result.value;
  } catch (cause) { throw new LearningNoteInitializationError(node, props, cause); }
}

/** dstu_create currently ignores props. The second, versioned metadata step is explicit and resumable. */
export async function createLearningNote(input: CreateLearningNoteInput): Promise<DstuNode> {
  const title = input.title.trim();
  if (!title || validateNoteTitle(title)) throw new Error(i18n.t('notes:learning.create.invalid_title', { defaultValue: '请输入有效的笔记标题。' }));
  const selectedCourse = input.course.trim();
  let props = updateNoteLearningProps({}, selectedCourse ? { course: selectedCourse } : {});
  props = fillUnsetTemplateLearningProps(props, input.template?.learningPreset ?? {});
  props = updateNoteLearningProps(props, input.changes ?? {});
  const content = input.template ? renderNoteTemplate(input.template.markdown, { title, locale: i18n.resolvedLanguage ?? i18n.language }) : '';
  const result = await dstu.create('/', { type: 'note', name: title, content, metadata: input.folderId ? { folderId: input.folderId } : {} });
  if (!result.ok) throw new Error(result.error.toUserMessage());
  return finishLearningNoteCreation(result.value, props);
}
