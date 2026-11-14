# X7 differential audit

## G3 ledger tooling and first successful real A build (2026-11-06, current)

- Commander instruction 1: PDFium `libpdfium.so` (5,960,240 B, gitignored) supplied in the
  worktree. Build `20261106013300-a8a249` (third real-app build; the two exit101 originals are
  unchanged) **exit 0 in 2,399,334 ms**, receipt via job `20261106021333-d78e94`; Rust tree
  `cff4c0cc6` unchanged by later main merges. No feature pruning, clean or business Rust edit.
- Startup is still blocked by D46 (production identifier compiled in; launcher refuses it,
  no TAURI_CONFIG workaround) and LLVM coverage tools are absent. Both reported to C0.
- G3 compare/report delivered (`07e7406ff`); rules taken verbatim from board/G3-LEDGER.md.
  WAVE0 §3 says `expect:"error"` is illustrative only; G3-LEDGER §4.4 (newer, the scoring rule)
  makes it binding, so the comparator scores an expectation mismatch as a difference.
- `withScenario` 208 counts every step reference in the current tree. X2's 152 counts only
  same-owner top-tier corpus at `e41f1d061` + 14 refs; the numbers measure different things
  and neither is a denominator.
- Validation: `g3-report.test.mjs` 2 passed / 0 failed (job `20261106022213-5bcc99`);
  first real report job output sha256 `3ef75c2a…75d8`; ledger `--check --no-write` exit 0
  (job `20261106021902-e1954f`, C 0%). No golden/C entries emitted.

## WP-153 — v0 seed 与 HOME 独立消费

结论：准备实现完成；真实 A 仍受 WP-043 的 PDFium/D46/LLVM 阻塞，A1/A2/golden=0。

- 按 WORKER 开工合 main 为 `0a82afd7c`（main `4f5c83b1c`），工作树原本干净，
  其他 lane 有并行 Vitest。以 `git show main:host/e2e/data-compat/__fixtures__/scenario-seeds.ts`
  核实 `e6bce8aae` 的 X3 供方确已正常发布，完整阅读其 SCENARIO-V0 协议。
- `record/scenario-v0.mjs:prepareScenarioRun` 调用 X3 resolveSeed/copySeed；
  `tauri-first-command.mjs` 仍一次 createSeed，再两次共享准备。保留 empty/get_app_version 原入口。
  返回 X3 原始 source/seed 描述与每副本 env；HOME=`<副本>/home`、XDG_DATA_HOME=`seed.dataDir`，
  `seed.dataLocalDir` 同源返回，config/cache/runtime/tmp 同副本。父进程环境不被修改。
- skill-zip-v0 文件完整性直接使用 X3 `SKILL_ZIP_SEED_FILES`，不复制 ZIP 生成器或 SQL。
  未知 seed、源未创建、十个 ZIP 任一缺失、文件位置被目录占用均明确失败；不重建源、不回退 empty。
- 既有 Node suite 保留原五项，新增三项准备测试：两个副本分别由真实 Node 子进程读取 HOME 与
  十个 ZIP 原始字节；修改第一份 app/local-data 和 ZIP 不影响第二份与源；错误时源不被修补；
  原 JSON 输入的 empty/get_app_version 仍得到两个空数据目录与独立 HOME。
  Vitest wrapper 原成功/失败断言保留，仅预期计数 5→8，无 Rust 映射去向变更。
- 基线 typecheck `20261105190007-8d7c9d` exit0；差分目录 Vitest
  `20261105190008-d869f7` 2 passed / 0 failed / 0 skipped，exit0。
  修改后 Node `20261105190212-e81720` **8 passed / 0 failed / 0 skipped**，exit0。
  提交后直接 lane-gate 的精确 tip/各项结果见 WP-153 交付报告及正式 selfgate 记录。
- TESTMAP 本 lane 无独立文件，pending 0→0（不适用；未迁移 Rust 测试）。
  原两次真实构建 `20261105173612-f65814` / `20261105174903-ed84f3` 的 exit101 原件不变。
  本包无 Rust 构建、无 A 启动、无新 C/G3；SQL/synthetic ZIP 标签不冒充历史 A 产物。
  WP-043 保持部分 blocked，资源维护后另包正式增量构建；过期 runtime-blockers 已按原构建证据更正。

## WP-043 — real Tauri first-command recovery (partially blocked)

New assignment actually started **2026-11-05T17:34:22.529Z**, launcher PID **3158851**,
opencode PID **3158852**, session **ses_e53394115ffekLMlt1CB4m1PJP** from the raw session
event log (sessions.json initially had no session field). Read WORKER/task/LANE and
standard-v2/WAVE0 §3; this lane has no separate BLOCKERS or TESTMAP. Clean starting
tree, concurrent Vitest jobs present. Merged main `736ad9f1a` into `0b96afc25`.

### Real build, not another WP-012 helper pass

The actual live queue has `rust:1`; user brief supersedes old jobs8/20 advice.
Submitted **20261105173612-f65814** with jobs12, nice10, dev, `-Cinstrument-coverage`,
`--locked --manifest-path src-tauri/Cargo.toml --bin deep-student` and **all default
production features**. Reused `src-tauri/crates/dstu-differential/target`; no clean.
No existing 34 dispatch IDs changed or removed, including regex.boundedOriginal.

First app build ran 17:36:12.990Z–17:46:23.494Z, **610.504s**, **exit101**.
Original error: `lance-encoding v0.37.0` cannot find `protoc` in its build script.
The root app's build.rs setting PROTOC does not propagate to dependencies' build
scripts. The resolved dependency cache already supplies
`protoc-bin-vendored-linux-x86_64-3.2.0/bin/protoc`. Incremental retry
**20261105174903-ed84f3** (started 17:49:04.329Z) passes this existing executable as
PROTOC, keeping the same target/features/lock/coverage flags. No package installation,
Rust business change, feature pruning, parallel cargo or queue bypass.

First immutable archive: `fixtures/differential/wp043/builds/20261105173612-f65814/`:
job JSON/log, actual Cargo.toml/Cargo.lock/tauri.conf.json, rustc-info, receipt with
SHA256 inputs and Rust tree `cff4c0cc6eddd710a71e87cb814bf20bc0384516`.
Archive job **20261105174903-71f388**, exit0. Actual compiler is rustc **1.98.1**,
LLVM **22.1.8**. Coordinator auto-checkpoints 694e479f2/720635d82 advanced HEAD during
the build without changing Rust/config; receipt separates submitted revision from
receipt revision, and a future successful binary's embedded revision must be observed.

Ten instrumented build-script/proc-macro profraw files initially appeared beside
source files. Moved only these new build-owned outputs to the above archive's
`build-script-profraw/`; no tracked source deleted/modified. **They are not command
coverage.** Retry uses an absolute LLVM_PROFILE_FILE under own fixtures. Matching
llvm-cov/llvm-profdata are missing from PATH **and** rustc toolchain bin (only
gcc-ld/rust-lld/rust-objcopy/wasm-component-ld). Report-generation blocker sent to C2.

### Existing-scope implementation and evidence boundary

- WAVE0 v0 input: `fixtures/differential/wp043/get-app-version.v0.json`.
- `record/scenario-v0.mjs`: explicit JSONPath validation, rejection of all unapproved
  nonempty normalize, exact `${n.path}` prior-result resolution, requested event/DB
  evidence mandatory. Native transport/capture failures propagate, not business Err.
- Self-driving devUrl page calls the actual `__TAURI_INTERNALS__.invoke`. No Rust
  constructor, command implementation or TS answer is substituted. Raw custom-protocol
  response is copied before Tauri calls response.json(); postMessage fallback blocks.
  First input is restricted to version({}), so generic numeric input precision is
  not asserted. Existing X5 JSON.parse recordings are not precision evidence here.
- A1/A2 launcher imports X3's public APIs, copies one empty seed twice, isolates
  HOME/XDG/TMP and uses a separate DBus session in the documented queued Xvfb command.
  It preserves original input/build SHA, raw outcomes/wire, SQLite snapshots and
  clean-exit DB terminal state; app profraw is separate from build profiles.
- Tauri events only reach named listeners (`tauri-2.11.5/src/event/listener.rs:283–289`),
  with payload JSON inserted into eval (`event/mod.rs:200`). No wildcard/raw-event
  completeness is claimed. get_app_version (`commands.rs:499–507`) has no emit/DB
  effect/Err branch; that source fact does **not** replace dynamic line coverage or
  certify general event capture. Recorder labels the limited event scope explicitly.
- No golden C entries emitted. Full scenario coverage, ≥80% actual Rust handler line
  coverage and all reachable errors/individual approved exceptions still gate C.

