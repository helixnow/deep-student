# WAVE0 stream recording kit (X5)

Shared by A (X7, Tauri+Rust) and B (X1/X5, Electron/Host+TS). Plain Node TS, runs under Node ≥ 23 type stripping.

`llm-service.ts` is the HTTP transport only. Scripts, routing, rendering and the request log come from the llm-replay core in `host/plugins/llm-providers/src/replay/` (`answer.ts`, `builtin.ts`, `wire.ts`, `directive.ts`, `embeddings.ts`, `transcriptions.ts`); the in-process replay (D4, below) is a second transport over the same code.

## LLM service: start / config / stop

In-process:

```ts
import { startLlmService } from 'host/e2e/streaming/wave0/llm-service.ts';
const llm = await startLlmService({ host: '127.0.0.1', port: 0 });   // config is optional
const baseUrl = llm.baseUrl('success.answer');   // put into ApiConfig.baseUrl (apiProtocol openai_chat_completions)
// ... run the scenario ...
await llm.whenIdle(15_000);   // every provider stream closed (false = finding)
llm.requests;                 // ordered request log, nothing dropped
await llm.stop();             // destroys held streams (end: 'server-stopped') and closes the port
```

Out of process (X7 recorder, X1 driver):

```sh
node host/e2e/streaming/wave0/llm-service.ts [--port N] [--host 127.0.0.1]
# stdout line 1: {"url":"http://127.0.0.1:PORT","pid":...,"scripts":[...]}
# GET  $url/__x5/requests   → request log so far (not itself logged)
# SIGTERM / SIGINT / stdin EOF → last stdout line {"stopped":true,"requests":[...]}, exit 0
```

- Routes: `POST /s/<scriptId>/v1/chat/completions`, `POST /s/<scriptId>/v1/embeddings`, `POST /s/<scriptId>/v1/audio/transcriptions` (see "Embeddings, audio transcriptions, w0.directive" below). Anything else is logged as `not-found` (404).
- Built-in determinism: output is a pure function of (scriptId, request body). The round index is the count of assistant `tool_calls` messages after the last user message. Fixed `id: chatcmpl-x5-fixed` and `created: 1700000000`; `model` echoes the request. No response carries a `Date` header. Owner sidecars use the separate per-take request-order semantics below.
- Isolation: run one instance per backend take (port 0), so each take's request log stands alone. It binds to loopback only, and no API key is needed (`authMode: none`).
- Cleanup: `stop()` / SIGTERM. Held streams are marked `server-stopped`, and the client's own close is logged as `client-closed`.
- Client close at the end: a write that fails, `[DONE]` included, ends the entry as `client-closed` with `framesWritten` counting only the successful writes. A client that closes after reading `[DONE]` leaves it `done`. Rust and Host both read through `[DONE]` before closing, so which of the two a real take logs is a race of the service, not of the product. `client-close.test.ts` pins both.

| scriptId | behaviour |
|---|---|
| `success.answer` | `固定` `回答`, finish=stop, usage 7/3/10, `[DONE]` |
| `success.thinking` | reasoning `先分析`, content `再回答`, usage 9/6/15 with reasoning_tokens 2, `[DONE]` |
| `error.eof-after-partial` | one content chunk `部分回答`, then EOF with no finish and no `[DONE]` |
| `error.http-500` | HTTP 500 with a fixed JSON body before any stream byte |
| `interrupt.hold-after-partial` | one chunk `取消前内容`, then stays open until the client closes it (the user-cancel path) |
| `tool.second-round` | round 0: tool call `call_x5_fixed` to the **first offered tool**, args `{"text":"hello"}`; round 1: `工具结果已收到`. Returns 400 `no-tool-offered` if the request has no tools, and 409 `unscripted-round` past the last round |
| `success.empty` | no content, finish=stop, usage 7/0/7, `[DONE]`: an empty answer (empty transcript on either ASR route) |
| `w0.directive` | rounds derived from the `W0_DIRECTIVE` in the request (below): tool calls, then the final answer |

Non-stream requests (`stream` not true) get the same round folded into one `chat.completion`.

## Embeddings, audio transcriptions, w0.directive (W25)

Code: `host/plugins/llm-providers/src/replay/{embeddings,transcriptions,directive}.ts`, routed by `replay/answer.ts` (shared by `llm-service.ts` and the in-process replay). All three answer from the request alone: no clock, no randomness, no state shared between requests, takes or backends.

### `POST …/v1/embeddings`

