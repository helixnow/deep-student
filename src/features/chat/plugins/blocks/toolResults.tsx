/**
 * Built-in `chat.toolResults` contributions: dedicated views of the mcp_tool block, keyed by base tool name.
 * Contributed to the kernel by the official chat UI plugin; the mcp_tool block also uses this table
 * directly before that plugin is installed (or without a kernel Provider).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOut, Eye, FileText, FileXls } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { SlotContribution } from '@/ui-kernel/slots';
import type { ChatToolResultContribution, ChatToolResultProps } from '@/ui-kernel/contracts/chat';
import type { Block } from '../../core/types/block';
import { CompletionCard, extractCompletionData } from '../../components/CompletionCard';
import { ShellOutputView } from './components';
import { TodoListBlock } from './todoList';
import { PaperSaveBlock } from './paperSave';

// ============================================================================
// Views
// ============================================================================

/** TodoList 工具（永续执行 Agent）：构造 todo_list 块供 TodoListBlock 使用。 */
const TodoToolResult: React.FC<ChatToolResultProps> = ({ block, isStreaming, toolOutput }) => {
  const rawOutput = toolOutput as { result?: Record<string, unknown> } | undefined;
  const todoData = rawOutput?.result || toolOutput;
  const todoBlock: Block = {
    ...block,
    type: 'todo_list',
    toolOutput: todoData,
  };
  return <TodoListBlock block={todoBlock} isStreaming={isStreaming} />;
};

/** PaperSave：专用进度组件显示细粒度下载进度。 */
const PaperSaveToolResult: React.FC<ChatToolResultProps> = ({ block, isStreaming }) => (
  <PaperSaveBlock block={block} isStreaming={isStreaming} />
);

/** attempt_completion：提取逻辑统一走 CompletionCard 的 extractCompletionData（兼容嵌套 result 与 toolInput 回退）。 */
const CompletionToolResult: React.FC<ChatToolResultProps> = ({ toolInput, toolOutput }) => (
  <CompletionCard data={extractCompletionData(toolInput, toolOutput)} />
);

/** 本地 shell 执行工具：stdout/stderr 分栏输出。 */
const ShellToolResult: React.FC<ChatToolResultProps> = ({ toolOutput }) => <ShellOutputView output={toolOutput} />;

/** 根据工具名称获取对应的文件类型图标（DOCX 和 PPTX 都用 FileText）。 */
function getDocToolFileIcon(toolName: string): typeof FileText {
  const stripped = toolName.replace(/^builtin[-:]/, '').replace(/^mcp_/, '');
  if (stripped.startsWith('xlsx')) return FileXls;
  return FileText;
}

/** 从 DOCX/PPTX/XLSX 工具输出中提取 file_id 和 file_name。 */
function extractDocWriteFileInfo(toolOutput: unknown): { fileId: string; fileName: string } | null {
  if (toolOutput && typeof toolOutput === 'object') {
    const output = toolOutput as Record<string, unknown>;
    const fileId = (output.file_id || output.new_file_id) as string | undefined;
    const fileName = (output.file_name || 'document') as string;
    if (fileId) {
      return { fileId, fileName };
    }
  }
  return null;
}

/** 从读取类工具的输出/输入中提取 resource_id 和显示标题。 */
function extractDocReadInfo(toolOutput: unknown, toolInput: Record<string, unknown>): { resourceId: string; title: string } | null {
  let resourceId: string | undefined;
  let title: string | undefined;

  // 优先从 output 中取（后端返回的 resource_id）；output 可能被包裹在 result 中
  if (toolOutput && typeof toolOutput === 'object') {
    const output = toolOutput as Record<string, unknown>;
    const inner = (output.result && typeof output.result === 'object') ? output.result as Record<string, unknown> : output;
    resourceId = inner.resource_id as string | undefined;
    if (inner.metadata && typeof inner.metadata === 'object') {
      const meta = inner.metadata as Record<string, unknown>;
      title = (meta.title || meta.file_name || meta.name) as string | undefined;
    }
  }
  // 回退到 input 参数中的 resource_id
  if (!resourceId && typeof toolInput.resource_id === 'string' && toolInput.resource_id) {
    resourceId = toolInput.resource_id;
  }
  if (!resourceId) return null;
  return { resourceId, title: title || resourceId };
}

/** 从工具输出中提取 note_id（多种字段名，回退到 toolInput）。 */
function extractNoteId(toolOutput: unknown, toolInput: Record<string, unknown>): string | null {
  if (toolOutput && typeof toolOutput === 'object') {
    const output = toolOutput as Record<string, unknown>;
    const noteId = output.note_id || output.noteId || output.id ||
      (output.result && typeof output.result === 'object' && (output.result as Record<string, unknown>).note_id) ||
      (output.result && typeof output.result === 'object' && (output.result as Record<string, unknown>).noteId) ||
      (output.result && typeof output.result === 'object' && (output.result as Record<string, unknown>).id);
    if (typeof noteId === 'string' && noteId) {
      return noteId;
    }
  }
  if (toolInput.note_id && typeof toolInput.note_id === 'string') {
    return toolInput.note_id;
  }
  if (toolInput.noteId && typeof toolInput.noteId === 'string') {
    return toolInput.noteId;
  }
  return null;
}

