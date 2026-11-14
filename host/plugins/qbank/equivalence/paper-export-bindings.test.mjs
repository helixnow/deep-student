// Runner-contract test only: no Host/Tauri recording and no claim of product equivalence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { executeScenario } from '../../../../scripts/electron-migration/record/scenario-v0.mjs';
import { waitForEvent } from '../../../../scripts/electron-migration/record/g3-wait.mjs';

const suite = JSON.parse(readFileSync(new URL('./pending-provider/g3-paper-exam-pending.json', import.meta.url)));
const event = (name, payload) => ({ event: name, payloadRaw: JSON.stringify(payload) });

for (const scenario of suite.scenarios) {
  test(`${scenario.id}: completes the request captured from this send, not an old event`, async () => {
    const format = scenario.steps[5].waitAfter.payload.format;
    const events = [event('qbank-export-paper', { request_id: 'old', format })];
    let assistantMessageId, completed = false;
    const trace = await executeScenario(scenario, {
      bindings: { llm: { baseUrl: 'http://127.0.0.1:47110' } },
      eventCount: () => events.length,
      async invoke(command, raw) {
        const args = JSON.parse(raw);
        let result = null;
        if (command === 'dstu_create') result = { id: 'exam-real-result' };
        if (command === 'chat_v2_create_session') result = { id: 'chat-real-result' };
        if (command === 'chat_v2_send_message') {
          const request = args.request;
          assert.equal(request.sessionId, 'chat-real-result');
          assistantMessageId = request.assistantMessageId;
          const directive = JSON.parse(request.content.slice('W0_DIRECTIVE '.length));
          const tool = directive.rounds[0][0];
          assert.equal(tool.name, 'builtin-qbank_generate_paper');
          assert.equal(tool.arguments.session_id, 'exam-real-result');
          assert.equal(tool.arguments.config.export_format, format);
          events.push(event('qbank-export-paper', { request_id: 'wrong-format', format: 'pdf' }),
            event('qbank-export-paper', { request_id: 'new-request', format, paper: { title: 'Captured paper' } }));
        }
        if (command === 'qbank_export_paper_docx') {
          assert.equal(args.title, 'Captured paper');
          // Opaque adapter result proves the scenario forwards the actual command result.
          result = 'adapter-docx-result';
        }
        if (command === 'qbank_complete_paper_export') {
          assert.equal(args.requestId, 'new-request');
          assert.equal(args.data, format === 'word' ? 'adapter-docx-result' : 'aGVsbG8=');
          assert.equal(args.error, null);
          completed = true;
          events.push(event('chat_v2_session_chat-real-result', { eventType: 'stream_complete', messageId: assistantMessageId }));
        }
        return { kind: 'result', raw: JSON.stringify(result) };
      },
      wait: (spec, { since }) => waitForEvent(spec, () => events, scenario.id, { since }),
      capture: async () => ({ events: [...events], databases: {} }),
    });
    assert.equal(completed, true);
    assert.equal(trace.calls.length, scenario.steps.length);
  });
}
