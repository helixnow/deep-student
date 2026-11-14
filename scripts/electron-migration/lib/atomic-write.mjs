// 状态文件原子写：同目录随机名 + O_EXCL 创建，写完 rename 覆盖。读方（含 repair state-json）不会读到写了一半的文件；
// 目标路径若是符号链接，rename 替换链接本身而不是写穿到链接目标。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function writeFileAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