/** DOCX/PPTX/XLSX 写入工具：文件引用卡片 + 跳转按钮。 */
const DocWriteActions: React.FC<ChatToolResultProps> = ({ toolName, toolOutput }) => {
  const fileInfo = extractDocWriteFileInfo(toolOutput);
  if (!fileInfo) return null;
  const DocIcon = getDocToolFileIcon(toolName);
  return (
    <div className="mt-2 flex items-center gap-2">
      <DsButton
        variant="outline"
        size="sm"
        onClick={() => {
          window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
            detail: {
              id: fileInfo.fileId,
              type: 'file',
              title: fileInfo.fileName,
            }
          }));
        }}
        className="bg-muted/30 hover:bg-[var(--interactive-hover)] gap-1.5 [@media(pointer:coarse)]:!min-h-11"
      >
        <DocIcon size={12} />
        <span className="truncate max-w-[200px]">{fileInfo.fileName}</span>
        <ArrowSquareOut size={10} className="text-muted-foreground shrink-0" />
      </DsButton>
    </div>
  );
};

/** DOCX/PPTX/XLSX 读取工具：源文件引用按钮。 */
const DocReadActions: React.FC<ChatToolResultProps> = ({ toolName, toolInput, toolOutput }) => {
  const { t } = useTranslation('chatV2');
  const readInfo = extractDocReadInfo(toolOutput, toolInput);
  if (!readInfo) return null;
  const DocIcon = getDocToolFileIcon(toolName);
  return (
    <DsButton
      variant="outline"
      size="sm"
      onClick={() => {
        window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
          detail: {
            id: readInfo.resourceId,
            type: 'file',
            title: readInfo.title,
          }
        }));
      }}
      className="mt-2 bg-muted/30 hover:bg-[var(--interactive-hover)] gap-1.5 [@media(pointer:coarse)]:!min-h-11"
    >
      <DocIcon size={12} />
      <Eye size={10} />
      {t('blocks.mcpTool.viewSourceFile')}
    </DsButton>
  );
};

/** 笔记工具跳转按钮。 */
const NoteActions: React.FC<ChatToolResultProps> = ({ toolInput, toolOutput }) => {
  const { t } = useTranslation('chatV2');
  const noteId = extractNoteId(toolOutput, toolInput);
  if (!noteId) return null;
  return (
    <DsButton
      variant="outline"
      size="sm"
      onClick={() => {
        window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
          detail: { noteId, source: 'mcp_tool_block' }
        }));
      }}
      className="mt-2 bg-muted/30 hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11"
    >
      <ArrowSquareOut size={12} />
      {t('timeline.noteTool.openNote')}
    </DsButton>
  );
};

// ============================================================================
// Table
// ============================================================================

const TODO_TOOLS = ['todo_init', 'todo_update', 'todo_add', 'todo_get'];
const NOTE_TOOLS = ['note_create', 'note_read', 'note_append', 'note_replace', 'note_set', 'note_list', 'note_search'];
const DOC_WRITE_TOOLS = [
  'docx_create', 'docx_replace_text',
  'pptx_create', 'pptx_replace_text',
  'xlsx_create', 'xlsx_replace_text', 'xlsx_edit_cells',
];
const DOC_READ_TOOLS = [
  'docx_read_structured', 'docx_extract_tables', 'docx_get_metadata', 'docx_to_spec',
  'pptx_read_structured', 'pptx_get_metadata', 'pptx_extract_tables', 'pptx_to_spec',
  'xlsx_read_structured', 'xlsx_extract_tables', 'xlsx_get_metadata', 'xlsx_to_spec',
];

const entries = (group: string, tools: readonly string[], value: ChatToolResultContribution) =>
  tools.map((tool): SlotContribution<ChatToolResultContribution> => ({ id: `dstu.ui.chat/tool-result/${group}/${tool}`, key: tool, value }));

export const officialToolResultEntries: readonly SlotContribution<ChatToolResultContribution>[] = Object.freeze([
  ...entries('todo', TODO_TOOLS, { placement: 'block', component: TodoToolResult }),
  ...entries('paper-save', ['paper_save'], { placement: 'block', component: PaperSaveToolResult, match: 'qualified' }),
  ...entries('completion', ['attempt_completion'], {
    placement: 'block',
    component: CompletionToolResult,
    match: 'qualified',
    when: ({ block, toolOutput }) => block.status === 'success' && !!toolOutput,
  }),
  ...entries('shell', ['local_shell_execute'], { placement: 'output', component: ShellToolResult, match: 'qualified' }),
  ...entries('doc-write', DOC_WRITE_TOOLS, { placement: 'actions', component: DocWriteActions }),
  ...entries('doc-read', DOC_READ_TOOLS, { placement: 'actions', component: DocReadActions }),
  ...entries('note', NOTE_TOOLS, { placement: 'actions', component: NoteActions }),
]);
