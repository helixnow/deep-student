import { expect, it } from 'vitest';
import type {
  CustomAnkiTemplate, TemplateDatabase, ToolExecutionContext, ToolResultInfo,
} from '../api.ts';
import { ChatAnkiExecutor } from '../src/chatanki-executor.ts';

function makeTemplate(id: string, name: string): CustomAnkiTemplate {
  return {
    id, name, description: `${name} description`, author: null, version: '1.0.0',
    preview_front: '', preview_back: '', note_type: 'Basic', fields: ['Front', 'Back'],
    generation_prompt: '', front_template: '', back_template: '', css_style: '',
    field_extraction_rules: {}, created_at: '2026-07-14T00:00:00Z',
    updated_at: '2026-07-14T00:00:00Z', is_active: true, is_built_in: false,
    preview_data_json: null,
  };
}

/** Models dstu-storage `ORDER BY created_at DESC, id ASC`. */
class TemplateStoreDouble implements TemplateDatabase {
  private readonly templates: CustomAnkiTemplate[] = [];
  add(template: CustomAnkiTemplate): void {
    this.templates.push(template);
  }
  getAllCustomTemplates(): CustomAnkiTemplate[] {
    return [...this.templates].sort((left, right) => {
      if (left.created_at !== right.created_at) {
        return left.created_at < right.created_at ? 1 : -1;
      }
      return left.id.localeCompare(right.id);
    });
  }
  getCustomTemplateById(id: string): CustomAnkiTemplate | null {
    return this.templates.find((template) => template.id === id) ?? null;
  }
  createCustomTemplate(): string { throw new Error('not used'); }
  updateCustomTemplate(): void { throw new Error('not used'); }
  markTemplateUserModified(): void { throw new Error('not used'); }
  countAnkiCardsReferencingTemplate(): number { return 0; }
  softDeleteBuiltinTemplate(): void { throw new Error('not used'); }
  deleteCustomTemplate(): void { throw new Error('not used'); }
  setDefaultTemplate(): void { throw new Error('not used'); }
  importBuiltinTemplatesIfEmpty(): void { throw new Error('not used'); }
}

function context(db: TemplateDatabase): ToolExecutionContext {
  return {
    sessionId: 'session-template-order', messageId: 'msg-template-order',
    blockId: 'block-template-order', mainDb: db,
    emitToolCallStart: () => undefined,
    emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: () => undefined,
  };
}

async function runListTemplates(
  db: TemplateDatabase, args: Record<string, unknown>,
): Promise<ToolResultInfo> {
  const executor = new ChatAnkiExecutor();
  return executor.execute(
    { id: 'call-list-templates', name: 'builtin-chatanki_list_templates', arguments: args },
    context(db),
  );
}

it('test_chatanki_list_templates_uses_stable_id_order_for_equal_timestamps', async () => {
  const db = new TemplateStoreDouble();
  for (const [id, name] of [
    ['template-b', 'Stable B'],
    ['template-c', 'Stable C'],
    ['template-a', 'Stable A'],
  ] as const) {
    db.add(makeTemplate(id, name));
  }

  const ordered = db.getAllCustomTemplates().map((template) => template.id);
  expect(ordered).toEqual(['template-a', 'template-b', 'template-c']);

  const first = await runListTemplates(db, { page: 1, pageSize: 2 });
  expect(first.success).toBe(true);
  const firstOutput = first.output as Record<string, unknown>;
  expect(firstOutput.status).toBe('ok');
  expect(firstOutput.total).toBe(3);
  expect(firstOutput.page).toBe(1);
  expect(firstOutput.pageSize).toBe(2);
  expect(firstOutput.count).toBe(2);
  expect(firstOutput.query).toBeNull();
  expect((firstOutput.templates as Array<Record<string, unknown>>).map((item) => item.id))
    .toEqual(['template-a', 'template-b']);

  const second = await runListTemplates(db, { page: 2, pageSize: 2 });
  const secondOutput = second.output as Record<string, unknown>;
  expect(secondOutput.total).toBe(3);
  expect(secondOutput.count).toBe(1);
  expect((secondOutput.templates as Array<Record<string, unknown>>).map((item) => item.id))
    .toEqual(['template-c']);
});