- Request (A `vfs` embedding client and B `plugins/llm/src/embedding_transport.ts` send the same body): `{"model", "input", "encoding_format"?, "dimensions"?}`. `input` is a string or a non-empty array of strings or multimodal items `{"text"?, "image"?, "instruction"?}` (string values; `null` = absent; no other keys). `encoding_format` must be absent or `"float"`.
- Models (`embeddingModels`): `w0-text-embedding` → 768, `w0-vl-embedding` → 1024. These are the dimensions the vfs-repos corpus binds before indexing (`vfs_create_dimension` + `vfs_set_default_embedding_dimension`); A rejects a vector of another length (`unified_retriever.rs` `validate_dimension`). `dimensions` (integer, 1…native) shortens the vector.
- Vector of one item, dimension D: D zeros, then +1 at `fnv1a32(utf8(feature)) mod D` for each feature: `w0` (always, so no zero vector); every text code point `t1:<c>` and adjacent pair `t2:<c><c'>`; `img:<image string>`; instruction code points/pairs as `i1:`/`i2:`. Components are small integers (exact in f32/f64). Texts sharing characters score higher under cosine, so retrieval ranks like a crude lexical model.
- Response 200 `application/json`: `{"object":"list","data":[{"object":"embedding","index":i,"embedding":[…]}],"model":…,"usage":{"prompt_tokens":n,"total_tokens":n}}` with n = code points of every text and instruction + 1 per image.
- Script: embeddings are served for **any** script id, known or not (vfs-repos scenarios bind `${llm.baseUrl}` without `llm`, so the script id is the scenario id). Only a rounds script whose round 0 is `http-error` changes the answer (e.g. `error.http-500` → that status and body). Sidecar cursors are not touched.
- Errors (`{"error":{"message","type":"x5_llm_service"}}`): `bad-json` 400; `bad-embedding-request` 400 (no model, bad input/item/encoding_format/dimensions); `unknown-embedding-model` 404 (message lists the known models). Log: `stream:false`, `round:null` (0 for a script error), `end:'done'`.

### `POST …/v1/audio/transcriptions`