### Precise open dependencies, already sent to C1/C2

1. **D46:** mechanical X7 allowlist still lacks the three D007 root build files.
   Exact isolated-identifier diff is in `WP-043-runtime-blockers.md`; launcher rejects
   the original production identifier. No TAURI_CONFIG/script workaround. Current
   authorized build attempt uses existing root config, and does not wait for allowlist.
2. **X3 (resolved at final merge):** `git show main:host/e2e/data-compat/SCENARIO-V0.md` exit128 at initial dependency
   verification. Candidate `7fbe42516` documents createSeed/resolveSeed/copySeed and
   snapshotDirectory/compareDatabaseStates. Need normal-main publication; no copied
   implementation or cross-worktree execution. SQL historical seed is not A output.
   At 18:14Z, merged main `e6bce8aae` now publishes the APIs. X7 adds a direct consumer
   test for createSeed/resolveSeed/copySeed plus snapshotDirectory/compareDatabaseStates:
   independent empty copies, source seed unmodified, exact i64 and IEEE754 REAL, and
   the actual added-database diff. Fifth recorder check, still not a real A command.
3. **LLVM tools:** maintenance to provide matching llvm-tools-preview/absolute paths.
   Raw profiling bytes alone do not establish G3 or a coverage percentage.
4. General raw event capture/termination remains a future X5/X7 interface; B driver
   is independent and not required for the first A build. No eight-instance/765 scope.

### Validation so far

- Baseline typecheck **20261105173516-710212**, exit0.
- Baseline Vitest **20261105173516-9bab38**, exit0: 1 wrapper passed, preserving all
  12 original Node recorder checks; 0 failed/skipped.
- New v0 + real SQLite FK + local HTTP raw-transport checks:
  **20261105175031-249875**, exit0, **4 passed / 0 failed / 0 skipped**.
  This is recorder-only evidence, not real A/B invocation. Demonstrates i64
  9007199254740993 identity across return/repeated refs/event/PK/FK, storageClasses,
  arbitrary-precision fractional tokens, null/missing distinction, invalid JSONPath,
  unapproved normalize rejection, transport/DB failure propagation.
- TESTMAP absent before/after; no Rust test mappings promoted or changed.

Runtime instructions: `host/e2e/differential/WP-043-RUN.md`. Final build, lane-gate,
submission and remaining-blocker outcomes are appended at the delivery boundary.

### WP-043 build completion checkpoint — 17:55Z

