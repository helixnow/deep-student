import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventMatches, validateWaitSpec, waitForEvent } from '../../../scripts/electron-migration/record/g3-wait.mjs';
import { executeScenario, resolveReferences, validateScenario } from '../../../scripts/electron-migration/record/scenario-v0.mjs';
import { stringifyExact } from '../../../scripts/electron-migration/record/json.mjs';

const event = (name, payload) => ({ event: name, payloadRaw: typeof payload === 'string' ? payload : JSON.stringify(payload) });
const backup = (status, jobId = 'job-1') => event('backup-job-progress', { job_id: jobId, kind: 'export', status, progress: status === 'completed' ? 100 : 40 });
const stdio = (session, message) => event(`mcp-stdio-${session}-message`, { message: JSON.stringify(message) });

test('backup job events: exact channel plus payload fields, with a step reference and alternatives', () => {
  const outcomes = [{ kind: 'result', raw: '{"job_id":"job-1"}' }];
  const spec = resolveReferences({ channel: 'backup-job-progress', payload: { job_id: '${0.job_id}', status: ['completed', 'failed'] } }, outcomes);
  validateWaitSpec(spec);
  assert.equal(eventMatches(spec, backup('running')), false);
  assert.equal(eventMatches(spec, backup('completed')), true);
  assert.equal(eventMatches(spec, backup('failed')), true);
  assert.equal(eventMatches(spec, backup('completed', 'job-2')), false, 'another job');
  assert.equal(eventMatches(spec, event('backup-job-progress-x', { job_id: 'job-1', status: 'completed' })), false, 'channel is exact');
  // The X5 form could not say this: `event` reads payload.eventType or type:phase, which backup events lack.
  assert.equal(eventMatches({ event: 'completed', channelPrefix: 'backup-job' }, backup('completed')), false);
  // Exact JSON: 100 is not "100".
  assert.equal(eventMatches({ channel: 'backup-job-progress', payload: { progress: 100 } }, backup('completed')), true);
  assert.equal(eventMatches({ channel: 'backup-job-progress', payload: { progress: '100' } }, backup('completed')), false);
});

// Shapes of dstu-vfs pdf_processing_service.rs MediaProcessing{Progress,Completed,Error}Event (camelCase);
// error carries the pipeline's current ProcessingStage (as_str, :171-185), progress nests it in `status`.
const STAGES = ['pending', 'text_extraction', 'page_rendering', 'page_compression', 'image_compression', 'ocr_processing', 'vector_indexing',
  'completed', 'completed_with_issues', 'error', 'queued', 'decode', 'vad', 'asr', 'indexing'];
test('a media pipeline run reaching a terminal state (completed or error, two channels): prefix, file id and the top-level stage', async () => {
  const outcomes = [{ kind: 'result', raw: '{"fileId":"file_1","status":{"stage":"queued","percent":0}}' }];
  const spec = resolveReferences({ channelPrefix: 'media-processing-', payload: { fileId: '${0.fileId}', stage: STAGES } }, outcomes);
  validateWaitSpec(spec);
  const progress = (fileId, stage) => event('media-processing-progress', { fileId, status: { stage, percent: stage === 'completed' ? 100 : 40 }, mediaType: 'audio' });
  const completed = fileId => event('media-processing-completed', { fileId, readyModes: ['text'], stage: 'completed', mediaType: 'audio' });
  const failed = (fileId, stage) => event('media-processing-error', { fileId, error: 'boom', stage, mediaType: 'audio' });
  assert.equal(eventMatches(spec, progress('file_1', 'indexing')), false);
  assert.equal(eventMatches(spec, progress('file_1', 'completed')), false, 'progress has no top-level stage, even at 100%');
  assert.equal(eventMatches(spec, completed('file_1')), true);
  assert.equal(eventMatches(spec, failed('file_1', 'asr')), true);
  assert.equal(eventMatches(spec, completed('file_2')), false, 'another file');
  assert.equal(eventMatches(spec, event('pdf-processing-completed', { fileId: 'file_1', readyModes: [], stage: 'completed', mediaType: 'pdf' })), false, 'the PDF compatibility twin is another prefix');
  // Step 9's wait is not satisfied by step 8's completion: only events after its own invoke count.
  const events = [completed('file_1'), progress('file_1', 'indexing')];
  const waited = waitForEvent(spec, () => events, 'step 9', { since: 1 });
  setTimeout(() => events.push(failed('file_1', 'indexing')), 30);
  await waited;
  assert.equal(events.length, 3);
});

