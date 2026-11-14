import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

let env: AnkiTestEnv | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await env?.dispose();
  env = undefined;
});

it('batch export creates an isolated template model instead of reusing Anki Basic', async () => {
  env = await createAnkiTestEnv({ migrationScope: ['mistakes'], withReview: false });
  const templateId = await env.host.invoke<string>('create_custom_template', {
    request: {
      name: 'Batch template', description: '', note_type: 'Basic',
      preview_front: '', preview_back: '', version: '1.0.0',
      fields: ['Front', 'Back'], front_template: '<b>{{Front}}</b>',
      back_template: '{{FrontSide}}<hr>{{Back}}', css_style: '.card { color: red; }',
      generation_prompt: 'Generate question and answer.', field_extraction_rules: {
        Front: { field_type: 'Text', is_required: true, description: 'Question' },
        Back: { field_type: 'Text', is_required: true, description: 'Answer' },
      },
    },
  });
  const modelName = `Deep Student / ${templateId} / v1.0.0`;
  const requests: { action: string; params?: Record<string, unknown> }[] = [];
  vi.spyOn(net, 'connect').mockImplementation((() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = () => socket;
    setImmediate(() => socket.emit('connect'));
    return socket;
  }) as typeof net.connect);
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('');
    const request = JSON.parse(String(init.body));
    requests.push(request);
    let result: unknown = null;
    switch (request.action) {
      case 'version': result = 6; break;
      case 'createDeck': result = 1; break;
      case 'modelNames': result = ['Basic']; break;
      case 'modelFieldNames': result = ['Front', 'Back']; break;
      case 'modelTemplates': result = { 'Card 1': { Front: '{{Front}}', Back: '{{Back}}' } }; break;
      case 'modelStyling': result = { css: '' }; break;
      case 'canAddNotes': result = [true]; break;
      case 'addNotes': result = [42]; break;
    }
    return new Response(JSON.stringify({ result, error: null }));
  });

  const result = await env.host.invoke<string>('batch_export_cards', {
    notes: [{ fields: { Front: 'question', Back: 'answer' } }],
    format: 'anki-connect', options: { templateId, noteType: 'Basic' },
  });
  expect(JSON.parse(result)).toMatchObject({ added: 1, failed: 0, createdModels: [modelName] });
  expect(requests.find(request => request.action === 'createModel')?.params).toMatchObject({
    modelName, cardTemplates: [{ Name: 'Card 1', Front: '<b>{{Front}}</b>', Back: '{{FrontSide}}<hr>{{Back}}' }],
  });
  expect(requests.find(request => request.action === 'addNotes')?.params).toMatchObject({
    notes: [{ modelName, fields: { Front: 'question', Back: 'answer' } }],
  });
  expect(requests.some(request => request.action === 'updateModelTemplates')).toBe(false);
});
