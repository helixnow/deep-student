/**
 * Windows 主程序里的 asar 完整性清单（SEC-E08）。
 *
 * electron-builder 在 `ElectronFramework.beforeCopyExtraFiles` 中用 resedit 往 exe 写入资源 `INTEGRITY/ELECTRONASAR`
 * （`app-builder-lib/out/electron/electronWin.js` `addWinAsarIntegrity`），内容是
 * `[{ file: "resources\\app.asar", alg: "SHA256", value: <asar 头部 SHA256> }]`；与 `signAndEditExecutable` 无关
 * （后者只管签名和 rcedit 改版本信息 / 图标）。EnableEmbeddedAsarIntegrityValidation 打开时 Electron 启动即按它校验。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NtExecutable, NtExecutableResource } = require('resedit');

/** exe 内容 → 完整性清单；没有该资源时返回 null。 */
export function readWinAsarIntegrity(executable) {
  const resources = NtExecutableResource.from(NtExecutable.from(executable)).entries
    .filter((entry) => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
  if (resources.length === 0) return null;
  if (resources.length > 1) throw new Error(`${resources.length} INTEGRITY/ELECTRONASAR resources`);
  return JSON.parse(Buffer.from(resources[0].bin).toString('utf8'));
}
