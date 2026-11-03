# Task7 backend executor — six tools wired to shared services

Repo /home/xutao/deepstudent/deep-student featurebranch. Scope new `src-tauri/src/chat_v2/tools/ink_executor.rs`, tools/mod.rs export, agent_wiring/roster.rs add InkToolExecutor and expectedroster/testoracle, dstu-agent/tool_descriptors.rs 6baretoolentries and metadata tests, ownreport. DoNOTeditpipeline/history/core/repo/inkrepo/bridge/frontendSchema. Readonlyneededtypes/files, notentireChat.

## First small gate

FIRST tests+minimal executor scaffold can_handlexact6names / executesstructuredunimplementedToolResultInfo failure. Two real migratedVFS+windowlessExecutionContext success tests: ink_create thenink_get returnsrealmanifest andboundlimit summary; cancellationbeforecreate nofile. ExistingserviceAPIscreate/get/get_page/append/rename currentlyin vfs/ink_commands.rs; coreVfsInkRepo create/get/save/copy passed10tests. Mainrunsred. NO tests/build/install/agents/commit. DoNOTregisterplaceholderexecutoruntil mainRED? registerrequiredcompileonlythenfeaturetoolunimplementedfailhonest okay butmainchecksrosteraftergreen. No successfulresponsesforunsupportedbranches.

## Execution interfaces

Namesbuiltin-ink_prepare/create/get/render/apply_ops/export; barealiasacceptedonlyownprefix, noMCPsubstring. ToolExecutor normal failures Ok(ToolResultInfo successfalse output{code/message/hint/retryable/current_revision?}), exceptionErronlyinternalpanic. ctx.emit_tool_call_start/end/error andcrashsafe blockpersist samepatternsotherexecutor.

create inputtitle/operation_id/folder_id/page_size/ruling; defaultA4 logical794x1123. Clientoperation_id rebinding perctx.session_id/toolcall hashing forunforgeableid, inputhashserver. Readmanifest summariesnotrawpointarrays; getoptionalpage_id returnsboundedobjects(e.g100) withstroke samplecountnotpoints, noJSONcontentsasOCR. Readoperationreceiptstatusfromlast_operationwithunknownfailureexplicit.

render uses app `crate::ink_bridge::render_ink_snapshot` forthcoming; backendmustawait trustedmainWebView andpublishimmutableartifact thenpersisttyped ref totoolblockvia`ctx.save_tool_block`/dedicatedrepo API (MessageBlock.ink_artifacts), ctx.session_id/toolcallid authoritative, fullroundanchoraddedpipeline. IfbridgeunavailableRENDER_UNAVAILABLE; nonvisionVISION_MODEL_REQUIRED. APIcannotreturnPNGdataURLtextandpretendalreadysent.

apply_ops inputdoc/rev/op/ops<=100 parsedcontrollednormalizedgeometry; don'tallowcallerobjectIDs/author/timestamp. GenerateownIDsnow; storageatomicapply_sharedserviceforthcoming. Mustflushdirtyeditorviaink_bridge::flush_ink_editor beforewriteread; noflush→EDITOR_BUSY. Alllocationsboundbased_on_render_id validatedagainstartifactrepo provenance+currentmanifest/sourcehighlights. Actualsensitivity_level_for_call uses `approval_scope::requires_destructive_ink_confirmation` (pub(crate)agentvisibilitymeanslocalclassificationpredicate orpublicwrapper needednothack; executorcanreturnHighifanyupdate/remove). BaseapplyMedium; dynamicflagtrue. GatealreadytestedFullAccess/Plan/newpredicateHigh forced. Approvalnotinexecutorparallelmanager. Aftercommitcancelreturnscommitted, nofalsecancelrollback, manages_cancellationtrueandboundeddrain.

prepare routeappbridge localconverter+VfsInkPrepareRepo forthcoming; export routeappglobalrenderer+pdfmakePNG/PDF producedfile nooverwrite. Interfaces maybestubuntildependenciesfinishbutFINALmustnoNotImplemented. Reportexactmissingsymbolforcoordinatordecidewithoutbroadguess. FirstsliceONLYcreate/get tests/scaffold avoiddependingmissingbridgefunctions.

Descriptors: prepare/create/apply/export Medium WriteLocal read_onlyfalse; getLowRead true; renderLowWriteLocal read_onlyfalse(immutableartifactpersist), defaulttimeout120 or conversion180, headless/PTCfalsefirst (don'tletparallelPTCwritebypass). syncEXPECTED_ROSTERdescriptor testsproductionregistration. ResultUIstructureddata includesdocument_id/revision/affected_page_ids/artifacts/status/operation_id, cardslaterreuseopenresource.

No tooloriginalnotesoverwrites, no externalmodel/network calls. Report tasks/task-7-executor-report.md withselectors/registration/APIcontracts. Deliverinitialsuccessredtestwithin20calls.
