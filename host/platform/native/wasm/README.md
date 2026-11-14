# F7 WASI engines (`f7-native-wasm`)

Prebuilt `wasm32-wasip1` module behind `nativeRegex`, `nativeStarlark`,
`nativeAudio`, `nativeImage`, `nativeOffice`, `nativeFsrs.optimize/evaluate` and `mindmapXml`.  It exists so the Host links the **same Rust crates** as the Tauri
backend instead of approximating them with JavaScript:

| Service | Crate | Rust source |
|---|---|---|
| `nativeRegex` | `regex 1.12.3` | `regex::Regex` directly |
| `nativeStarlark` | `starlark 0.14.2` | `src-tauri/crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs` (`run_ptc_script_with_limits` + `ptc_globals`) |
| `nativeAudio` | `symphonia 0.5.5` | `src-tauri/crates/dstu-media/src/media/decoder.rs`, `resample.rs` |
| `nativeImage` | `image 0.24.9` | `image::load_from_memory` + `to_rgba8()` call sites |
| `nativeFsrs` (optimize/evaluate) | `fsrs 6.6.2` | `src-tauri/crates/dstu-anki/src/fsrs_review_service.rs` `optimize_parameters` (`src/fsrs_engine.rs`) |
| `nativeRegex.replaceAllProjected` | `regex 1.12.3` | `src-tauri/src/chat_v2/tools/chatanki_transform.rs:466-594` (`bounded_regex_replace`, u64 counters) |
| `mindmapXml` | `roxmltree 0.20.0` | `src-tauri/src/chat_v2/tools/builtin_resource_executor.rs:3252,3437,3822,3944` (`Document::parse`, default options; `src/xml_engine.rs`) |
| `nativeOffice` | `docx-rs 0.4.19`, `calamine 0.26.1`, `pptx-to-md 0.2.0`, `rtf-parser 0.3.0`, `html2text 0.16.7` | `src-tauri/crates/dstu-docs/src/document_parser.rs` text extractors (`src/office_engine.rs`, source commit 4525e11ac) |

Copied sources keep a header comment with the source commit
(`6088949b99d44f46f5328fd7289d209b9a842b68`).  The only edits are the WASI
request/response plumbing and `log::*` → `eprintln!` (this build has no logger);
decode/resample arithmetic is unchanged.

fsrs rebuild (2026-11-05): only `fsrs = "=6.6.2"` was added; `portable-atomic` 1.13.1 and
`portable-atomic-util` 0.2.6 were pinned back to `src-tauri/Cargo.lock`.  The same build also
adds `image` op `encode` (`DynamicImage::write_to`, PNG / JPEG(q)), not yet wired to `nativeImage`,
and the structured DOCX / PPTX-metadata office ops.

Office build notes (2026-11-04 rebuild):

- Transitive versions were pinned to `src-tauri/Cargo.lock` where the semver range allows
  (`cargo update --precise`), e.g. zip 2.4.2, xml-rs 0.8.28, image 0.25.9, tendril 0.5.0.
- `pptx-to-md` is patched to `vendor/pptx-to-md` (identical source) only to build its `zip`
  dependency without the C-backed `bzip2`/`zstd`/`xz` codecs, which cannot be cross-compiled to
  wasm32-wasip1 without a WASI C toolchain.  Office writers emit stored/deflate entries; an entry
  compressed with bzip2/zstd/xz reports a zip `UnsupportedArchive` error here instead of decoding.
- pptx-to-md's `image` dependency turns on image's default features (incl. `jpeg_rayon`) through
  feature unification; rayon falls back to the current thread on wasm32-wasip1.

## Prebuilt artifact

`f7-native-wasm.wasm` is checked in as a binary and is **not rebuilt in this
repository**: its Rust sources, `Cargo.toml` / `Cargo.lock` and build script were
removed together with the rest of the Rust tree and remain only in git history
(last present at commit `f2754050c`) and in the Rust edition repository.  The
`Rust source` column and the build notes above are provenance for that binary.
It was produced by rustc 1.98.1 (`toolchain.txt`); the sha256 is in
`f7-native-wasm.wasm.sha256`.  The third-party crates compiled into it, with
their license texts, are recorded in `legal/f7-native-wasm-components.json`.

Changing engine behavior therefore means either replacing an engine with a
JS/TS implementation behind the same service, or rebuilding the module outside
this repository and updating the binary, its sha256 and the component record.

## Protocol

`node:wasi` runs the module as a command:

```
f7-native-wasm /out/request.json /out/response.json
```

The Host preopens an ephemeral directory as `/out`; audio additionally preopens
the media file's directory read-only as `/media`.  Requests/responses are JSON,
so PCM and large results never travel through stdout.

- `regex`: one request → `compile`/`is_match`/`find_iter`/`captures`/
  `replace`/`replace_all`/`split`.  Errors are `regex::Error`'s `Display`.
- `audio`: `probe` or `decode`; PCM is written as 16-bit little-endian mono
  16 kHz to `/out/pcm.bin` and progress fractions to `/out/progress.json`.
- `xml`: `parse`; returns `doc.root_element()` as a flat pre-order node list with parent indices, or
  `roxmltree::Error`'s `Display`.  Run on the calling thread by `runWasmSync` (the `mindmapXml` contract is
  synchronous).
- `image`: `dimensions` or `decode_rgba`; the input bytes and RGBA payload are
  files under `/out`, so large images stay out of the JSON response.
- `starlark`: the evaluator runs until a host function (`call`, `object_read`,
  `object_write`) is reached, writes a `host_call` response and aborts.  The
  Host performs the call, appends the answer to `replay`, and starts the script
  again.  Starlark has no clock/random/IO globals here, so the prefix is
  deterministic and each host call executes exactly once on the Node side.

The synchronous `_start` cannot be interrupted mid-flight; `AbortSignal` and
deadlines are observed at replay boundaries (Starlark) or before/after decode
(audio).  See `migration/spec/F7-native.md` for the exact limitation.

## Loaders

| File | Platform | Source of the `.wasm` | WASI |
|---|---|---|---|
| `core.ts` | any | `compileWasm(Uint8Array \| ArrayBuffer \| Response \| Promise<Response>)`; streaming compile for `application/wasm` | protocol constants, log sink, `WasmCancelledError` |
| `loader.ts` | desktop | `readFile` next to this file | `node:wasi` in a `worker_threads` Worker (`runWasm`, cancellable) or on the caller (`runWasmSync`) |
| `wasi.ts` + `engine.ts` | any | a compiled module | `MemoryWasi`: in-memory preview1 with exactly the 17 imports this module declares; `/out` and read-only `/media` are `MemoryDirectory` maps |
| `web.ts` | mobile / Web | `fetch(new URL('./f7-native-wasm.wasm', import.meta.url))` (bundler asset) or an explicit URL | `engine.ts` |

The in-memory engine runs `_start` on the calling thread, so a request can only
be cancelled before it starts; mobile hosts run it inside a Web Worker. Portable
service entries built on it: `fsrs/web.ts`, `tokenizer/web.ts` (`tiktoken/init`
with a caller-supplied `.wasm`) and `argon2/web.ts` (`@noble/hashes`, same bytes
as `@node-rs/argon2`). `tests/wasm-portable.test.ts` (jsdom) and
`scripts/portability/browser-wasm-smoke.mjs` (headless Chromium) pin them to the
desktop goldens.
