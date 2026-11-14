import { definePlugin } from '../../kernel/api.ts';
import { audio } from './audio/index.ts';
import { argon2 } from './argon2/index.ts';
import { compression } from './compression/index.ts';
import { fsrs } from './fsrs/index.ts';
import { heic } from './heic/index.ts';
import { image } from './image/index.ts';
import { office } from './office/extract.ts';
import { officeText } from './office/text.ts';
import { createOfficeWriter } from './office/writer.ts';
import { pdfium, setPdfiumLogSink } from './pdfium/index.ts';
import { protobuf } from './protobuf/index.ts';
import { regex } from './regex/index.ts';
import { starlark } from './starlark/index.ts';
import { tokenizer } from './tokenizer/index.ts';
import { sandbox } from './sandbox/index.ts';
import { windowsFiles } from './windows/files.ts';
import { windowsSandbox } from './windows/sandbox.ts';
import { setWasmLogSink } from './wasm/loader.ts';
import { mindmapXml } from './xml/index.ts';
import { sqliteBusy } from './sqlite-busy/index.ts';
export default definePlugin({
  meta: {
    id: 'dstu.native', lane: 'F7-native', commands: [],
    provides: [
      'nativeCompression', 'nativeHeic', 'nativeImage', 'nativeOffice', 'nativeOfficeText',
      'nativeProtobuf', 'nativeTokenizer', 'nativePdfium', 'nativeFsrs',
      'nativeRegex', 'nativeStarlark', 'nativeAudio',
      'nativeOfficeWriter',
      'nativeSandbox',
      'nativeWindowsFiles',
      'nativeWindowsSandbox',
      'nativeArgon2',
      'mindmapXml',
      'nativeSqliteBusy',
    ],
  },
  apply(ctx) {
    // Rust `log::warn!` sites in the copied decoder/ptc_runtime code write to
    // wasm stderr; route them to the same logger targets as the Tauri build.
    const mediaLog = ctx.logger('dstu_media::media::decoder');
    const ptcLog = ctx.logger('dstu_agent::chat_v2::tools::ptc_runtime');
    setWasmLogSink((line) => {
      (line.startsWith('[PtcRuntime]') ? ptcLog : mediaLog).warn(line);
    });
    setPdfiumLogSink((line) => ctx.logger('dstu_docs::pdfium_utils').debug(line));
    ctx.provide('nativeCompression', compression);
    ctx.provide('nativeHeic', heic);
    ctx.provide('nativeImage', image);
    ctx.provide('nativeOffice', office);
    ctx.provide('nativeOfficeText', officeText);
    ctx.provide('nativeOfficeWriter', createOfficeWriter(message => ctx.logger('dstu_docs::document_parser').warn(message)));
    ctx.provide('nativeProtobuf', protobuf);
    ctx.provide('nativeTokenizer', tokenizer);
    ctx.provide('nativePdfium', pdfium);
    ctx.provide('nativeFsrs', fsrs);
    ctx.provide('nativeRegex', regex);
    ctx.provide('nativeStarlark', starlark);
    ctx.provide('nativeAudio', audio);
    ctx.provide('nativeSandbox', sandbox);
    ctx.effect(() => () => sandbox.dispose());
    ctx.provide('nativeWindowsFiles', windowsFiles);
    ctx.provide('nativeWindowsSandbox', windowsSandbox);
    ctx.provide('nativeArgon2', argon2);
    ctx.provide('mindmapXml', mindmapXml);
    ctx.provide('nativeSqliteBusy', sqliteBusy);
  },
});