test('channel alternatives: "a|b" names exact channels, each with the same payload matchers', () => {
  const spec = resolveReferences({ channel: 'media-processing-completed|media-processing-error', payload: { fileId: '${0.fileId}' } },
    [{ kind: 'result', raw: '{"fileId":"file_1"}' }]);
  validateWaitSpec(spec);
  assert.equal(eventMatches(spec, event('media-processing-completed', { fileId: 'file_1', stage: 'completed' })), true);
  assert.equal(eventMatches(spec, event('media-processing-error', { fileId: 'file_1', stage: 'asr' })), true);
  assert.equal(eventMatches(spec, event('media-processing-error', { fileId: 'file_2', stage: 'asr' })), false, 'payload still applies to every alternative');
  assert.equal(eventMatches(spec, event('media-processing-progress', { fileId: 'file_1', status: { stage: 'completed' } })), false);
  assert.equal(eventMatches(spec, event('media-processing-completed-x', { fileId: 'file_1' })), false, 'each alternative is exact, not a prefix');
  assert.equal(eventMatches(spec, event('media-processing-completed|media-processing-error', { fileId: 'file_1' })), false, 'the whole text is not a channel');
  // A reference resolved into one alternative; the spec is checked again after resolution.
  const stdioSpec = resolveReferences({ channel: 'mcp-stdio-${0.sessionId}-message|mcp-stdio-${0.sessionId}-closed' }, [{ kind: 'result', raw: '{"sessionId":"s7"}' }]);
  assert.equal(eventMatches(validateWaitSpec(stdioSpec), event('mcp-stdio-s7-closed', { code: 0 })), true);
  assert.equal(eventMatches(stdioSpec, event('mcp-stdio-s8-closed', { code: 0 })), false);
  // A single name keeps its exact meaning.
  assert.equal(eventMatches({ channel: 'backup-job-progress' }, backup('completed')), true);
  assert.equal(eventMatches({ channel: 'backup-job' }, backup('completed')), false);
});

// dstu-qbank task_repo.rs GenerationTaskView (camelCase) with GenerationTaskStatus (snake_case).
test('a qbank generation task reaching a terminal status, for this task only', () => {
  const spec = resolveReferences({ channel: 'qbank_generation_task_event', payload: { id: '${0.id}', status: ['completed', 'failed', 'cancelled'] } },
    [{ kind: 'result', raw: '{"id":"t1","examId":"e1","status":"queued"}' }]);
  const task = (id, status) => event('qbank_generation_task_event', { id, examId: 'e1', status, drafts: [], rejectedCount: 0, error: null });
  assert.deepEqual(['queued', 'running', 'completed', 'failed', 'cancelled'].map(status => eventMatches(spec, task('t1', status))), [false, false, true, true, true]);
  assert.equal(eventMatches(spec, task('t2', 'completed')), false);
});

