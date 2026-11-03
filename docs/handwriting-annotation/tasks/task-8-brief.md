# Task8 — Typed Ink visual references in live and replay

Repo /home/xutao/deepstudent/deep-student featurebranch. Read first reviews/chat-integration-findings.md then this exact scope. Other agents own VFSartifactrepo/bridge/editor/inkoperations/sync; do not modifythose. Allowed dstu-core/src/agent.rs minimaltypedref, dstu-agent/src/chat_v2/{context.rs,repo.rs,tools/executor.rs,pipeline/context_compiler/ink_artifacts.rs,pipeline/context_compiler/retrieval_images.rs,pipeline/history.rs,pipeline/tool_loop.rs,pipeline/multi_variant.rs} andChatV2migrationregistry/minimalmigration, frontendchatblock/restoretypes onlynecessary. Ownreport. No UItools/executor/schema modifications.

## Gate first

Smallverticaltestfirst: typedrefpersist/load throughrealChatV2DB andhistoryfulltoolround restoresactualimagepart fromlocalPNG. Minimalnewresolverstub returnsnodata/structuredfail soexpectedpositiveRED. Mainruns. NO tests/build/install/agents/commits. Initialbatch only3tests+scaffold, no fullsystemrewrites. Report tasks/task-8-report.md. Do not askdesignapprovalagain; planexplicitlyapproved.

## Contract

`InkVisualArtifactRef` camelCase matchingcore type style, serde deny_unknown_fields: artifact_id, render_id, session_id, tool_call_id, round_last_tool_call_id, document_id,page_id,revision,blob_hash,resource_id,content_hash,mime_type,width_px,height_px. Source/cropetc read immutableVFSartifactrow later, referencescannotspoofthat. VFSartifactrepo newrow`ink_render_artifacts` keyedrender_id, globalimmutableprovenance storesPNGblob/hash/doc/page/revision. PNGactualrealsha256, files.sha256neverfake. QuerythroughVFSservice (existing Services caninclude repo or VFS access same asretrievalimages); resolveronlyreads validatedlocalartifactandmatchrefmetadata. Session/callbindingmustmatchparenttoolblock/session, tool_nameonlytrustedbuiltin-ink_render/ink_render (notmcpname substring). No arbitraryURL or JSONtooloutput parsing.

Adddefault-emptytyped `ink_artifacts` ToolResultInfo/MessageBlock, nullable dedicatedchatblockcolumn ink_artifacts_json, allconstructors/literals update scopedonly mechanically required. Normalandcrashsafetoolpersist/restore cover. `strip_payload_backed_by_block` mustnotloserefs. FrontendBlock.inkArtifacts read-onlyoptional. No base64inDB/tooloutput/log.

Materialize onlyduringLLMrequest. Render PNG localvalidatedbytes→`MultimodalContentPart::ImageUrl` userimageaftercompleteassistanttoolcall+ALLtoolresults inround; neverbetweenparalleltools. Persistedanchor lasttoolcallID (setbytoolloopafterroundknown) validatesfullround. Liveandhistory/multivariant shareone resolverandplacementrules. Missing/mismatchIMAGE_DELIVERY_FAILED, nonvisionVISION_MODEL_REQUIRED. Toolsuccessmustnotimplyviewedbeforeimageactuallyinserted.

Budgetsharedwithretrieval: max4toolimages perturn includingalreadycompiledimagebudget subtraction; single4MiB,total16MiBhard cap, longedge2048; dedupbyartifact+revision/content. Existingretrievalperimagecap/countnotcumulative, addsharedusedbytes ifneeded. Historyturnimages mayconsume slots; don'tincreaseglobalbeyondproviderbudget. Anyinjectionfailneedsstructuredfailedtoolresultor requesterror, notsilentdropink.

Tests offline realproviderHTTPcapture aftercorepersist/replaytests pass: actualOpenAI/Responses/Anthropic imagepart andorder; localfixture nofee/modelnetwork. existing compaction localHTTPcapturehelper patterns, nevercallrealmodel. ForgedMCP/URL/session/call/id/hashmismatch rejected; duplicatebudgetmixretrieval; history/multivariantimagebytesstableafterdocumentmutates. Check selectedtestcountnonzero.

Migrationclassification: ChatV2blockfieldnotnewtable, existingrowsdefaultempty, fixtureupgradetests. No dependencies/newORM. Don'tmodifygenerictoolroleadapterunnecessarily; legalfollowinguserimagemessage alreadyworksacrossproviders. NeedrealrequestbodytestnotjustimageURLstringinJSON.