- Request: `multipart/form-data` (RFC 7578; boundary may be quoted; preamble/epilogue ignored) with a `file` part carrying a filename and a `model` field; optional `language`, `prompt`, `response_format`. Each may appear once; other fields are accepted and logged.
- Answer text: round 0 of a rounds script, its content frames concatenated (`success.answer` → `固定回答`, `success.empty` → empty). An `http-error` round 0 returns that status and body. A provider sidecar answers with its next literal response, as for chat. `w0.directive` → 409 `unscripted-route`.
- `response_format`: `json` (default) `{"text":…}`; `text` → the text as `text/plain; charset=utf-8`; `verbose_json` → `{"task":"transcribe","language":<field or "unknown">,"duration":<PCM WAV seconds or null>,"text":…,"segments":[{"id":0,"seek":0,"start":0,"end":duration,"text":…}]}` (no segment when the duration is unknown or the text is empty). Anything else → 400 `unsupported-response-format`, message naming `response_format` (A's media pipeline retries without it on that 400).
- Errors: `bad-multipart` 400 (log body = raw text), `bad-transcription-request` 400 (no file/filename, no model, duplicated field), `unknown-script` 404. The log body is `{"parts":[{name,value} | {name,filename,contentType,size,sha256}]}`: file bytes are never logged, only their digest.
- Which models use this route: both sides route ASR by model name. `qwen3-asr-flash` goes to `chat/completions` (`input_audio`, stream=false), so `voice.transcribe.*` and `media.transcribe.start_cancel_scripted_asr` (ASR model `qwen3-asr-flash`) use the chat route; any other model (`whisper-1`, `FunAudioLLM/SenseVoiceSmall`, …) posts multipart here.

### `w0.directive`

Rule (full text in `replay/directive.ts`; the chatanki README defines the directive):

1. Directive message: the last `role:"user"` message whose text (string content, or `text` parts concatenated) contains `W0_DIRECTIVE `; the prefix must occur once in it.
2. Directive: the JSON object right after the prefix up to its matching `}` (string-aware); trailing text such as B's `</user_query>` and `<injected_context>` is ignored. Shape exactly `{"v":1,"rounds":[[{"id","name","arguments"},…],…],"final":<string>}`, every round non-empty, `id`/`name` non-empty.
3. k = assistant messages with non-empty `tool_calls` after the directive message. k < rounds → round k as tool calls (`index` = position in the round, id/name verbatim, `arguments` = JSON text, numbers keep their written digits), finish `tool_calls`, usage 9/3; k = rounds → content `final`, finish `stop`, usage 12/4; k > rounds → 409 `unscripted-round`.
4. Failures never guess: 400 `no-directive`, `ambiguous-directive`, `bad-directive`. The offered tools are not consulted. Session-title calls are not answered: every scenario on this script creates a titled session.

Run-time references the recorder substituted into the directive (`${3}`, `${7.items.0.version}`) therefore reach the tool-call arguments on A and B alike. For a directive without references the bytes equal the static sidecar written by `chatanki/equivalence/__fixtures__/provider-from-directives.mjs` (tested for all 75 static scenarios).

### Determinism evidence

- `determinism.test.ts`: two CLI processes answer success and failure requests on every route with byte-identical responses (status line, headers, body), also identical when repeated in one process; no response has a `Date` header. Both run under `__fixtures__/nondeterminism-probe.mjs`, which records every call of `Date.now`, `new Date()`, `Date()`, `performance.now`, `process.hrtime(.bigint)`, `Math.random` and the crypto random APIs; none comes from service code. The probe does not see Node internals that read the clock through primordials (the HTTP `Date` header), hence the explicit header check.
- Route tests: `embeddings.test.ts`, `transcriptions.test.ts` (undici FormData and reqwest-shaped bodies give the same answer), `directive.test.ts` (rule, corpus parity, dynamic scenarios decode).
- B end to end: `llm-routes-b.test.mjs` runs the real Host through `g3-run-b.mjs` on `vfs.rag.search.indexed_note_with_mock_embedding`, `chatanki.template.get.custom` and two ad-hoc voice-input scenarios with a multipart ASR model. `streaming-b.test.mjs` does the same for the six error, retry and cancel scenarios of `streaming.scenarios.json` and for `chat.stream.tool.second-round`. Both are wrapped by `streaming-b.test.ts`, one after the other: `g3-run-b.mjs` binds the fixed G3 LLM port, so two B suites in parallel files fail with `EADDRINUSE`.

### G3 fingerprint

`g3-inputs.mjs` hashes `llm-service.ts` with its relative imports. Since W05 r6 the `llm` closure is `llm-service.ts` plus `host/plugins/llm-providers/src/replay/{answer,builtin,wire,directive,embeddings,transcriptions}.ts` (7 files): editing any of them changes the fingerprint of every scenario that starts the LLM service, and those A takes must be re-recorded. (Currently it is every scenario: `g3-services.mjs:35` imports `llm-service.ts` dynamically, so the same files are also in the `recorder` closure that applies to all suites.) The suites that start the service: `host/e2e/streaming/wave0/streaming.scenarios.json` (10), `host/plugins/chatanki/equivalence/{library-cards,templates}.json` (42 + 86), `host/plugins/media/equivalence/{handout-llm,media-player-ledger,voice-input}.json` (4 + 1 + 2), `host/plugins/qbank/equivalence/pending-provider/{ai-grading-scripted,g3-authoring-generation-llm}.json` (10 + 2), `host/plugins/review/equivalence/pending-provider/wp229-essay-stream-scripted.json` (2), `host/plugins/vfs-repos/equivalence/{index-dimensions,rag-multimodal}.json` (6 + 9). 11 suites, 174 scenarios.

## WP-123: L14 qbank provider sidecar

Source: `ee55bf25e:host/plugins/qbank/equivalence/pending-provider/ai-grading-scripted.provider.json`, corresponding `ai-grading-scripted.json` and `equivalence/README.md:98+`. The checked-in `__fixtures__/ai-grading-scripted.provider.json` is a byte-identical snapshot of that external input (10 script IDs / 11 responses). It is **not** a grading-output oracle. Rust consumption: `src-tauri/crates/dstu-qbank/src/qbank_grading/pipeline.rs:152–362,1132–1292` (POST, HTTP error, SSE, `[DONE]`, cancel/cleanup).

The only added script format is `ResponseScript { description, responses: [{ status, headers, chunks }] }`, via the existing `extraScripts` option. `providerScripts(unknown)` validates/loads the original sidecar (`note` is metadata). Existing `Script { description, rounds }` callers keep their body-derived semantics.

```ts
import { readFile } from 'node:fs/promises';
import { providerScripts, startLlmService } from './llm-service.ts';
import { runScenario } from './runner.ts';

const extraScripts = providerScripts(JSON.parse(await readFile(sidecarPath, 'utf8')));
// Create a fresh service for EACH scenario × backend × take, including retries of a take.
const llm = await startLlmService({ extraScripts });
try {
  // L14 scenario.id is the script ID. Caller explicitly selects it; no implicit fallback.
  const record = await runScenario({ ...scenario, llm: scenario.id }, driver, { side: 'B', take: 'B1', llm });
  // runner substitutes L14's ${provider.url} with llm.baseUrl(scenario.id).
  // Save the record AND llm.requests before shutdown; keep llmIdle=false as a finding.
} finally {
  await llm.stop();
}
```

For an external X1/X7 runner:

```sh
node host/e2e/streaming/wave0/llm-service.ts --provider-script host/e2e/streaming/wave0/__fixtures__/ai-grading-scripted.provider.json
```

Use the first stdout line's `url`, select `scenario.id`, and replace `${provider.url}` in that scenario's ApiConfig with **`${url}/s/${encodeURIComponent(scenario.id)}/v1`** (not the bare origin). HTTP route remains `/chat/completions` appended to that base. Read `/__x5/requests`, then close stdin or send SIGTERM/SIGINT and retain the final request log. A driver still owns real invoke/event/DB capture. X1/X7 runners are not changed by this package.

- Each service clones its extra scripts and owns a separate cursor per script ID. A valid POST with JSON claims the next response before any write. The two `regrade_same_submission_twice` calls return the original 80/correct then 30/incorrect texts, even though both bodies have no tool history. Cancelled or HTTP-error calls still consume their claimed response; malformed JSON, wrong method/route or unknown ID do not. Exhaustion is explicit 409 `unscripted-round`; no wrapping/repeating the last response or silent fallback. Concurrent calls are ordered by server admission after complete request-body reading; scenario steps should remain sequential.
- Status and supplied headers are passed directly to Node HTTP; every UTF-8 chunk is written verbatim in order, followed by HTTP EOF. No SSE parse/re-encode, extra finish/usage/id/model, automatic `[DONE]`, or non-stream folding. `stream:false` still receives the exact sidecar response. HTTP `Connection`/`Transfer-Encoding` are framing headers; `Date` is disabled. Socket packet boundaries are not promised to equal script chunk boundaries.
- `LoggedRequest.round` is the zero-based response index for sidecars. `raw.requestBody`/`requestHeaders` retain actual input; `raw.responseHeaders` and `raw.chunks` record supplied headers and successful write callbacks. `framesWritten` counts these raw writes, **including `[DONE]`**. Successful finite responses end with `end:'eof'` (the bytes determine SSE termination), status ≥400 with `http-error`; interrupted writes with `client-closed`/`server-stopped`. A successful server write is not proof that the client read it: HTTP tests also retain independent client `rawHeaders` and entity `bodyBase64`.
- Tests cover all 11 literal responses, two isolated instances, second-call ordering, exhaustion, invalid requests, non-stream literal bytes, CLI EOF/port release and in-flight client/stop cleanup. The pressure fixture is transport-only, not another qbank business script. `qbank-provider.test.ts` exercises the real public L02 client + L01 parser and the first L14 qbank command path through the existing runner. It retains raw requests/events/outcomes in `/tmp/opencode/x5-wp123-*` (paths printed in job logs).
- This service supplies deterministic external inputs. A1/A2/B command replay, database/event equivalence, C/G3 and WP-089 A trust remain separate dependencies. No normalization or waiver is added.

## Recorder, runner, normalize candidates

- `recorder.ts`: `StreamRecorder.push(channel, payload, payloadJson)` (A tap, original JSON text) / `pullHostEvents(events, cursor)` (B). Events retain **`payloadJson`** verbatim alongside the display-only parsed `payload`; steps retain **`argsJson` / `valueJson`** alongside display values. The record keeps every event in order and never filters, sorts or deduplicates. `terminal` is a derived summary: `none` / `multiple` are findings.
- Missing raw is `null`: A `push(channel, parsedObject)` explicitly lacks precision evidence. Never reconstruct an alleged original wire from a rounded A object. B prefers kernel `payloadJson` / invoke outcome `json`; ordinary safe kernel objects can be serialized, but an unsafe/non-finite Number without raw is unsupported. Kernel BigInt-only projections without `json` therefore need owner-provided raw before they can prove precision.
- `runner.ts`: `runScenario(scenario, driver, { side, take, llm })`. A driver implements `invoke`, `drainEvents` and `settle`, plus `invokeWire(cmd,args) → {ok,value,json}` for original success/error response text. Without it, `valueJson=null` and candidate comparison reports missing raw. `hostDriver(host)` uses real `runtime.dispatchInvoke` to retain that text. Arguments must arrive losslessly (use `parseWireJson` on JSON scenario inputs with large numbers); whole-result placeholders keep numeric atoms, including into later args. No JSON number is converted to a business string.
- `streaming.scenarios.json`: §3 v0 scenarios. Extensions: `llm`, `${llm.baseUrl}`, and step `waitBefore` / `waitAfter`.
  - Ids below omit the `chat.stream.` prefix. On built-in scripts: `success.answer`, `error.eof-after-partial`, `interrupt.cancel-after-partial`, `tool.second-round` (the four v0 scenarios); `success.thinking` (reasoning model with thinking on); `success.empty` (two tool-loop retries, then the empty-response error); `interrupt.cancel-during-retry` on `error.http-500` (cancel in the 4–5 s establish retry wait, after the first `stream_reconnect`).
  - On `streaming.scenarios.provider.json` (no `llm`, so the script is the scenario id): `retry.http-500-then-answer` (500, then the answer on the establish retry), `error.http-400-no-retry` (one 400, no retry at any level), `tool.second-round-error` (round 0 calls `builtin-template_list`, round 1 ends at EOF after partial content). The sidecar was generated with `replayFrameJson` from `llm-providers/src/replay/wire.ts`, so its frames have the built-in scripts' shape.
  - An establish 5xx that exhausts its five retries is not a scenario: 5 × 4–5 s is longer than the 15 s wait deadline.
- `normalize-candidates.ts`: `candidateRules(A1, A2)` produces candidate rules (all `c2: 'pending'`) plus the unrepeatable differences. `applyRules(record, rules)` returns a normalized copy and never edits the raw takes.
- Numeric comparison reads the original text through the public `platform/util/api.ts` parser. Native numeric atoms remain numeric through comparison/application; `JSON.stringify` emits numbers, not `{rawJSON:...}` objects. Raw atoms must not be `structuredClone`d. Record snapshots are cloneable because their evidence is text. Display projections may be rounded or overflow: they are never the only precision evidence.
- **WP-042 old B recordings are retained as historical traces only, not precision proof.** Missing raw fields (including old `x5.stream-record.v0` takes) yield `unrepeatable` with `missing raw JSON ... unsupported for precision proof`; they are not silently upgraded. No A/B or C acceptance follows from B self-repeat or these tests. The historical cancel red was independently passed by C2 on fixed combination `aae7910e3` / job `20261105175017-81cbe6`; WP-123 consumes the main L03 fix and preserves the original nine-event test/budgets for its final full lane gate.

## D4: in-process replay instead of the HTTP service

`llmReplayPlugin` (`host/plugins/llm-providers/api.ts`) serves the same scripts in process: same response bytes, same request log shape, no port. Mount it on the B host and hand its service to the runner; `${llm.baseUrl}` then resolves to `http://llm-replay.invalid/s/<id>/v1`, which the llm plugin routes to the mounted replay.

```ts
import { providerSidecarScripts } from 'host/plugins/llm-providers/api.ts';

// Built-in scripts (LLM_REPLAY_SCRIPTS, the same table as this service's `scripts`) are the default.
const fixture = await streamingHost('answer', { realProviders: true, diagnostics: true,
  llmReplay: { extraScripts: providerSidecarScripts(sidecar) } });   // fresh host per take
try {
  const record = await runScenario(scenario, hostDriver(fixture.host), { side: 'B', take: 'B1', llm: fixture.host.ctx.llmReplay });
} finally {
  await fixture.dispose();   // stops held streams: end 'server-stopped'
}
```

Transport-only differences: `raw.requestHeaders` holds just the application's headers (no undici `host`/`accept`/`user-agent`), responses carry no `connection`/`transfer-encoding`/`date`, and packet boundaries are not simulated. `llm-replay.test.ts` proves byte and log parity with this service for every built-in round script, `w0.directive` (tool rounds, final answer, every directive failure), `/embeddings`, `/audio/transcriptions` (fixed-boundary bodies, malformed multipart, FormData from a real client), sidecar scripts on all three routes and the shared failure paths, and that four scenarios recorded over the replay differ from an HTTP take only as much as a second HTTP take does. External X1/X7 runners and G3 keep using the HTTP service.
