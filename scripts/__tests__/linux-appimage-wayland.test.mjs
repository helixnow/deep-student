import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const script = read('../ci/patch-appimage-wayland.sh');
const installDeps = read('../ci/install-linux-deps.sh');
const workflow = read('../../.github/workflows/reusable-build-linux.yml');

test('AppImage patch unbundles every libwayland-* and verifies the repack', () => {
  // Both the removal pass and the post-repack check must run over the whole
  // AppDir: a linuxdeploy layout change must not make the fix silently miss.
  assert.equal(
    (script.match(/find "\$(?:appdir|repacked)" [^|]*libwayland-\*\.so\*/g) ?? []).length,
    2,
  );
  for (const line of script
    .split('\n')
    .filter((line) => line.includes('find "') && line.includes('libwayland-*.so*'))) {
    // Symlinks count: removing only regular files could leave a SONAME link
    // behind, which the loader would still resolve.
    assert.match(line, /-type f -o -type l/);
  }
  assert.match(script, /survived the repack/);
});

test('AppImage patch keeps the original runtime and squashfs shape', () => {
  // Repacking must reuse the AppImage runtime bytes and the original squashfs
  // compression/block size instead of downloading appimagetool.
  assert.match(script, /--appimage-offset/);
  assert.match(script, /unsquashfs -o "\$offset" -s/);
  assert.match(script, /head -c "\$offset" /);
  assert.match(script, /mkfs-time 0/);
  assert.match(script, /-comp "\$comp" -b "\$block"/);
  assert.match(script, /--appimage-extract/);
  // squashfs-tools is the only new build dependency; declare it in the shared
  // Linux dependency manifest so hotfix/rebuild builds get it too.
  assert.match(installDeps, /squashfs-tools/);
});

test('release workflow patches the AppImage after bundling and re-signs it', () => {
  const bundle = workflow.indexOf(
    'native-build.mjs bundle x86_64-unknown-linux-gnu deb,rpm,appimage',
  );
  const patch = workflow.indexOf('patch-appimage-wayland.sh');
  const sign = workflow.indexOf('tauri signer sign');
  assert.ok(bundle >= 0, 'AppImage bundling step is missing');
  assert.ok(patch > bundle, 'AppImage patch must run after bundling');
  assert.ok(sign > patch, 'updater signature must be recreated after patching');
  // The signature tauri produced during bundling no longer matches the patched
  // bytes, so the stale .sig has to be removed before signing.
  const removeSig = workflow.indexOf('rm -f "$image.sig"');
  assert.ok(removeSig > bundle && removeSig < sign);
  // Signing needs the updater key, which is injected as step env.
  const stepStart = workflow.lastIndexOf('- name: Unbundle bundled wayland libraries', patch);
  assert.ok(stepStart >= 0, 'AppImage patch step is missing');
  const stepEnd = workflow.indexOf('- name: Show sccache stats', stepStart);
  assert.ok(stepEnd > stepStart, 'patch step boundary not found');
  assert.match(workflow.slice(stepStart, stepEnd), /TAURI_SIGNING_PRIVATE_KEY/);
  // publish only length-checks the signature; catch corrupt base64 here.
  assert.match(workflow.slice(stepStart, stepEnd), /base64 -d/);
});

test('final uploaded AppImage is independently gated against bundled wayland libs', () => {
  // The patch script verifies the intermediate bundler output; the upload gate
  // must re-extract the renamed artifact that actually ships.
  const gate = workflow.indexOf('Verify final AppImage keeps wayland libraries unbundled');
  assert.ok(gate >= 0, 'final AppImage gate is missing');
  const rename = workflow.indexOf('Rename updater artifacts with arch suffix');
  assert.ok(rename >= 0 && gate > rename, 'final gate must run on renamed artifacts');
  assert.match(workflow.slice(gate), /libwayland-\*\.so\*/);
  // A v1Compatible updater archive would bypass the patched raw AppImage.
  assert.match(workflow.slice(gate), /v1Compatible/);
});
