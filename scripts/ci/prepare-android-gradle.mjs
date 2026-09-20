#!/usr/bin/env node
// tauri-cli 2.11 runs target.build once to initialize plugins, then Gradle's
// BuildTask invokes android-studio-script and builds the same native lib again.
// Replace only that generated release task, keeping native ELF/JNI validation.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export const PREBUILT_GUARD = `
        // DS_CI_PREBUILT: only set by the managed tauri android build invocation.
        if (System.getenv("DS_ANDROID_PREBUILT_NATIVE") == "1") {
            if (target != "aarch64" || release != true) {
                throw GradleException("CI prebuilt native is restricted to aarch64 release")
            }
            val root = File(project.projectDir, rootDirRel ?: throw GradleException("missing Rust root")).canonicalFile
            val lib = File(root, "target/aarch64-linux-android/release/libdeep_student_lib.so")
            val jni = File(project.projectDir, "src/main/jniLibs/arm64-v8a/libdeep_student_lib.so")
            if (!lib.isFile || lib.length() == 0L || jni.canonicalFile != lib.canonicalFile) {
                throw GradleException("Tauri initial native build did not prepare the expected JNI library")
            }
            val ndk = System.getenv("NDK_HOME") ?: throw GradleException("missing NDK_HOME")
            fun inspect(tool: String, vararg arguments: String): String {
                val p = ProcessBuilder(listOf("$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/$tool") + arguments).redirectErrorStream(true).start()
                val output = p.inputStream.bufferedReader().readText()
                if (p.waitFor() != 0) throw GradleException("Native validation failed: $tool")
                return output
            }
            if (!inspect("llvm-readelf", "-h", lib.path).contains("AArch64") ||
                !inspect("llvm-nm", "-D", "--defined-only", lib.path).contains("Java_app_tauri_plugin_PluginManager_handlePluginResponse")) {
                throw GradleException("Invalid Android ABI or missing Tauri mobile entry point")
            }
            logger.lifecycle("Using validated native library from Tauri initial build; no second Rust compilation")
            return
        }
`;
export function patchBuildTask(source) {
  if (source.includes('// DS_CI_PREBUILT:')) return source;
  assert.equal(source.split('fun assemble() {').length, 2, 'unsupported generated BuildTask; inspect the new Tauri Gradle template');
  return source.replace('fun assemble() {', `fun assemble() {${PREBUILT_GUARD}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : entry.name === 'BuildTask.kt' ? [file] : [];
    });
  }
  const matches = walk('src-tauri/gen/android/buildSrc/src');
  assert.equal(matches.length, 1, 'expected exactly one generated BuildTask.kt');
  writeFileSync(matches[0], patchBuildTask(readFileSync(matches[0], 'utf8')));
}
