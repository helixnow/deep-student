# W37 resource-type migration scope (audit B3)

Baseline: `e73e0d98`. Behaviour restoration: B1 `c0150439`, B2 `f2c938c3`.
The lane report is `.reports/lanes/plugin-closeout/W37.md` in the orchestration checkout.

## Counts

- Semantic resource/source-type switches: **19 → 0** (14 baseline files, 110 matching case labels).
- The original regex scanner: **20 → 1**. It also counts `chat/context/definitions/selection.ts:24`,
  whose selection-source discriminator is not a resource type. Exclude it on both sides.
- The assignment's “26 files / 132 sites” mixes different counting scopes. The 26 map-run files
  and the sum of case labels plus switch sites do not establish a migration count of 132.
- Entry-file line reduction is controller extraction, not an equivalent reduction of total code or complexity.

## Slot status

**已声明槽位、尚未有产品消费。** The Learning Hub plugin declares `resource.types` and contributes
eight official definitions. `react.ts` provides slot-aware hooks but has no product caller.
Product consumers use static official lookups or local mappings. Plugin-provided types/operations
do not yet drive their menus or rendering. Do not equate switch-to-table conversion with dynamic slot consumption.

## Intentionally retained boundaries (audit §3.3)

- Learning Hub: controller settings events; UnifiedAppPanel image/file compatibility and mindmap props;
  FinderFileItem note/essay behaviours; quickLookPreview; previewPersistence; VFS MIME/attachment classification;
  importActions first-node opening; extension-based preview in types.ts; reference mindmap→file/image handling;
  IndexStatusView display, processing and OCR conditions.
- W18: TabBar and DesktopView special cases and their tables are outside this lane.
- Workbench: FilePreviewAppWindow labels; previewShellUtils MIME/extensions; content/register action validation
  and seekMedia; createContentApp configuration; ResourceAppWorkspace state/actions; agentManifests grouping.
  NotesWorkspaceApp, FavoritesSection, NotesSearchOverlay and NotesTrashDialog remain Notes-domain behaviour.
- Local tables remain in CommandPalette, dstu editorRegistry/types/folder/path, chat icons/context registration/
  toolDisplayName, UnifiedAppPanel, FinderFileItem/FinderQuickLook/shortcutIcons/ResourceIcons,
  learningHubContracts, SidebarContentArea/SidebarContextMenu/contextMenuHandlers, reference MIME,
  searchHonesty/IndexStatusView, AgentControlCenter/DesktopShortcuts/WorkbenchAppIcon/appIcons.
  They implement icons, registration, creation, search or i18n; this lane does not claim all type branches vanished.

## Behaviour evidence

`consumer-functions.json` records 29 actual consumer declarations/callbacks across 30 inputs, executed from
the original Git blobs with the AST harness. The current declarations must match every recorded result/action.
Component/service boundaries are symbolic: this is function-level evidence, not full UI or backend execution.
The operation booleans in the earlier matrix are declaration data, not evidence of invoking nine old operations.

The two legacy preview/source mappings and the pre-existing identity/injection/MIME mappings keep their old
inherited-key semantics. These changes were withdrawn to maintain zero difference. Any correction of those
old behaviours requires a separate orchestration decision; newly converted switches use own-key checks.

Verification through `bin/heavy`: seven targeted test files / 17 tests passed (including consumer golden,
official-slots and fullstack-pairing); TypeScript and all four gates passed, with 18 slot-snapshot tests.
