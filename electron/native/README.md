# macOS main entry — Electron 45.2.1 only

`mac-main-45.2.1.cc` preserves the non-HELPER entry duties of upstream
`shell/app/electron_main_mac.cc` and `shell/app/uv_stdio_fix.cc`: repair closed
stdio, honor the framework RunAsNode fuse, and pass argc/argv to ElectronMain.
Helpers keep their original entry and Seatbelt/--type checks.

When the framework's nodeOptions fuse is disabled, this main removes inherited
NODE_COMPILE_CACHE and NODE_COMPILE_CACHE_PORTABLE before Node initializes.
It does not set NODE_DISABLE_COMPILE_CACHE: the Host still receives its trusted
userData cache directory. The native deletion audit is emitted on stdout with a
fixed marker, exact removed-name list and actual PID; JS separately logs only
the variables it deletes. This is not an upstream promise of that fuse.

`scripts/mac-main-stub.cjs` is called from afterPack, after framework fuses and
before signing. It reads the target main architecture/minOS and compiles only
arm64 or x86_64, linking the same-bundle framework via the original rpath. It
replaces main without leaving an old executable. Sources stay out of app.asar;
the upstream MIT license is installed under Resources/licenses.

Do not silently bump the version guard: review those two pinned upstream files,
framework exports (ElectronMain, ElectronInitializeICUandStartNode and the two
fuse functions), and signing behavior first. There is no universal2 fallback or
wrapper/relaunch chain. The hook requires the macOS compiler/SDK; it never
rebuilds Electron or modifies node_modules.

Actual acceptance: macOS arm64, ad-hoc hardened runtime only. x64 argument mapping
is unit-tested, not a tested x64 package. Developer ID/notarization, universal2,
upgrade/relaunch workflows and other OS releases remain outside this acceptance.
Windows/Linux still need their own pre-Node solution. See
`../native-stub-delivery.md` for evidence and exact boundaries.
