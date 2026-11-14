/**
 * Electron 三平台打包配置（electron-builder 26）。macOS 默认 ad-hoc 签名，设置 `CSC_LINK` / `CSC_NAME` 时正式签名
 * 并公证（scripts/app-hardening.cjs `macSigning`）；Windows、Linux 不签名。
 *
 * 应用配置 `resources/app/tauri.conf.json` 的 `bundle`：产品名、标识、图标、许可文件；图标由
 * `electron/scripts/generate-icons.mjs` 从 `public/app-icon.png` 生成并入库（Tauri 的 `src-tauri/icons/` 从未入库）；
 * `resources/app/migrations/**` 必须逐字节随包发布（refinery checksum 依赖原文），
 * 由 `electron/main.ts` 解析为 `DS_MIGRATIONS_DIR` 交给 Host 的存储服务。
 *
 * 使用 `node electron/scripts/package.mjs --mac|--win|--linux [--dir]`；不要直接 `electron-builder`
 * 而跳过 preload 与 version 资源检查。
 */
const { productionFileSets } = require('./scripts/node-modules-closure.cjs');
const { fuseConfig, macSigning } = require('./scripts/app-hardening.cjs');
const macMain = require('./scripts/mac-main-stub.cjs');

if (process.env.APPLE_PASSWORD && !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
  process.env.APPLE_APP_SPECIFIC_PASSWORD = process.env.APPLE_PASSWORD;
}

const projectDir = require('node:path').resolve(__dirname, '..');
const signing = macSigning(process.env, projectDir);
const targetArch = process.env.DS_TARGET_ARCH || process.arch;
const releaseArch = targetArch === 'arm64' ? 'aarch64' : targetArch === 'x64' ? 'x86_64' : targetArch;
/** 目标平台的生产依赖（支持经 `DS_TARGET_ARCH` 指定 `arm64`/`x64`；跨架构打包需要该架构的平台包已安装）。 */
const nodeModules = (platform) => productionFileSets(projectDir, { platform, arch: targetArch });

