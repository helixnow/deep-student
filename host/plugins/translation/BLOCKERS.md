# Translation remaining owner dependencies and review work

- R1-TR-03: `vfs-repos/api.ts` re-exports `TranslationRepository`; `types/content.ts:484–507`
  already offers `createTranslationInFolder(conn,params,folderId)`, but no metadata persistence seam.
  Request L11 `updateTranslationMetadata(conn,id,metadata)` corresponding to
  `translation_executor.rs:1293–1311` (the previously requested
  `persistTranslationMetadataWithConn` is this same seam, not a request for a second implementation).
  L02's executor now delegates creation and metadata through per-call `vfsTranslations`; it no
  longer imports the local repository copy. That reserved file is unchanged pending U2 authorization.
  Creation/error mapping tests use real L11; metadata tests explicitly use a pending external-port
  fixture, so the full save TESTMAP row remains pending. L03's actual save caller still must supply
  the true owner/context after L11 publishes the metadata method; this is not end-to-end closure.
- R1-TR-04 command integration is now present in `69fbbb8ee`: registered `ocr_extract_text` calls
  F4 `util/api.ts::decodeBase64Standard`, the real file-OCR owner and F7 `resizeTriangleJpeg`.
  `20261104154626-f3d816` passed all five public-command vectors including actual large-image JPEG
  encode/decode. The previous missing-base64/unregistered/total-failure descriptions are superseded.
  D5/C pixel equivalence and target-platform verification remain separate review requirements.
  F3 still has no public FileManager path service; the concurrent production implementation contains
  the local fallback now recorded in llm/api.ts. Its ownership disposition remains with C1/F3; the
  command integration tests supply the explicit F3 absolute-path/root seam, not a second path algorithm.
- R1-TR-07: L07 `agentTools.registerToolExecutors/toolExecutors` is published, but stores the roster
  only (`AgentToolExecutorRegistry` has register/all, no dispatch). Rust's `ToolExecutorRegistry::
  from_vec/get_executor` public production dispatch equivalent is absent from L04 `chat/api.ts`.
  Request L04/L03's actual central dispatcher/registration-order surface; the local array `find`
  test cannot substitute for it. `registers_before_general_catch_all` restored to pending without
  deleting assertions. Actual TESTMAP is 40 ported/2 pending after the two OCR decoder rows moved
  to the registered-command tests; generated header awaits coordinator.
- R1-TR-01 source ambiguity: Rust translation/pipeline.rs:909 accepts raw `[DONE]` before adapter
  parsing, and :996 does not call adapter.finish_stream at EOF. Preserve that actual sequence;
  length+EOF is incomplete, length+DONE succeeds in the original translation caller despite the
  provider parser alone classifying DeepSeek's length termination as failure. See SPEC and command tests.
