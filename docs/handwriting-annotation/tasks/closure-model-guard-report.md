# Closure model guard — implementation and regression report

Date: 2026-11-03
Scope: `scripts/dev/ink-acceptance-proxy.mjs`, `scripts/__tests__/ink-acceptance-proxy.test.mjs`, this report.
No production edits. No `src/` / `src-tauri/` changes. This agent did not run tests, network, or model calls; only `node --check` syntax verification ran. Main owns execution.

Status: implementation frozen. Main's earlier RED (exit 1: 4 fail, 1 pass) is addressed by the admission guard below. Main reruns the selector.

## Test selector

```bash
node --test scripts/__tests__/ink-acceptance-proxy.test.mjs
```

## Enforcement implemented

`scripts/dev/ink-acceptance-proxy.mjs` is a loopback HTTP proxy placed between the isolated app profile and the original provider origin.

Admission order per request:

1. POST only.
2. Request target must be origin-form (`/path`): reject absolute and protocol-relative targets, query, fragment, and backslashes.
3. Path must match the allowlist: Chat Completions, Responses, messages, or Gemini generate routes.
4. Read a bounded JSON body, max 32 MiB; malformed JSON and missing/non-string `model` return 400.
5. `model` must exactly equal the pinned model; mismatch returns 403.
6. Counter increments synchronously in the same turn as `transport.request`: exactly `limit` (max 20) upstream attempts. The 21st returns 429 `acceptance_budget_exhausted` without opening an upstream socket.
7. An `admitted` record is journaled before the upstream request, so a killed process cannot erase an attempted slot.
8. Upstream is an origin-only URL: no credentials, query, fragment, or path. Optional `expectedUpstreamHost` pins the hostname.
9. Request `cookie` and `proxy-authorization` are stripped; normal provider `authorization` is forwarded unchanged.
10. Upstream redirects (3xx) are consumed and returned as 502; `Location` is never passed to the app. No redirects or retries are performed by the proxy.
11. Logs contain only event, sequence, method, path, status, model, attempt, duration, body byte count. Headers and bodies are never logged.

Counters are exposed on the returned handle (`count`, `rejected`, `attempts`); there is no admin endpoint and no reset API. A failed upstream request still consumes its slot.

## CLI

```bash
node scripts/dev/ink-acceptance-proxy.mjs \
  --config /path/to/config.json \
  --log /path/to/new-evidence.jsonl \
  --host 127.0.0.1 \
  --port 0
```

`config.json` contains only `upstreamBaseUrl`, `model`, and `limit` (an origin such as `https://api.deepseek.com`, the exact assigned vision model, and `20`). Keys matching `key|token|secret|auth|password|cookie` are rejected. A nonempty existing `--log` file is refused so a rerun cannot silently restart the 20-request budget on the same evidence path. The process prints one `listening` metadata line, appends metadata-only JSONL records (`admitted`, `forwarded`, `redirect_blocked`, `rejected`, `upstream_error`), and prints a `summary` line on SIGINT/SIGTERM. No secrets are read from argv, environment, or config.

The app's isolated profile points its selected config `base_url` at the proxy URL; request paths such as `/v1/chat/completions` are preserved. The upstream config must be the origin without `/v1`.

## Regression suite (10 tests)

| # | Case |
| --- | --- |
| 1 | First 20 requests allowed; 21st returns 429 before the upstream; `count=20`, `attempts=21` |
| 2 | 10 rounds x (503 + retry success) = 20; the next retry is rejected before the upstream |
| 3 | Wrong model 403; missing model 400; neither reaches the upstream; valid request still allowed |
| 4 | Host pin mismatch refused at startup; non-chat path 403; `limit=21` refused at startup |
| 5 | 21 concurrent requests: exactly 20 upstream sends, 20x200 + 1x429 |
| 6 | Absolute, protocol-relative, and query request targets all rejected 400 |
| 7 | Malformed JSON rejected 400 before the upstream |
| 8 | First upstream 302 blocked as 502, no `Location`, slot consumed; second request (fixture returns 200) is allowed, `count=2` |
| 9 | Upstream credentials, query, or non-origin path refused at startup |
| 10 | No auth/body/cookie logging; normal auth forwarded; cookie/proxy-auth stripped; no package/lib.rs wiring |

Expected current result: all 10 pass. Main's prior RED observations (21st 200 vs 429, retry 21st 503 vs 429, wrong model 200 vs 403, limit 21 accepted) are the behaviors now enforced.

## Send callers covered by the boundary

Streaming Chat main path:

- `.../llm_manager/model2_pipeline.rs:6358` — streaming send loop, network/5xx retries.
- `.../model2_pipeline.rs:5067` — Codex stream send/401 refresh.
- `.../model2_pipeline.rs:5041,5052` — Codex single-refresh wrappers.

Non-stream / background / tool paths:

- `.../model2_pipeline.rs:7891` — non-stream model2 send.
- `.../model2_pipeline.rs:8150` — chat metadata/title.
- `.../model2_pipeline.rs:9197` — raw prompt retry loop.
- `.../model2_pipeline.rs:9577` — OCR raw prompt.
- `.../model2_pipeline.rs:9918` — Anki card generation.
- `.../model2_pipeline.rs:8462` — connection test.
- `.../single_shot_stream.rs:947` — shared prepared-request send; retries at 697-891.
- `.../llm_manager/mod.rs:7505` — OCR engine test.
- `.../exam_engine.rs:1682` — OCR hedge.
- `.../rag_extension.rs:639,806,963,1194,1385` — RAG/embedding/rerank.
- `.../opencode_go.rs:405` — token exchange.
- `.../model2_pipeline.rs:8300,8356` — embeddings/rerank.

Because the isolated profile contains only the selected vision config, every app send above uses the proxy `base_url`. Retries, failover attempts, and tool rounds are separate HTTP requests and share the single 20-slot counter. Test fixtures at `model2_pipeline.rs:2566-2604` and `single_shot_stream.rs:1187-1200` are not production sends; `providers/mod.rs` only builds requests.

## Secret and release boundaries

- Proxy forwards the app's own `authorization` header; it never reads provider keys from disk.
- Test 10 asserts logs contain no token, body marker, cookie name, or header names, and that cookie/proxy-authorization are stripped upstream.
- No `src/` or `src-tauri/` edits; test 10 asserts `package.json` scripts and `src-tauri/src/lib.rs` do not reference the proxy.
- Normal profile untouched; isolated profile is disposable. Stop the proxy to remove enforcement.

## Deviation from original ownership line

The initial brief limited edits to `dstu-llm` plus this report. The coordinator directed the loopback proxy under `scripts/dev` and explicitly authorized the pass-through scaffold for RED. No `dstu-llm` code changed because the network boundary covers all sends without production edits.

Files:

- `/home/xutao/deepstudent/deep-student/scripts/dev/ink-acceptance-proxy.mjs`
- `/home/xutao/deepstudent/deep-student/scripts/__tests__/ink-acceptance-proxy.test.mjs`
- this report

## Remaining requirement for main

Main seeds the isolated profile with the assigned vision config pointing at the proxy origin, starts the CLI with a fresh log path, reruns the selector, and records the real-model request count. Implementation is frozen pending that verification.