module.exports = {
  appId: 'com.deepstudent.app',
  productName: 'Deep Student',
  copyright: 'Copyright © Deep Student',
  directories: {
    // 本机验收可放在外置盘，避免占满系统盘；默认发布路径不变。
    output: process.env.DS_ELECTRON_PACKAGE_OUTPUT || 'release',
    buildResources: 'electron/build',
  },
  // .ts 由 Node 24 类型剥离直接运行，Host（utilityProcess.fork）、worker_threads 入口与 .wasm 都从 app.asar 内加载；
  // 只有 dlopen 的原生二进制必须解包（sharp 的 libvips 在 macOS 是 .dylib、Linux 是 .so.42）。
  asar: true,
  // RUST-FIX(RF-P3-workshop-compiler): esbuild's native executable must not spawn inside asar.
  asarUnpack: ['**/*.{node,dylib,so,dll,exe}', '**/*.so.*', '**/node_modules/@esbuild/*/bin/*'],
  // 不用 `electronFuses`：期望值因平台而异（EnableCookieEncryption），在 afterPack 中翻转。
  extraMetadata: {
    main: 'electron/main.ts',
  },
  // 依赖已在工作区安装；打包不允许重新编译原生模块或联网拉取依赖。beforeBuild 解析为 false 表示 node_modules
  // 由外部处理：electron-builder 跳过重编译，也不再用 `npm ls` 收集依赖（软链的 node_modules 让它漏掉传递依赖与
  // 平台原生包）；依赖改由各平台 `files` 中的闭包 FileSet 提供（scripts/node-modules-closure.cjs）。
  // npmRebuild 必须为 true，beforeBuild 才会被调用。
  npmRebuild: true,
  beforeBuild: async () => false,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,
  publish: null,
  files: [
    'package.json',
    'electron/**/*',
    'electron/.build/**/*',
    '!electron/**/{tests,__tests__,__fixtures__,equivalence}/**',
    '!electron/scripts/**',
    '!electron/native/**',
    '!electron/signing/**',
    '!electron/resources/icons/**',
    // Linux 窗口图标由 main 在运行时设置（shell/window-options.ts `defaultWindowIcon`）。
    'electron/resources/icons/png/32x32.png',
    '!electron/electron-builder.config.cjs',
    '!electron/**/*.test.ts',
    '!electron/**/*.md',
    // Host 运行时只读这些目录之外的文件（profiles、contracts、wasm、anki/data、media/assets 等，见 packaging.test.ts）。
    'host/**/*',
    '!host/**/{tests,__tests__,__fixtures__,fixtures,equivalence}/**',
    '!host/{e2e,testing}/**',
    '!host/**/*.test.ts',
    '!host/**/*.md',
    '!host/platform/native/wp280/**',
    '!host/platform/native/wasm/toolchain.txt',
    // f7-sqlite-busy 只供等价性测试（生产用 busy_timeout）；index.ts 被 dstu.native 静态导入，照常随包。
    '!host/platform/native/sqlite-busy/{prebuilds,prebuilds/**,busy_handler.c,build.sh}',
    'dist/**/*',
    'contracts/ipc/**/*',
    'contracts/plugin-manifest/*.schema.json',
    'resources/dstu-workshop/**/*',
    // Read-only SDK discovery resources, not executed by the renderer.
    'src/ui-sdk/index.ts',
    'src/ui-kernel/contracts/*.ts',
    'src/styles/shadcn-variables.css',
    'resources/app/tauri.conf.json',
    'resources/app/tauri.*.conf.json',
    'resources/app/capabilities/**/*',
    'resources/app/permissions/**/*',
    'LICENSE',
    'legal/**/*',
    '!**/*.map',
  ],
  /**
   * electron-builder 只在解压下载的 Electron 时删 `default_app.asar`；用本机 electronDist（package.mjs）时它会随包
   * 发布并进入 asar 完整性清单。在复制应用文件、计算完整性之前删除。
   */
  afterExtract: async (context) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const resourceDirs = context.electronPlatformName === 'darwin'
      ? fs.readdirSync(context.appOutDir).filter((name) => name.endsWith('.app')).map((name) => path.join(context.appOutDir, name, 'Contents', 'Resources'))
      : [path.join(context.appOutDir, 'resources')];
    for (const dir of resourceDirs) fs.rmSync(path.join(dir, 'default_app.asar'), { force: true });
  },
  /**
   * 逐字节复制 migrations：electron-builder 的 extraResources glob 默认跳过 `.gitkeep` 等点文件，
   * 打包后用 fs.cpSync 覆盖为目标目录的精确副本（文件集、大小、内容一致）。
   * 然后按平台翻转 fuses（scripts/app-hardening.cjs）：afterPack 之后 electron-builder 只做只读检查与签名。
   */
  afterPack: async (context) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const resourcesDir = context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
    const target = path.join(resourcesDir, 'migrations');
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(context.packager.projectDir, 'resources/app', 'migrations'), target, { recursive: true });
    await context.packager.addElectronFuses(context, fuseConfig(context.electronPlatformName, { signed: signing.signed }));
    macMain.installMacMainEntry(context);
    if (context.electronPlatformName === 'darwin') {
      const arch = context.arch === require('builder-util').Arch.arm64 ? 'arm64' : 'x86_64';
      require('./scripts/build-system-ocr.cjs')(
        path.join(resourcesDir, '..', 'MacOS', 'dstu-system-ocr'), arch);
    }
  },
  extraResources: [
    // 逐字节复制：electron-builder 使用 fs 复制，不做文本转码。
    { from: 'resources/app/migrations', to: 'migrations' },
    { from: 'LICENSE', to: 'licenses/DeepStudent-AGPL-3.0.txt' },
    { from: 'legal/THIRD_PARTY_NOTICES.txt', to: 'licenses/THIRD_PARTY_NOTICES.txt' },
  ],
  mac: {
    target: ['dmg', 'zip'],
    ...signing.mac,
    gatekeeperAssess: false,
    // resources/app/Info.plist；Electron 自带的是通用文案。
    extendInfo: {
      NSMicrophoneUsageDescription: 'Deep Student uses the microphone to record voice input before transcribing it into your current text field.',
    },
    icon: 'electron/resources/icons/icon.icns',
    files: nodeModules('darwin'),
    category: 'public.app-category.education',
  },
  dmg: {
    sign: false,
    artifactName: `Deep.Student_${'${version}'}_${releaseArch}.${'${ext}'}`,
  },
  win: {
    target: ['nsis', 'zip'],
    icon: 'electron/resources/icons/icon.ico',
    files: nodeModules('win32'),
    // 只关签名：exe 的图标与版本信息仍由 electron-builder 用 resedit（纯 JS）写入；asar 完整性资源照常写进 exe
    // （scripts/win-asar-integrity.mjs，verify-fuses --win 校验）。
    signExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'Deep.Student_${version}_${arch}-setup.${ext}',
    // Tauri → Electron 迁移：/UPDATE 静默升级、结束并卸载旧版 deep-student.exe，安装后重启。
    include: 'electron/build/installer.nsh',
  },
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'electron/resources/icons/png',
    files: nodeModules('linux'),
    category: 'Education',
    maintainer: 'Deep Student <support@deepstudent.cn>',
    synopsis: '开源、本地优先的 AI 学习工作台',
  },
  appImage: {
    artifactName: `Deep.Student_${'${version}'}_${releaseArch}.${'${ext}'}`,
  },
  deb: {
    artifactName: 'Deep.Student_${version}_${arch}.${ext}',
  },
};