Retry **20261105174903-ed84f3** completed 17:55:11.193Z, **366.864s / exit101**.
PROTOC resolved the first error; compilation reached the real application's build.rs.
Actual build metadata emitted `GIT_HASH=10bb127a`, `BUILD_NUMBER=25048`, full Sentry
revision `10bb127a18630a071fd3354faef1cc530690131e` (coordinator's auto-checkpoint).
New exact failure:

```text
thread 'main' (3318267) panicked at build.rs:57:29:
failed to build Tauri application with app ACL: resource path `resources/pdfium/libpdfium.so` doesn't exist
```

`tauri.linux.conf.json:5` declares this missing resource. It is not an ACL assertion
failure and not a production Rust semantic defect. The project's existing
`scripts/download-pdfium.sh:11–15,79–83` pins Linux x64 to chromium/7350. Maintenance
must provide that original library at `src-tauri/resources/pdfium/libpdfium.so`;
this resource is outside X7's allowed paths and D007's three root configurations.
X7 did not run the download script (it also rewrites licenses outside this lane),
delete resources from the bundle, supply a dummy library, or disable default features.
Full owner handoff and exact source URL are in `WP-043-pdfium-blocker.md`, sent C1/C2.

Both real Rust jobs are finished; no abandoned compiler or third blind retry.
Total actual Rust build time **977.368s** (queue wait excluded), application run time
**0**, actual A comparisons **0**. No A1/A2 application profraw exists. Raw compiler
profiles are build-script/proc-macro coverage only, not handler execution evidence.
Resource + D46 + X3 dependencies resolved: conditional next estimate **10–30 minutes**
incremental build plus **5–10 minutes** recording; not a measured completion promise.

Syntax jobs `20261105175358-ffef8e` (launcher) / `20261105175359-13b0f7` (browser harness)
both exit0. No implementation change was made merely to obtain another green test.

First official lane-gate passed all four checks at `324f4a062`, baseline `3f11b9c74`,
18:14:08.369Z (typecheck 20261105180719-11bfd7, boundaries -eb5ec6, strict -5502aa,
tests -77a304; all exit0). Final gate must cover the subsequent output-parent fix
`10bf3d939` and the newly integrated X3 public-API consumer test. X3 publication
is no longer an open startup dependency; PDFium/D46/LLVM/event limitations remain.

## Status / recovery

WP-012 on 2026-11-05: the direct `log = "0.4"` dependency is repaired. The brief
authorizes incremental retry and confirms Rust/Linux prerequisites are installed.
C2 subsequently confirmed the live dedicated `rust` queue class and all existing
34 IDs. WP-012 was delivered partially complete at 15:07Z; no successful reference
build or comparison is claimed. The final status update records the new jobs=12
policy and the formal WP-043 dispatch boundary; historical blockers remain below.

Reference baseline: `2ee9a9cbe`. Current status: architect-approved first build
`20261104143346-a72af4` failed at the harness's missing direct `log` dependency;
173.779 seconds, exit 101. No reference execution yet. Incremental repair is now
authorized; no retry or second-batch build has been run. Earlier preparation entries
below describe the pre-authorization state.
Initial framework checkpoint: `d6de3aebf` (coordinator checkpoint).
This lane has no pre-existing TESTMAP; coverage is tracked here and in fixture manifests.
Ledger job `20261104103317-a3c1fe` exited 0:

```
ledger: commands 1058 (A 92% B 5.9% C 0%), tests 8036 (A 80.4% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

## One-build proposal (NOT approved)

One JSONL executable, `{fn,args}` -> `{ok,value}` / `{ok:false,error}`. Reuse the
process and executable for every data vector. No Rust tests or separate examples.
Use dev profile, debug=0, incremental=true: compile/link dominates this workload;
release optimization across the dependency graph costs more than short vector runs.
Use `CARGO_BUILD_JOBS=8`, `nice -n 10`, one persistent target directory, isolated
data root. Build only after C2 approves this complete batch and the toolchain exists.

Current queue `scripts/electron-migration/jobs/runner.mjs:29` classifies vite builds,
but not cargo, as build. C2 must arrange cargo build classification before submission.
No workaround that silently consumes an `other` slot is authorized.

### Callable batch

| JSON fn | Frozen Rust callable | TS production endpoint | Comparison |
|---|---|---|---|
| tokens.estimate | dstu_util::utils::token_budget::estimate_tokens | llm/src/tokens.ts::estimateTokens | integer |
| text.safe_truncate / text.safe_truncate_chars | dstu_util::utils::text::* | platform/paths/text.ts | Unicode text |
| text.sanitize_unicode | dstu_util::utils::unicode::sanitize_unicode | platform/paths/text.ts | Unicode text |
| wrap.stream | ModelWrapTokenPolicy::for_provider_model; ModelWrapTokenStreamFilter::{new,process,flush} | platform/util/model-special-tokens.ts | each chunk + flush |
| embedding.estimate / embedding.chunk / embedding.limit | dstu_llm::multimodal::embedding_chunker::{EmbeddingChunker,EmbeddingTokenLimits} | llm-providers/src/multimodal/embedding-chunker.ts | integer, ordered chunks |
| fsrs.sanitize / fsrs.fuzzFactor / fsrs.fuzz / fsrs.parameters / fsrs.curve / fsrs.schedule | dstu_learning::fsrs_scheduler::{sanitize_steps,fuzz_factor_for,with_review_fuzz,effective_parameters,forgetting_curve_constants,build_fsrs,schedule} | review/src/fsrs-scheduler.ts | exact numeric values, phases/delays |
| crypto.staticKey / crypto.isEncrypted | dstu_security::crypto::CryptoService::{derive_static_key,is_encrypted_format} | platform/secrets/crypto-service.ts | bytes / bool |
| crypto.decryptBackup / crypto.checkVerifier | dstu_security::crypto::backup_crypto::{decrypt_backup,check_password_verifier} | platform/secrets/backup-crypto.ts | bytes / bool / Display error |
| serde.EncryptedData | serde_json::from_str/to_value of dstu_security::crypto::EncryptedData | parseEncryptedData + serializeEncryptedData | Option/default/unknown/u8/sequence |
| regex.replaceAll | regex::Regex::{new,replace_all} (1.12.3) | platform/native/regex/index.ts | text / compile error |
| regex.projected | frozen private helper extraction proposed below | F7 replaceAllProjected (not published) | first excess bytes, output |

Pure calls have no database writes or events; command evidence requires both and
is tracked separately. Existing crates are dependencies, not rewritten algorithms.
`dstu-learning` brings Tauri/VFS and `dstu-llm` brings larger native dependencies;
their Linux system requirements must be resolved before the single build.
64-bit desktop is mandatory; wasm32 is not this reference executable.

### Additional serde batch / unresolved endpoints

Inventory all contract `$defs` and Rust serde structs/enums statically before approval.
Candidate dynamic types: core models ChatMessage, ToolCall, ToolResult, RagSourceInfo,
DocumentAttachment, MultimodalContentPart, TempStreamState, AnkiCard; security
PasswordVerifier and EncryptedData. Non-exported TS decoders must be identified;
never substitute schema validation for production decode/re-encode.
UTC `Z`, Option omission, unknown fields, integer limits and enum variants are
fixture axes. Path/index generation scenarios need owning lane command harnesses.
Cloze/template coverage uses the public image-occlusion field builder below; it
does not claim full APKG template rendering. The batch remains unapproved.

### Regex private helper request

`chatanki_transform.rs:466-548` contains private `capture_reference_len`,
`expanded_replacement_len`, `add_projected_bytes`. Proposed AST extraction copies
their source unchanged into the reference crate; wrapper uses full-text captures,
gap then expansion then tail, only materializing replacement after checks.
C2 approval required for this source-extraction approach. Desktop usize64 is required.
Large accumulation vectors call arithmetic only, never allocate a 4 GiB string.
This executable is not a production F7 WASM build and grants no such authorization.

## Static findings (not C evidence)

- L02 tokens.ts:28-31 uses Hangul Compatibility Jamo U+3130..318F, misses Rust
  token_budget.rs:173-174 U+A960..A97F and U+D7B0..D7FF. tokens.ts:49-59 accumulates
  f64 whereas Rust uses f32. Fixed adversarial vectors will retain these inputs.
- L24 transform.ts:521-523 materializes replacement before checking its final size;
  Rust :562-584 stops at first over-limit gap/expanded/tail. F7 projected API missing.

## Evidence discipline

Object key order ignored; array/event order retained; absent != null; integer JSON
tokens kept as BigInt; no global float epsilon or guessed volatile columns.
Pure/static results cannot promote any command to C. Missing oracle/adapter is blocked.

## Non-cargo delivery checkpoint

- `record/json.mjs`, `process.mjs`, `run.mjs`: exact integer JSON, first JSON-pointer
  difference, one persistent JSONL process, report per vector/lane; unavailable != Err.
- `host/e2e/differential/ts-adapter.mjs`: production imports for the proposed pure batch.
- `record/generate.mjs`: fixed seed 0x5837 + Unicode/range/chunk/fuzz/serde/regex boundaries.
- Static inventory job `20261104110254-2c089f`: **1847** Rust declarations / **977**
  contract definitions. Raw attributes/declarations retained, not guessed schemas.
  This includes test/local/private definitions and is an over-inclusive inventory,
  not a claim that all are IPC/persistence types or covered dynamically.
- Regex source extraction job `20261104110416-db343f` exited 0; functions unchanged.
  Added callable `regex.accumulate(initial,additions,limit)` for allocation-free usize64
  accumulation vectors. It has no public F7 production counterpart yet.
- `record/database.mjs`, `replay.mjs`, `provider.mjs`: snapshot copies, all-table DB
  comparison, ordered returns/errors/events, scripted JSON/SSE/retry/disconnect provider.
  Real Rust command host and per-lane TS plugin lifecycle drains remain unprovided.
- `record/golden.mjs`: emits the exact `{commands:{name:pass|fail}}` ledger input;
  rejects pure/static or provenance-free reports. No passing C evidence generated.
- Queue test `20261104110627-3f8213`: **7 passed**, exit 0. These are framework tests,
  not Rust↔TS dynamic evidence. TS production imports execute successfully.

### Current blockers

1. C2 approval and toolchain/build-class queue support: no compilation authorized.
2. Other than EncryptedData and AnkiCard, serde TS decode/encode entrypoints must be bound per owning lane;
   all 977 contract types are not yet dynamically covered.
3. F7 projected regex API absent. Extracted native oracle does not publish that API.
4. Full Rust headless command harness is not exposed by existing crates: app commands
   require AppState/Tauri state. Replay factories exist, but no fake Rust baseline used.
5. Historical SQLite snapshots/three-platform runs not recorded yet; no C promotion.

## Completed batch proposal, revision 2 (still no build authorization)

The complete executable dispatch currently contains **33 IDs**: the table above,
`regex.accumulate`, the ten `serde.*` types enumerated above (including EncryptedData),
and these additions:

| JSON fn | Rust source / dependencies | TS production entry | Evidence |
|---|---|---|---|
| time.utc | chrono::DateTime::parse_from_rfc3339 -> UTC to_rfc3339_opts(AutoSi,useZ) | platform/time::{parseRfc3339,toRfc3339Opts} | UTC Z versus +00:00, nanoseconds |
| cloze.fields | dstu_anki::anki_image_occlusion::{validate_spec,build_card_fields}, default OcclusionConfig | anki/src/image-occlusion::{validateSpec,buildCardFields}, consumed by anki-sync.ts:373 | cloze escaping, HTML attr, fields / issue array |
| serde.AnkiCard | dstu_core::models::AnkiCard | anki/src/anki-cards.ts:119, production consumers plugin.ts:240 and plugin-handlers-cards.ts:206 | actual production decoder, explicit ID/time fixtures |

`dstu-anki` is added as an existing-crate dependency; it shares the already included
LLM/storage graph. No frozen crate source changed. For non-serde numeric vectors,
Rust f32 outputs are losslessly widened to f64 **before JSON transport**, avoiding
f32-shortest-display versus JS-number-display artifacts. No epsilon is applied.
Serde output retains native serde serialization behavior.

All 977 contract definitions now have candidate input records in `serde-inputs.json`:
**14220 inputs, 1 unresolved definition** (job `20261104111647-ba1185`, exit 0).
These are inputs, not expected values; unknown/default/null/variant/integer mutations
may be invalid and should exercise the actual decoder. Only the approved callable
types can become Rust dynamic results; the rest remain pending static inventory.

TS preflight job `20261104111712-45c81c` exited 0, exercising actual production
modules, including FSRS scheduling, UTC, cloze, and native regex. Unpublished projected
regex and unmapped serde decoders are explicitly blocked; this exit code certifies
the preflight script completed, not Rust parity. Full report is generated under
`fixtures/differential/reports/ts-preflight.json` (ignored runtime artifact).

### Reproduction (all execution via job queue)

```
node scripts/electron-migration/jobs/job.mjs submit -- node --test host/e2e/differential/framework.test.mjs
node scripts/electron-migration/jobs/job.mjs submit -- node scripts/electron-migration/record/generate.mjs
node scripts/electron-migration/jobs/job.mjs submit -- node scripts/electron-migration/record/serde-inventory.mjs
node scripts/electron-migration/jobs/job.mjs submit -- node scripts/electron-migration/record/serde-samples.mjs
node scripts/electron-migration/jobs/job.mjs submit -- node scripts/electron-migration/record/preflight.mjs
```

After explicit build approval only: dev binary manifest is
`src-tauri/crates/dstu-differential/Cargo.toml`; use a persistent
`src-tauri/crates/dstu-differential/target` and seed the standalone lockfile from
`src-tauri/Cargo.lock` before its first resolution. The nested workspace duplicates
the frozen root's four local patches because Cargo does not inherit root patches
across workspace boundaries. C2 must first fix/confirm queue build classification.
Run with `CARGO_BUILD_JOBS=8 nice -n 10`; do not clean target or use release/LTO.
Record build job ID, frozen Rust revision, target, profile, dependency lock path and
binary path in build-provenance.json. No bootstrap script silently invokes cargo.

```
node scripts/electron-migration/jobs/job.mjs submit -- node scripts/electron-migration/record/run.mjs fixtures/differential/vectors.json <binary> <report.json> <build-provenance.json>
node scripts/electron-migration/record/golden.mjs <golden.json> <real-command-replay-report.json>
node scripts/electron-migration/jobs/job.mjs submit -- node scripts/electron-migration/ledger.mjs --golden <golden.json> --check --no-write
```

Command replay framework now records per-command DB changes and all lifecycle
events as well as final snapshots. The missing app-state Rust command adapter is
remaining X7 work that requires a larger approved app dependency/build scope, not
evidence of successful replay. Existing command signatures such as
`commands.rs:342,563` require `State<AppState>`; `:533,616` require AppHandle.
No command has been marked C on the basis of a crate helper or TS-only execution.

## C2 review corrections / integration repair (supersedes rev2 build graph)

1. **Oracle errors preserved.** `serde.EncryptedData` now calls `roundtrip` directly.
   Its Rust serde failure is not converted to TS's `null`. `crypto.isEncrypted`
   remains the distinct, genuine Rust boolean API. Invalid JSON/u8/required-field
   vectors may intentionally differ from the TS parser; the oracle does not adapt
   itself to make them pass.
2. **Original regex function retained.** `extract-regex.mjs` reads `git show` at
   fixed `2ee9a9cbe`, extracts the three helpers AND original `bounded_regex_replace`,
   original growth constant, error struct/derive and error detail impl. `--check`
   regenerates and compares the complete bytes. `regex.projected` is explicitly
   an *adapted explicit-limit primitive*, not the original product policy.
   `regex.accumulate` is an arithmetic probe with no F7 production endpoint.
   A proposed **34th ID, regex.boundedOriginal**, calls the exact original function
   (opIndex=0/front, original max(1 MiB,input) policy) against the real L24 async
   transform. This addition is for C2's original-oracle requirement and still needs
   inclusion in the single approved build batch. Capture-path vectors remain
   blocked while F7 lacks the projected primitive. No production WASM is built.
3. **Smaller build graph proposed.** `freeze-modules.mjs` copies the complete frozen
   fsrs_scheduler.rs / embedding_chunker.rs / anki_image_occlusion.rs unchanged;
   a separate origin.json records the fixed commit and paths; `--check` compares
   full bytes. These modules have no production crate/super references. Dependencies
   are respectively chrono+fsrs, log, serde+serde_json (the initial manifest missed
   the log dependency; see the first-build failure below). `main.rs` loads the exact
   files as modules, not rewritten functions. Existing dstu-core/util/security remain
   crate dependencies. This removes dstu-learning/VFS/Tauri, dstu-llm and dstu-anki's
   unrelated runtime graphs, and the now-unreferenced four patches. This is source
   preparation for review, **not approval to compile**. Snapshot sources have cfg(test)
   sections but no Rust tests will be built/run.
4. **Lock seed.** `seed-lock.mjs` creates the standalone Cargo.lock once from the same
   frozen root Cargo.lock with exclusive creation; it never overwrites a resolved
   build lock. `--check` verifies initial byte identity. The first approved build
   must add this standalone package and prune unused packages; no lock resolver has
   been run. Existing package versions are seeded, regex=1.12.3 and fsrs=6.6.2 pinned.
5. **Environment read-only probe:** `type -P cargo rustc cc gcc pkg-config` found only
   `/usr/bin/cc` and `/usr/bin/gcc`; pkg-config command is absent. Toolchain and native
   dependency readiness remain unconfirmed. No cargo/rustc/metadata/fetch/check invoked.
6. **Integration test discovery repaired.** main merged in `767a32906`. Added Vitest
   `.test.ts` entry that runs the unchanged nine node:test recorder checks in their
   real Node runtime, failing on subprocess error and checking nine-pass/zero-fail.
   Required gates after merge all exit 0:
   - typecheck:host `20261104112611-580594`;
   - migration:boundaries `20261104112611-f05338`, 2404 files / 0 violations;
   - Vitest lane filter `20261104112611-3be107`, 1 wrapper / 9 underlying checks.
   No assertion was weakened or test skipped. C1/C2 receipt does not cause reruns.

### Persisted coverage and findings

Prior 33-ID preflight: **566 vectors, 530 executed on TS, 36 blocked**. Added original
regex-policy cases are data additions to the proposed 34-ID batch, not new Rust builds.
Static finding file is now tracked with the lane checkpoints. C1 confirmed L02
Hangul and L16 strict-decoding findings and dispatched them; do not claim fixed.
New serde producer review found L03 `microcompact.ts:36-48` emits externally tagged
`{Text:{text}}` / `{image_url:{...}}`, while frozen models.rs:107-123 uses internal
`type` with lowercase text / image_url plus mediaType. Actual constructors are used
by images.ts:331,347 and retrieval-images.ts:188. These are static/TS producer findings,
not a substitute for the missing production roundtrip decoders.

Source preparation receipts (no Rust execution):
- Original bounded regex extraction byte check `20261104113211-401be0`: exit 0.
- Three complete frozen modules prepared `20261104112823-921f01` and byte-checked
  `20261104113502-87ac4e`: both exit 0.
- Initial lock seed `20261104113211-d46f24`: exit 0; follow-up byte check
  `20261104114113-691787`: exit 0. After the approved build resolves the lock, report
  the actual resolved file/versions; do not keep calling it byte-identical to the seed.
- Eight static source/TS findings persisted by `20261104113211-9d0d2e`, exit 0,
  and saved in checkpoint `2d21984b6`; C1 notified with both new L03 IDs.
- `crypto-vectors.mjs` prepares ten deterministic valid/wrong-password/tag-corruption
  KDF/AES/verifier **inputs** through the production TS writer, using only existing
  decrypt/check IDs (no new Rust callable). Job `20261104114005-04af95`: exit 0.
  No TS-generated value is used as a Rust expected output.

## Final preparation scope confirmation (C2 review messages)

C2 confirmed the **34-ID** batch, byte-identical complete-module snapshots and
smaller dependency graph as the preparation plan. This explicitly is **not** cargo,
fetch, metadata, prewarm or trial-build authorization. Toolchain notification and
build-class queue/system dependencies still gate the first build.

`check-reference-tree.mjs` is a required precondition in that future approved build:
it compares every tracked core/util/security file plus the parent Cargo.toml and
Cargo.lock byte-for-byte with fixed `2ee9a9cbeb2bff3d31748afdc3d951c166228f74`,
records the source list and requested features in `reference-origin.json`, and fails
on any drift. **Do not merge or mutate source between this check and the approved
build.** A future main drift is rejected, never silently used as the reference.
No Rust baseline file is overwritten by this check. Initial job `20261104114531-c82191`
exited 0: **45** path-dependency/workspace files byte-identical to the fixed baseline.

Targeted TS preflight of the new exact-policy endpoint `20261104113702-33d189`:
2 literal-replacement cases executed, 1 captured-replacement case blocked on F7;
the large-output case uses only 1024 matches / 4096 replacement bytes, not a huge
match array or multi-GiB replacement. No prior nine-check suite was rerun for receipts.

Outstanding C evidence remains explicit: no compiled oracle, no Rust-generated
serde outputs, unmapped TS decoders blocked, no full AppState command replay, and
no historical/three-platform replay. Ledger C remains 0%, rather than counting
static findings, generated inputs or a TS-only preflight as parity.

Final candidate-input generation `20261104114531-b6e388` exited 0: **977 types,
14226 inputs, 0 unresolved schema shapes**. The sole generator gap was an allOf
containing required-alias anyOf branches; it now retains the parent properties.
This closes candidate generation only, not dynamic decoder coverage.

## Automatic continuation: recorder self-review

Merged current main; shared lane-gate passed at `95eed3c8d`, baseline `d84e29565`
(typecheck, boundaries, changed strict boundaries, tests). No build blocker lifted
and no cargo authorization received. Added `host/e2e/differential/LANE.md` so resume
instructions have a lane-local remaining-work record rather than treating C=0 as done.

Two actual false-pass risks found and fixed in owned recorder code:

- **X7-NUMBER-LOSS:** integer tokens were exact but decimal/exponential tokens went
  through Number; `1e999` and `2e999` both became Infinity, and distinct large or
  high-precision decimals could compare equal. Rust serde_json::Value explicitly
  uses arbitrary_precision in this oracle. Now non-integer tokens use JSON.rawJSON,
  and numeric comparison canonicalizes coefficient/exponent without expanding large
  exponents or rounding. Equivalent numeric spellings still compare equal. Regression
  assertions cover exponent overflow, >2^53 exponential integers, fractional precision,
  exact serialization and negative zero.
- **X7-C-EVIDENCE-AXES:** two equally incomplete command reports could pass the exporter
  without before/after database snapshots, DB changes or events. The exporter now
  requires those axes on both observations before comparing/promoting command evidence.
  Regression assertions remove each axis from both observations and require rejection.

Both fixes are in the existing nine-check suite; no old assertions removed, skipped
or weakened. They address v2 data boundaries and evidence completeness. Pure adapters
continue calling production modules; all SQLite writes in tests stay in fixture copies;
transport/setup failures remain blocked rather than matching application errors;
process/host/fixture cleanup remains in finally. Rust reference source is unchanged.

## SQLite observation completeness follow-up

Post-merge shared gate passed at `f7eccb522`, baseline `45c3250b0`, all four checks.
No C2 build conditions or missing production capabilities have been released.

Self-review finding **X7-SQLITE-STATE**: the recorder queried only non-internal
tables. Identical application rows could conceal missing indexes/triggers/views,
changed AUTOINCREMENT state, or INTEGER versus REAL storage. These are supported
project behaviors: `dstu-storage/src/migration/chat_v2.rs:710,778` uses AUTOINCREMENT;
storage's migration SQL inspector handles indexes/triggers, and repair/coordinator
tests exercise their persistence. Such differences affect subsequent commands.

Snapshot now returns `{schema, metadata, tables}`: sqlite_schema definitions ordered
by type/name, user_version/application_id, every table including sqlite_sequence,
and each row's SQLite storage classes. Values stay exact; PK ordering is preserved;
tables without PK use canonical typed row ordering. Contract-declared volatile
columns mask both the value and storage-class token; other columns are not hidden.
Physical SQLite page locations are not observed. DB diff separately reports schema,
metadata and table changes. Both sides still read only their isolated fixture copies.

Added a tenth real-SQLite recorder test: create index/trigger/view, insert then delete
an AUTOINCREMENT row, change integer 1 to real 1.0, update pragmas, and prove all these
are detected even when application row values match. It also proves no-PK insertion
order does not generate noise. Existing PK/i64/blob/foreign-write/volatile assertions
are retained, with snapshot access updated to `.tables`; no Rust test assertion is
being changed. The new unit requires a fresh shared lane-gate before ending.

### L16 candidate receipt / finding scope clarification

C1 reported implementation `9de6ab07b` / `1e2356b29` and report `1e9f3a999`.
`git branch --contains 1e2356b29 --list main` returned no main branch at review time.
Read the candidate decoder with git show: front now uses expectString, tags maps
expectString over every element, and extra_fields validates every map value.
This is static candidate confirmation only. C1's 80-pass job is not X7 execution
evidence; re-run the original three probes only after normal main contains the fix.

The original three findings concern **production decoder direct calls / internal
assembly**. The IPC kernel already rejected these typed inputs. They do not assert
an IPC validation bypass. Added this scope to the saved findings and generator;
input values and frozen Rust rejection expectations remain unchanged. No C credit
and no Rust rebuild requested for the candidate.

## Normal-main revalidation and scripted provider correction

During the next continuation main advanced between merge and selfgate, so the first
attempt exited 2 without running checks. Merged again; shared gate then passed at
`c334fea66` / main `ad11a8394` (all four checks). No Rust authorization received.

Normal main now contains L02 token and L03 multimodal producer fixes. Independent
job `20261104131237-6d2fa8` reused the original saved inputs/expectations and invoked
the production functions: **three L02 + two L03 cases match their static expectations**.
`fixtures/differential/recheck-L02-L03.json` is separate from historical findings;
neither old expected values nor old actual results were replaced. C1 notified.
This does not claim whole-pipeline equivalence or dynamic C evidence. L16 still was
not on normal main and was deliberately excluded from this recheck.

L23's new `marker.ts:27-35` has the actual PasswordVerifier decoder, called by its
production marker decoder, but it remains private. Requested that C2 coordinate
export of that same function so X7 can use public `fromSlice` at the original JSON
root and retain error line/column positions. No duplicate decoder or marker wrapper
that changes error positions was substituted. The Rust PasswordVerifier ID already
exists in the frozen batch and needs no new compilation for this TS hookup.

Two reproducible defects in the scripted external provider were found by new tests:

- **X7-PROVIDER-UTF8:** per-Buffer string concatenation corrupted a Chinese scalar
  split across HTTP chunks, turning a matching request into HTTP 500.
- **X7-PROVIDER-TRUNCATION:** immediate socket.destroy discarded queued output,
  producing a pre-header socket hangup instead of the scripted mid-stream SSE cut.

Red job `20261104131750-adac52`: both new real-HTTP cases failed (0 pass / 2 fail).
The provider now uses the incoming stream UTF-8 decoder, flushes headers, awaits
write callbacks, and ends the socket without the HTTP terminal chunk for a scripted
disconnect. No fixed sleep or invented provider response was added. The receiver
must observe HTTP 200 plus the exact Unicode SSE prefix and then an aborted body.
These two assertions extend the unchanged prior ten checks to twelve; final shared
selfgate is required after the fix. This changes only the test supplier, not a
production provider implementation or any frozen Rust callable.

## Bounded input expansion without recompilation

Initial gate this continuation passed at `6c7e46510` / main `16a254adf` (all four
checks). L16's earlier decoder candidate and the public PasswordVerifier seam still
are not in this normal main. The architect's 22:00 gate-runner/gate-excerpt outage
is infrastructure-owned and was not treated as a lane code defect.

`generate-boundaries.mjs` adds **146** deterministic inputs, seed `0x583734`, using
only the existing 34 approved IDs: 64 FSRS phase/memory/step/saturation combinations,
36 fuzz threshold cases, 22 cloze validation/normalization cases, 12 UTC parser/format
cases, and 12 KDF/verifier rejection cases. The latter use malformed inputs or
application/Argon2 parameter guards; no large-memory valid KDF request is generated.
Generation job `20261104140149-e8c88b` exited 0. TS preflight accepts an alternate
fixture path and records it; `20261104140407-948382` executed all 146, zero unavailable.
Neither generator nor preflight writes Rust expected outputs or grants C evidence.

**X7-UTC-OBSERVATION:** time.utc previously translated parseRfc3339's legitimate
null result into Unavailable. It now records null, just as the production API returns
it, so an eventual chrono Err versus TS null will be a visible difference rather
than a missing-capability status. Rust keeps its original ParseError. Two regression
assertions cover empty/invalid strings; all previous twelve checks are retained.

The new corpus exposed two static-source/production-execution L16 differences:
`boundary:cloze:1` accepts an imageRef containing only U+0085, whereas frozen Rust
str::trim makes it empty and emits empty_image_ref (:219-223); `boundary:cloze:18`
retains U+0085 as a label, whereas Rust fills `区域 1` (:332-336) and renders
`{{c1::区域 1}}`. TS image-occlusion.ts:41,67,69-70 uses JavaScript trim. Saved source
citations, actual output, job and exact inputs in `cloze-boundary-findings.json`.
Scope is production helper/internal composition, not an IPC bypass. These findings
do not use a compiled Rust oracle and do not change the frozen Rust expectations.

## First authorized build: failed, complete evidence retained

Architect/C2 authorized exactly the first 34-ID batch on 2026-11-04. Reference
check `20261104141815-83e327` passed: 45 files byte-identical to the fixed revision.
No merge or reference-source changes occurred between that check and the build.

Only build submitted: **20261104143346-a72af4**, exactly:

```
env CARGO_BUILD_JOBS=8 nice -n 10 cargo build --manifest-path src-tauri/crates/dstu-differential/Cargo.toml
```

- Queue start 14:33:47.507Z, end 14:36:41.286Z: **173.779 seconds** (queue wait excluded).
- Actual queue class **other**, not build; reported to architect/infra with the
  existing job ID. No cancellation/requeue or duplicate build was performed.
- **Exit 101**. First error: `E0433 cannot find module or crate log in this scope`,
  frozen embedding_chunker.rs:83. All seven reported errors are the same missing
  direct dependency at lines 83/95/241/326/335/461/558. This is X7's manifest omission,
  not a bug to repair in frozen production Rust.
- 279 `Compiling` log entries (including the unsuccessful harness); 438 resolved
  packages. Original app lock has 1347 packages. The only resolved package absent
  from the original lock is the new dstu-differential package itself: dependency
  versions were retained. `log 0.4.29` is already in that resolved/cache graph.
- Compiler cache records the actual toolchain: rustc **1.98.1**, host
  x86_64-unknown-linux-gnu, LLVM 22.1.8. No extra rustc/cargo probe was run.
- Full original log, pre-repair manifest, actual resolved lock, compiler info and
  receipt: `fixtures/differential/builds/20261104143346-a72af4/`.
- **Reference run time 0; comparison not started** because no executable was produced.
  TS preflights are not counted as Rust passes. No command C evidence is emitted.

Requested explicit permission for one incremental repair: add only `log = "0.4"`
to the new crate (same as frozen workspace declaration), retain the same target,
versions/features and 34 IDs. No cargo retry has been made. The likely remaining
work is harness codegen/linking, estimated seconds to one minute, not a measurement.

`run.mjs` now retains the actual Rust envelope even when the TS decoder is blocked.
`batch.mjs` is prepared to run all three corpora through one persistent binary,
then generate canonical serde samples via existing types and decode/re-encode them
through production TS. Canonical mode supplies Rust-generated UUID/time values to
TS instead of masking defaults; failed Rust decode retains the original input and
error. Reports retain both sides, per-lane differences and monotonic runtime.
Its golden manifest keeps `commands` empty until real command/event/DB replay exists;
function-level evidence is a separate field, pending ledger-owner support. This
does not loosen the existing command observation-axis guard.

## Second batch proposal (not authorized, not compiled)

**Scope:** actual production IPC command replay, starting with fixed-ID fixture
reads/updates/CAS failures and deterministic error paths; then streaming/cancellation
against the scripted provider. Freeze the full command/scenario list before another
build. Use the existing app's command registration and services, not copied command
logic or a fabricated AppState. Keep all external data and credentials in the
isolated fixture profile; explicit terminal events determine completion.

**Bootstrap decision required:** `commands.rs:681-719` AppState holds real database,
LLM, notes, PDF services and a concrete `tauri::AppHandle`. Production
`lib.rs:3482` build_app_state and :3466 manage_shared_services are private;
the registry is inside run() (:1908). `tests/app_command_acl.rs:31-74` demonstrates
mock_builder/get_ipc_response only for a test command, not that the real AppState
can be built on MockRuntime. Select an approved route to the real startup/registry
(for example an isolated real Tauri app with a recorder), before paying for the
full build. Do not pretend that the ACL test supplies a headless app factory.

**Observations:** same copied SQLite seed, fixed business IDs where supported,
same input sequence, actual return/error/event order and per-command + final SQLite
schema/metadata/typed-row changes. Volatile normalization must be contract-declared;
generated relational IDs cannot simply all become one placeholder. Keep protocol
output separate from legacy stdout diagnostics. Only these complete scenarios may
populate command-level ledger golden entries.

Pending-first-run tooling checks: `20261104152445-64486a` passed the focused
recorder test including preserved Rust results on TS blockage and canonical
AnkiCard input through the real decoder; `20261104155827-491c1d` passed batch CLI
syntax checking. Neither executes the missing reference binary. Results are stored
per build/run directory so subsequent TS rechecks do not overwrite historical runs.

C1's cloze repair receipt is candidate-only: actual code/tests `5e05f9bc0`,
`4194d8827` is documentation. Normal main did not contain the code at receipt time.
C1's provider test counts (3 files/62 pass including 9 new cases; broader 785 pass/1
skip) are not X7 independent evidence. After integration, recheck only the original
IMAGE-TRIM/LABEL-TRIM inputs plus necessary same-cause cases; do not rerun 146 cases
solely for that repair, expand the Rust batch, or automatically close other basename
trim behavior. The architect-authorized first Rust batch remains a distinct run.

**Build/cache:** retain production default features (Cargo.toml:596), including
lance, precise tokenizer, S3/data-governance as relevant to real behavior. The full
graph contains lance/arrow/datafusion/AWS and Linux WebKitGTK (:275,550), unlike the
first graph. Confirm needed Linux GUI/headless runtime libraries and isolation
before submission. Same target, jobs=8/nice=10/dev; align root and per-package debug
settings to 0 for cache reuse rather than inheriting line-tables-only defaults.
No clean. Source/feature/lock provenance must be frozen again for that approved batch.

**Preliminary time budget:** first dependency build took 2m53.779s with 438 resolved
packages and 279 compile starts; full original lock has 1347 packages (not all target
Linux, so this is not a compile-count forecast). A naive count scaling is about
9 minutes and likely understates heavy generic crates/linking and feature rebuilds.
Plan **20–60 minutes cold**, **10–40 minutes with reusable cache**, excluding new
system-package setup; these are estimates, not measured app builds. Initial small
scenario replay budget **2–10 minutes**, also unmeasured. The queue's current 30-minute
timeout must be agreed before a potentially longer single app build. Reassess after
the approved first harness succeeds; do not launch the app graph to obtain estimates.

## L16 decoder findings independently revalidated on normal main

Next continuation merged main; an intervening main advance caused selfgate to exit
2 without checks, so merged again. Gate passed at `c9a9e1371` / main `fd925aa05`.
Normal main now contains the actual decoder fix `1e2356b29`.

Job **20261104163838-b3c3ab** called the production decoder with exactly the three
saved historical inputs (fixed ID/time, numeric front, numeric tag item, numeric map
value). All three throw **AnkiCardDecodeError** and match the unchanged source-backed
rejection expectation. An unrelated exception or attempted volatile default fails
the recheck rather than being counted as a correct rejection.

New report: `fixtures/differential/recheck-L16-decoder.json`; original findings and
actual values remain intact. This closes the original three direct-decoder/internal
composition findings only. It is not proof of an IPC bypass, complete serde error
message/position parity, or dynamic C evidence. No Rust command was executed.
The cloze repair `5e05f9bc0` and public PasswordVerifier seam are still absent from
normal main at this check; their separate pending states are unchanged.

## Linux continuation / main-red repair (2026-11-05)

Recovered from clean `df6dd3619`, read the lane coverage record (no separate
SPEC/TESTMAP/BLOCKERS files exist for this lane), and merged main. The initial
Vitest reproduction `20261105000349-ab3429` failed the reported wrapper in 5.952s;
its old execFile rejection hid the underlying Node stdout from the failure output.

Source diagnosis: the production-adapter check still required `regex.projected`
to reject with Unavailable. F7 has now published `replaceAllProjected` in
`host/platform/native/regex/index.ts:49-54` (implementation `4b2c21d37`). This is
an obsolete X7 availability assertion after integration, not grounds to undo F7's
API. Escalation `2026-11-05T000411404Z-X7-differential.md` notified the architect.
The test now calls the real native engine and asserts exact successful output,
byte count, and first capture-expansion overflow without a returned value. The
unpublished-function rejection and blocked-vector checks remain. These are recorder
checks, not changes to any ported Rust test or its assertions.

The wrapper now reports child stdout/stderr on failure and explicitly selects TAP
for its twelve-pass/zero-fail assertions, so fulltest can expose future root causes.
The existing timeout and child failure requirement are retained.

L23 has also published `decodePasswordVerifierBytes` / `encodePasswordVerifier`
through `api.ts:90`. Bound the already-frozen `serde.PasswordVerifier` ID to those
production functions: raw input bytes are decoded at the original JSON root,
then the real serializer produces the output. Required-field error position,
u32 overflow, sequence input and ignored unknown fields are checked through this
adapter. No copied decoder, Rust change, or extra dispatch ID is introduced.

The two L16 cloze trim repairs (`5e05f9bc0`) are now on main. Added a targeted
recheck of only the two original saved vectors and expectations; the historical
findings file is left intact. Its output is separate and explicitly not dynamic C.

Remaining evidence blockers: first Rust build still lacks incremental-repair
authorization; seven core serde types still lack mapped production roundtrips;
the approved full AppState bootstrap/build route, historical snapshots and
three-platform command replay are outstanding. F7 projected-regex and L23 verifier
entrypoint publication are no longer missing capabilities. No cargo was invoked
during this continuation and no command C evidence was emitted.

Validation receipts for `49b339267` and the recovered tree:

- `20261105000348-d47d92`: `npm run typecheck:host`, exit 0.
- `20261105000708-d57e80`: Node recorder suite, **12 passed, 0 failed, 0 skipped**,
  5050.615 ms, exit 0. The real WASM success/overflow checks and production verifier
  roundtrip/error assertions passed.
- `20261105000513-32a276`: the two original L16 cloze findings both
  `matches-static-expectation`, difference null, exit 0. Committed report is
  `fixtures/differential/recheck-L16-cloze.json`; C1 notified via coord queue.
- `20261105000348-1b28f1`: ledger check, exit 0. Global output (not X7-specific A/B):

```text
ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 87.8% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 16 (unknown 3633, not vetoed)
```

The final post-commit lane-gate is recorded separately by the coordinator's gate
receipt; passing the focused suite alone is not described as passing that gate.

## Per-command C evidence completeness (2026-11-05 continuation)

`f530c9eac` passed all four shared gate checks against main `c6309183c`.
The next continuation merged main `a9683a43b`; no incremental Rust build approval
or new core codec exports appeared. Read-only inspection found the original
`dstu-differential/target/debug/{deps,build,incremental}` directories and its saved
rustc 1.98.1 metadata, but no executable. This confirms cache files exist, not that
a future compiler invocation will reuse every artifact. No cargo probe was run.

Self-review found **X7-C-CALL-EVIDENCE**: `goldenResults` validates top-level
database/event observations but accepts `calls: [{ command: 'x' }]` on both sides
as a passing command when those top-level fields exist. It also accepts partial
outcome envelopes (`{ok:true}` / `{ok:false}`) and absent per-command events/changes.
That is incomplete evidence, even when the incomplete observations compare equal.
The real `replaySide` already emits all these fields; no recording format change
is needed. Regression coverage belongs in the existing golden evidence test,
retaining explicit null outcomes as valid and retaining every earlier assertion.

Red regression job `20261105005417-4f5273`: **0 passed / 1 failed**, exit 1,
`Missing expected exception` for the missing command outcome. Fixed the exporter
to require each call's return/error envelope (including its value/error member),
event array and database-change object on both observations before assigning C.
The tests also reject missing events/changes and incomplete success/error envelopes,
while complete success-null and error-null records remain valid. Twelve test titles
are retained; no ported Rust assertion or production implementation is modified.

## WP-012 — log repair, build precondition and minimal command oracle

### Current execution status (supersedes historical blockers above)

- Started from a clean worktree and merged main `967f43c75`. Independent build/test
  processes were active; all checks use the shared jobs queue.
- Manifest fix: `src-tauri/crates/dstu-differential/Cargo.toml` now directly depends
  on `log = "0.4"`, matching frozen `src-tauri/Cargo.toml:183`. The failed build's
  resolved lock already contains `log 0.4.29`; no dependency upgrade, frozen module
  edit or Cargo.lock re-resolution was performed. Commit `939e0c16e`.
- The actual main-repository `jobs/runner.mjs:25–30` recognizes vite/build:demo/npm
  builds but not cargo. The exact proposed command below falls through to `other`.
  C2 and C1 received `host/e2e/differential/WP-012-blocker.md` via coord queue.
  X7 has not submitted a cargo build or disguised it as a recognized command.
- Existing `main.rs:63–126` contains **34** IDs, not 33: audit revision 2 had 33;
  later C2 preparation added `regex.boundedOriginal` (:126). This package adds
  zero IDs and removes zero IDs. The brief's 33-ID wording needs C1/C2 confirmation
  before building the pre-existing 34-ID program.
- Cache remains `src-tauri/crates/dstu-differential/target`; `debug/` contains
  dependencies/build/incremental artifacts but no `dstu-differential` executable.
  Original failed build `20261104143346-a72af4` / exit 101 and its complete log,
  lock and compiler receipt remain under `fixtures/differential/builds/`.
- **Current Rust→TS result: not run** (0 executed comparisons; no pass/fail claim).
  No reference binary, actual JSONL responses or command golden exists. The
  prepared `fixtures/differential/wp012-smoke.jsonl` contains requests only.
  It covers a real text helper, successful serde default/unknown-field handling,
  and a serde rejection; it is not an expected-output recording.

After the queue owner confirms the live runner classifies this as `build`, and
the ID scope is confirmed, use the already-authorized incremental command:

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- env CARGO_BUILD_JOBS=8 nice -n 10 cargo build --manifest-path src-tauri/crates/dstu-differential/Cargo.toml
```

Before that build, run existing reference-tree / frozen-module / extracted-regex
byte checks through jobs; no merge or Rust source changes between checks and build.
Keep dev/debug=0/incremental=true and the same target to minimize compilation time.
After build, retain the actual job class/exit/log with `record/build-receipt.mjs`;
run the smoke requests with isolated XDG directories and retain stdout/stderr,
then use `record/batch.mjs <binary> <provenance>` for the three existing corpora and
canonical serde inputs. Preserve all mismatches/blocked codecs. Its `commands:{}`
golden cannot award command C. A new external dependency failure must be reported.

### Minimum feasible command oracle (proposal, not implemented or authorized)

**Route:** launch the actual frozen Tauri app using its existing `run()` and Wry
runtime in an isolated Linux display session; drive IPC from the existing local
`main` webview using a WebKit WebDriver/tauri-driver recorder. This avoids any
private-function copy/export or alternative AppState assembly. Full app build and
driver availability still require a separately approved batch.

Source basis, read at the merged tree:

1. `src-tauri/src/commands.rs:681–719` has required real services and a concrete
   `tauri::AppHandle` (:717), not `AppHandle<MockRuntime>`. Its public fields do not
   make an independently assembled state equivalent to the production composition.
2. `lib.rs:3482–3485` private `build_app_state(PathBuf, tauri::AppHandle) -> AppState`
   constructs and manages VFS/LLM/PDF services and starts recovery/background work.
   `lib.rs:1321–1339` calls it, manages AppState, then private
   `manage_shared_services<R: Runtime>(&impl Manager<R>, &AppState)` (:3466) manages
   the **same Arc instances**. Calling a copied constructor would omit startup work.
3. Only `lib.rs::run()` (:458) reaches the actual builder and the command registry
   (:1908). `tests/app_command_acl.rs:10–13,31–33,74–79` only registers a local test
   function on MockRuntime; it is not a factory for production AppState/commands.

**Initial scenario: three actual commands, eight calls.** Seed one non-sensitive
`settings` row `x7.oracle.fixture = "seed"` with a fixed `updated_at`, then invoke:

```text
get_setting    {key:"x7.oracle.fixture"}
get_setting    {key:"x7.oracle.absent"}
save_setting   {key:"x7.oracle.fixture",value:"seed"}
get_setting    {key:"internal.oauth.x7"}
save_setting   {key:"internal.oauth.x7",value:"blocked"}
delete_setting {key:"x7.oracle.fixture"}
delete_setting {key:"x7.oracle.fixture"}
get_setting    {key:"x7.oracle.fixture"}
```

Rust entries are re-exported through commands and registered at `lib.rs:1980–1982`;
implementation `src-tauri/src/cmd/web_search.rs:542–578` injects real State and, for
save, real AppHandle. TS must use the real kernel registrations in
`host/plugins/browser/index.ts:339–355`, not `ctx.settings` direct calls. Same-value
save exercises success without clock normalization: frozen storage
`database/mod.rs:4108–4118` updates only when values differ; non-sensitive save
delegates there at :4230–4233. Deletion supplies a real DB mutation; internal keys
exercise the original typed error at `web_search.rs:15–24`. These calls do not
cover browser-network-mode, secure-store or every settings branch.

**Recorder contract:** provide the existing replay factory shape
`createHost({dataDir,scenario}) -> {invoke(command,args),events,settle(),close()}`.
Use unique HOME/XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME/TMPDIR roots inside the
fixture run and an approved isolated Tauri identifier; real startup derives its
base via `app.path().app_data_dir()` (:855–867) and selects an active data space.
Verify `get_app_data_dir` resolves to that fixture before starting the scenario.
Seed all declared databases from the same migrated fixture; capture startup changes
separately rather than silently resetting the before snapshot. Empty fixture
queues avoid scheduling unrelated recovery jobs, but actual readiness and event
drain still need a verifiable completion barrier, never an arbitrary sleep.

Install event listeners before scenario invokes; preserve original JSON return/error
payloads, event order and per-call plus final SQLite schema/metadata/typed-row diffs.
IPC automation failures are transport errors, not matching application errors.
Keep app stdout diagnostics separate from recorder JSONL. Do not mask timestamps,
startup differences or unexplained events to make the comparison pass.

**Why command recording remains blocked:** this small harness has no app dependency,
Wry app, actual registry or webview automation adapter. Private construction cannot
be called from it; the proposed real-app route needs full-app build authorization,
verified Linux display/driver support, a migrated isolated snapshot and an adapter
whose readiness/event drain accounts for startup tasks. C1/C2 must approve that
separate batch and the app/runtime owner must supply/validate the bootstrap boundary.
No new app build was attempted, and helper/serde vectors earn no command C.

### WP-012 validation receipts

Original job JSON and logs are committed in `fixtures/differential/wp012/`:

| Job | Check | Actual result |
|---|---|---|
| `20261105140230-b2aba4` | `npx tsc -p tsconfig.host.json` (queue-added incremental cache) | exit 0 |
| `20261105140232-c07566` | Vitest `host/e2e/differential/` | exit 0; 1 passed / 0 failed / 0 skipped; unchanged wrapper asserts 12 underlying Node passes / 0 failures |
| `20261105140411-4520ad` | Safely evaluate only the actual runner's classifier; enumerate dispatch and inspect existing target | exit 0; classification `other`, 34 IDs, binary absent; no Rust execution |

The classifier inspection extracts only `classify` into a VM context; it does not
import/start the runner or touch its running jobs. Its success means the inspection
completed, **not** that the build precondition passed. This is the retained blocker
original. No new build job/exit is available because submission is prohibited by
the brief in this classification. Final post-commit lane-gate job IDs/exit and tip
will be supplied in the WP-012 delivery report and shared selfgate receipt.

TESTMAP: absent before/after for this lane; no mapping or Rust test assertion changed.
Seven core serde production roundtrips remain unmapped; command C remains zero.

### WP-012 resume after interruption (merged main `cbf79a849`)

The interrupted session's lane-gate did not record a result. Merge `dff130742`
touched no frozen reference paths, queue runner, or cited command sources.
Lane-gate then passed all three checks at `dff130742`: typecheck
`20261105143508-003fd4`, boundaries `20261105143508-ffefad`, tests
`20261105143508-ecdb30` (all exit 0). Ledger `20261105143431-0cc755`, exit 0:

```text
ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 90.1% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 22 (unknown 3692, not vetoed)
```

The queue owner changed `runner.mjs:19,24,29`: cargo/rustc now has a dedicated
`rust` class, limit 1, 150-minute default timeout. The live `ds-jobs.service`
(ExecMainPID 2068047) started at 21:47:42 CST, before the 22:37:39 CST source change.
Its status limits still have no `rust` key, so it still runs the old classifier.
A cargo submission now would execute as `other` under the 30-minute timeout. No
build was submitted. C2 was asked to reload the service and confirm that `rust`
satisfies the brief's build class, and to confirm the 34-ID scope.

### X1 WP-041 WAVE0 B-driver handoff received

Read-only candidate review: X1 branch `c3cdcaca2`,
`host/e2e/smoke/b-driver.mjs` and `__fixtures__/scenario-v0.ts`.
At receipt, `git show main:host/e2e/smoke/b-driver.mjs` fails because the file is
not yet on main; it is also absent from this X7 worktree. This is an upstream
candidate interface, not an executed or integrated X7 recording.

- Entry: `runScenario(scenario, freshAbsoluteDirectory)` under a queued Xvfb job.
  The candidate drives `__TAURI_INTERNALS__.invoke` on the launched webview and
  returns `wave0-v0-B-raw`. CLI exit 0 means recording completed, not parity.
- Preserve `wire.jsonl` as the numeric comparison source; `B.json.results` is a
  parsed projection. Retain Host event envelopes and receive order, including
  correlation IDs/targets/payloadJson. Do not reserialize parsed numbers as raw
  evidence or sort/deduplicate events.
- The event window ends 250 ms after the last step. This does not establish stream
  completion; X5/X7 still need a scenario-specific terminal condition.
- Current validation accepts only `seed:empty`, `capture.db:[]`, `normalize:[]`.
  Named seeds and database capture wait for X3. `db.captured:false` cannot satisfy
  the existing replay/golden database-evidence guard; it must not become `{}`.
- `${n.path}` references preserve prior successful values/types; missing, future
  and failed-step references are rejected. `expect:error` is metadata. Record
  actual business errors and distinguish timeouts/transport failures.
- WAVE0 normalization uses JSONPath and needs per-scenario A1/A2 raw differences,
  rationale, exact transformation and C2 review. Do not pass it to the legacy
  JSON-Pointer normalizer or collapse IDs, null/missing values, errors, event
  sequence, database rows/relations or SQLite storage classes.
- The CLI preserves `input.raw.json`; an importing X7 caller must preserve its own
  original input bytes because `runScenario` only saves parsed `scenario.json`.
  Keep A1/A2/B originals separately and `comparison:not-run` until actual comparison.

Next integration dependency is X1's normal-main publication plus the existing
Electron/Playwright/Xvfb and F2 preload artifact. No cross-worktree driver execution,
Electron/dist build or command C promotion was performed for this handoff.

### C2 queue and scope resolution (supersedes old snapshots)

C2's 15:10:56.046Z receipt confirms dedicated `rust` classification is active and
satisfies the build policy. X7 independently read status.json at
2026-11-05T15:25:35.262Z: limits `{typecheck:3,test:3,build:1,other:3,rust:1}`,
rust running 0. Use `CARGO_BUILD_JOBS=12`, jobs submission and the existing target;
do not clean. C2 confirms the historical 34-ID batch including
`regex.boundedOriginal`; the brief's 33 was an outdated count.

WP-012's actual delivery boundary is the partial report at 15:07:01.160Z,
tip `5c9b31088`. Queue repair does not retroactively make that build successful.
No cargo was invoked on receipt of this update. C1 should formally dispatch WP-043;
the ready brief `/tmp/opencode/C1-WP-043.md` is read, not treated as an assignment.
Its D-007 src-tauri build-configuration allowlist must be confirmed before editing
new paths. No business Rust edits are authorized by this resolution.

## 2026-11-06 G2 delivery and G3 full-run tooling

- D-156 (C1): the isolated identifier comes from the build-time `TAURI_CONFIG` merge patch; tauri-build 2.6.3
  (lib.rs:472-489, with `rerun-if-env-changed`) and tauri-codegen 2.6.3 (lib.rs:83-86) both apply it. The repository
  `tauri.conf.json` is unchanged. Build 20261106023719-bc16bc exit 0; the receipt stores the overlay and
  `tauri.effective.json`. Each A run checks that data exists only under `com.deepstudent.differential` in its run root.
- First A recording `get_app_version` A1=A2 (`fixtures/differential/a-runs/20261106-first-A/`). The job exit 1 there
  comes from the xvfb-run/dbus-run-session wrapper; the node launcher exits 0 (rerun 20261106024906-ae7a34).
- B runner = real Host process (`host/kernel/main.ts`, official desktop profile, HostSupervisor protocol). This is the
  B side for G2/G3 because the X1 Electron driver is not on main. It has no Electron main, so shell requests are
  answered with explicit errors and recorded per trace. None occurred in G2.
- Event scope: A can only observe events its webview subscribed to. The subscription set is contract events plus
  frontend `listen()`/`once()` literals (`chat_v2_event_{}` is missing from `contracts/ipc` but used by `src/`).
  Derived channels are recorded with step/field/pointer, and the comparator rebuilds them from B's ids. Events
  outside the common scope are listed, never counted as equal. A event payloads are the webview-evaluated JS value
  (Tauri emits through `eval`), so their numeric precision is bounded by JS numbers on that side.
- G2 (`fixtures/differential/g2/`, commit 95465e925): A/B outcome kinds equal on every step of all four scenarios.
  Compares are unequal without normalization. A1 vs A2 shows the same difference kinds, so ids and timestamps are
  nondeterministic in A itself. Structural DB findings for owners: `sync_state.db` outside the identifier dir,
  `chat_v2_compaction_memory_flushes` missing on B, `rag_documents`/`rag_document_chunks` extra on B.
- G3 full run: `g3-batch.mjs`, with workers isolated by `unshare -rn` (the devUrl port is compiled in). Coverage uses
  the LLVM online merge `%4m` into per-worker pools, because one 50 MB profraw per process does not fit the disk.
  Traces and compares are stored gzip, and sha256 covers the stored bytes.
- Corpus scan correction: 90 suites / 2275 scenarios. The earlier 2278 counted `input.raw.json` copies in run
  folders; the first version of the fix also dropped `wp043/get-app-version.v0.json` (ff273acd6 restores it).

## 2026-11-06 15:26Z resume: report integrity and residual differences

- Read the last 20 commits, status (clean at `e4892297d`) and LANE mapping. Ledger
  `20261106152615-758c5e` passed with no command/test problems or orphan registrations.
- C0's 08:38Z ownership split is preserved: no normalizer/comparator/batch changes,
  no recording start/stop, no owner corpus or production changes in this resume.
- Added `g3-manifest.mjs`: report-input seal over HEAD, full equivalence JSON content
  tree, rule/batch versions, A/A2/B unique compare trace references, and compare hashes.
  Report requires the seal and rechecks it after recomputation. Only the active compare
  directory is consumed; old compare archives and progress counters cannot enter the ledger.
  Missing seal/version drift is an error, not a silent all-zero or stale-pass report.
- A manifest produced now cannot certify the recording revision of historical B traces.
  It explicitly says so; coordinator receipts remain necessary for same-source attestation.
  No final manifest/report is published while the coordinator's driver is writing compares.
- Existing raw-evidence verification of A2, approvals hashes, and normalization lists is
  retained. Added rejection of stale normalizer hashes and approvals different from the
  sealed repository snapshot. Tests `20261106153724-5d5cbd`: 4 passed / 0 failed.
- Residual triage is generated from current compare artifacts, with stored-byte hashes and
  representative raw differences. `get_app_data_dir` slot/base semantics propagate to file
  arguments (F2); cloud unconfigured missing/null comes from serde skip_serializing_if vs
  explicit null (F4/L21); pdfstream's B shell request fails at the driver boundary (X7/F2).
  Separate proposals for unix inode/device and serialized JSON object-key order remain
  unapproved. No raw trace or comparison result is changed by triage.