test('MCP stdio replies: the JSON-RPC id inside payload.message, per session channel', () => {
  const reply = stdio('s7', { jsonrpc: '2.0', id: 2, result: { tools: [] } });
  assert.equal(eventMatches({ channelPrefix: 'mcp-stdio-', jsonrpcId: 2 }, reply), true);
  assert.equal(eventMatches({ channelPrefix: 'mcp-stdio-', jsonrpcId: 3 }, reply), false);
  assert.equal(eventMatches({ channelPrefix: 'mcp-stdio-', jsonrpcId: '2' }, reply), false, 'a string id is another id');
  assert.equal(eventMatches({ channel: 'mcp-stdio-s7-message', jsonrpcId: 2 }, reply), true);
  assert.equal(eventMatches({ channel: 'mcp-stdio-s8-message', jsonrpcId: 2 }, reply), false);
  // The session id comes from the connect step's result.
  const spec = resolveReferences({ channel: 'mcp-stdio-${0.sessionId}-message', jsonrpcId: '${1.id}' },
    [{ kind: 'result', raw: '{"sessionId":"s7"}' }, { kind: 'result', raw: '{"id":2}' }]);
  assert.equal(eventMatches(validateWaitSpec(spec), reply), true);
  // A notification has no id; a non-JSON message never matches.
  assert.equal(eventMatches({ channelPrefix: 'mcp-stdio-', jsonrpcId: 2 }, stdio('s7', { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })), false);
  assert.equal(eventMatches({ channelPrefix: 'mcp-stdio-', jsonrpcId: 2 }, event('mcp-stdio-s7-message', { message: 'not json' })), false);
  assert.equal(eventMatches({ channel: 'mcp-stdio-s7-closed' }, event('mcp-stdio-s7-closed', { code: 0 })), true);
});

test('chat sidecar keys: messageId, variantId and sessionId (channel = prefix + id)', () => {
  const chunk = event('chat_v2_session_sess_1', { eventType: 'stream_complete', messageId: 'msg_1', variantId: 'var_2' });
  assert.equal(eventMatches({ event: 'stream_complete|stream_error', channelPrefix: 'chat_v2_session_', sessionId: 'sess_1', messageId: 'msg_1' }, chunk), true);
  assert.equal(eventMatches({ event: 'stream_complete', channelPrefix: 'chat_v2_session_', sessionId: 'sess_10' }, chunk), false, 'not a prefix match on the id');
  assert.equal(eventMatches({ event: 'stream_complete', channelPrefix: 'chat_v2_session_', messageId: 'msg_2' }, chunk), false);
  assert.equal(eventMatches({ event: 'stream_complete', channelPrefix: 'chat_v2_session_', variantId: 'var_2' }, chunk), true);
  assert.equal(eventMatches({ event: 'stream_error', channelPrefix: 'chat_v2_session_' }, chunk), false);
});

test('wait specs are strict: unknown keys, empty alternatives and matchers without a channel are errors before anything runs', () => {
  for (const [spec, message] of [
    [{ eventType: 'stream_complete' }, /unknown wait key\(s\) eventType/],
    [{ event: 'a||b', channelPrefix: 'x' }, /empty alternative in event/],
    [{ channel: 'a|' }, /empty alternative in channel "a\|"/],
    [{ channel: '|b', payload: { status: 'done' } }, /empty alternative in channel/],
    [{ payload: { status: 'done' } }, /needs event, channel or channelPrefix/],
    [{ channel: '' }, /channel must be a non-empty string/],
    [{ channel: 'x', payload: {} }, /payload must be a non-empty object/],
    [{ channel: 'x', payload: { 'a..b': 1 } }, /empty segment/],
    [{ channel: 'x', payload: { a: { nested: 1 } } }, /scalar or a non-empty list/],
    [{ channel: 'x', payload: { a: [] } }, /scalar or a non-empty list/],
    [{ channel: 'x', jsonrpcId: { id: 1 } }, /jsonrpcId must be a string or a number/],
    [{ event: 'stream_complete', sessionId: 's' }, /sessionId needs channelPrefix/],
    [[], /a wait is an object/],
  ]) assert.throws(() => validateWaitSpec(spec), message, JSON.stringify(spec));
  const scenario = { id: 'w.strict', seed: 'empty', capture: { events: true, db: [] }, normalize: [],
    steps: [{ cmd: 'x' }, { cmd: 'y', waitAfter: { event: 'done', channelPrefx: 'typo_' } }] };
  assert.throws(() => validateScenario(scenario), /step 1 waitAfter: unknown wait key\(s\) channelPrefx/);
});

test('a wait only counts events after its anchor', async () => {
  const events = [backup('completed')];
  const spec = { channel: 'backup-job-progress', payload: { status: 'completed' } };
  let settled = false;
  const waiting = waitForEvent(spec, () => events, 'second job', { since: 1 }).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(settled, false, 'the first job\'s completion does not satisfy the second wait');
  events.push(backup('running', 'job-2'));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(settled, false);
  events.push(backup('completed', 'job-2'));
  await waiting;
  await waitForEvent(spec, () => events, 'from zero');
});

test('waitForEvent resolves with the first matching event after its anchor', async () => {
  const events = [backup('completed', 'job-0'), backup('running', 'job-1')];
  const waited = waitForEvent({ channel: 'backup-job-progress', payload: { status: 'completed' } }, () => events, 'capture', { since: 1 });
  setTimeout(() => events.push(backup('completed', 'job-1'), backup('completed', 'job-2')), 20);
  const matched = await waited;
  assert.equal(matched, events[2]);
  assert.equal(JSON.parse(matched.payloadRaw).job_id, 'job-1');
});

// export_bridge.rs:46-58 ExportRequest{request_id, …} on `qbank-export-paper` (qbank equivalence README, pendingExportRequestId).
test('wait capture: ${wait.N.path} reads the payload of the event that satisfied step N\'s waitAfter, exactly', async () => {
  const events = [event('qbank-export-paper', { request_id: 'stale', format: 'word' })];
  const scenario = { id: 'w.capture', seed: 'empty', capture: { events: true, db: [] }, normalize: [], steps: [
    { cmd: 'chat_send', waitAfter: { channel: 'qbank-export-paper', payload: { format: 'word' } } },
    { cmd: 'qbank_complete_paper_export', args: { requestId: '${wait.0.request_id}', file: 'exports/${wait.0.request_id}.docx', size: '${wait.0.size}', whole: '${wait.0}' },
      waitAfter: { channel: 'qbank-export-done', payload: { request_id: '${wait.0.request_id}' } } },
    { cmd: 'read', args: { done: '${wait.1.ok}', label: 'n=${wait.0.size}' } }] };
  const trace = await executeScenario(scenario, {
    eventCount: () => events.length,
    async invoke(command) {
      if (command === 'chat_send') {
        setTimeout(() => events.push({ event: 'qbank-export-paper', payloadRaw: '{"request_id":"r-1","format":"word","size":9007199254740993}' }), 20);
      }
      if (command === 'qbank_complete_paper_export') events.push(event('qbank-export-done', { request_id: 'stale', ok: false }), event('qbank-export-done', { request_id: 'r-1', ok: true }));
      return { kind: 'result', raw: 'null' };
    },
    wait: (spec, { step, phase, since }) => waitForEvent(spec, () => events, `step ${step} ${phase}`, { since }),
    capture: async () => ({ events: [...events] }),
  });
  assert.deepEqual(trace.calls.map(call => call.argsRaw), [
    '{}',
    '{"requestId":"r-1","file":"exports/r-1.docx","size":9007199254740993,"whole":{"request_id":"r-1","format":"word","size":9007199254740993}}',
    '{"done":true,"label":"n=9007199254740993"}']);
  assert.deepEqual(Object.keys(trace.calls[0]), ['command', 'argsRaw', 'outcome', 'capture'], 'the trace shape does not change');
  // `${N.wait…}` stays a field of step N's result.
  assert.equal(stringifyExact(resolveReferences('${0.wait.x}', [{ kind: 'result', raw: '{"wait":{"x":"result"}}' }], null, [backup('completed')])), '"result"');
});

test('wait capture: references are checked before anything runs; a barrier that returns no event cannot satisfy one', async () => {
  const base = { id: 'w.bad', seed: 'empty', capture: { events: true, db: [] }, normalize: [] };
  for (const [steps, message] of [
    [[{ cmd: 'a' }, { cmd: 'b', args: { id: '${wait.0.id}' } }], /step 1: \$\{wait\.0\.id\} needs an earlier step 0 with a waitAfter/],
    [[{ cmd: 'a', waitAfter: { channel: 'c' }, args: { id: '${wait.0.id}' } }], /step 0: \$\{wait\.0\.id\} needs an earlier step 0/],
    [[{ cmd: 'a', waitAfter: { channel: 'c', payload: { id: '${wait.0.id}' } } }], /needs an earlier step 0/],
    [[{ cmd: 'a', waitAfter: { channel: 'c' } }, { cmd: 'b', args: { id: 'x-${wait.id}' } }], /step 1: invalid wait reference \$\{wait\.id\}/],
    [[{ cmd: 'a', waitAfter: { channel: 'c' } }, { cmd: 'b', args: { id: '${wait.2}' } }, { cmd: 'c', waitAfter: { channel: 'c' } }], /needs an earlier step 2/],
  ]) assert.throws(() => validateScenario({ ...base, steps }), message, JSON.stringify(steps));
  // A waitBefore reads the previous step's capture; a waitAfter an earlier one.
  validateScenario({ ...base, steps: [{ cmd: 'a', waitAfter: { channel: 'c' } },
    { cmd: 'b', waitBefore: { channel: 'd', payload: { id: '${wait.0.id}' } }, waitAfter: { channel: 'e', payload: { id: '${wait.0.id}' } } }] });
  assert.throws(() => resolveReferences('${wait.0.id}', [], null, []), /prior step's matched waitAfter/);
  assert.throws(() => resolveReferences('${wait.0.id}', [], null, [event('c', {})]), /missing reference field/);
  assert.throws(() => resolveReferences('x ${wait.0.o}', [], null, [event('c', { o: {} })]), /not a string or number/);
  const steps = [{ cmd: 'a', waitAfter: { channel: 'c' } }, { cmd: 'b', args: { id: '${wait.0.id}' } }];
  await assert.rejects(executeScenario({ ...base, steps }, { invoke: async () => ({ kind: 'result', raw: 'null' }), wait: async () => {}, capture: async () => ({ events: [] }) }),
    /prior step's matched waitAfter: \$\{wait\.0\.id\}/);
});

test('executeScenario anchors waitAfter at its own invoke and waitBefore at the previous invoke; captures carry their phase', async () => {
  const events = [{ event: 'startup-left-over', payloadRaw: 'null' }];
  const waits = [], captures = [];
  const scenario = { id: 'w.anchor', seed: 'empty', capture: { events: true, db: [] }, normalize: [], steps: [
    { cmd: 'start_backup', waitAfter: { channel: 'backup-job-progress' } },
    { cmd: 'start_backup', waitBefore: { channel: 'backup-job-progress' }, waitAfter: { channel: 'backup-job-progress' } },
    { cmd: 'read' }] };
  await executeScenario(scenario, {
    eventCount: () => events.length,
    async invoke(command) { if (command === 'start_backup') events.push(backup('completed', `job-${events.length}`)); return { kind: 'result', raw: 'null' }; },
    async wait(spec, where) { waits.push(where); },
    async capture(_, where) { captures.push(where); return { events: [...events] }; },
  });
  assert.deepEqual(waits, [
    { step: 0, phase: 'waitAfter', since: 1 },
    { step: 1, phase: 'waitBefore', since: 1 },
    { step: 1, phase: 'waitAfter', since: 2 }]);
  assert.deepEqual(captures, [{ phase: 'before', step: -1 }, { phase: 'step', step: 0 }, { phase: 'step', step: 1 }, { phase: 'step', step: 2 }, { phase: 'after', step: 3 }]);
});
