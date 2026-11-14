// 运维意图：人或部署流程"有意停住"的显式标记。自动恢复（night-guard、repair、stall-watch）一律先查这里，
// 不再从 systemd 的 Result= 推断"是不是人停的"（停止超时被 SIGKILL 是 Result=timeout，干净退出是 success，都不可靠）。
//   ~/ops-night/maintenance、.oc-runs/maintenance.json   全局维护：一切启动/重启/恢复动作暂停
//   ~/ops-night/hold/<name>                             只停住一项：ds-migration、ds-jobs、ds-dashboard、ds-fulltest、ds-stall-watch
// 标记可以是任意类型的文件；只有普通文件才读取前 200 字节作为原因（不跟随链接、不读 FIFO）。
// 任何 dsdev 进程都能创建标记，所以存在过久的标记要告警（staleHolds），而不是被默默遵守下去。
import fs from 'node:fs';
import path from 'node:path';

export const defaultOpsDir = (root) => path.resolve(root, '..', '..', 'ops-night');
/** hold 目录；DS_HOLD_DIR 可指向 dsdev 不可写的位置（如 /etc/ds-ops/hold），防止 agent 自行 hold 服务。 */
export const holdDir = (opsDir, env = process.env) => env.DS_HOLD_DIR || path.join(opsDir, 'hold');

function inspect(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  let text = '';
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      if (fs.fstatSync(fd).isFile()) {
        const buf = Buffer.alloc(200);
        text = buf.subarray(0, fs.readSync(fd, buf, 0, 200, 0)).toString('utf8');
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    text = '';
  }
  let by = null;
  let reason = text.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      by = typeof j.by === 'string' ? j.by.slice(0, 80) : null;
      reason = String(j.reason ?? reason).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
    }
  } catch {
    // 纯文本原因
  }
  return { mtimeMs: st.mtimeMs, uid: st.uid, regular: st.isFile(), by, reason };
}

function marker(file) {
  const m = inspect(file);
  return m ? `${path.basename(file)}: ${m.reason || '(无说明)'}` : null;
}

/** 全局维护或指定项被 hold 时返回原因，否则 null。 */
export function holdReason({ runs, opsDir, unit = null, env = process.env }) {
  for (const f of [path.join(opsDir, 'maintenance'), path.join(runs, 'maintenance.json')]) {
    const m = marker(f);
    if (m) return m;
  }
  if (unit) {
    const m = marker(path.join(holdDir(opsDir, env), unit));
    if (m) return `hold/${m}`;
  }
  return null;
}

export function holdAlertMs(env = process.env) {
  const h = Number(env.DS_HOLD_ALERT_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 6) * 3_600_000;
}

/** 存在超过 maxAgeMs 的维护标记与 hold 文件：名字、创建时间（mtime）、时长、内容里的 by/reason、文件属主 uid。 */
export function staleHolds({ runs, opsDir, nowMs = Date.now(), maxAgeMs = holdAlertMs(), env = process.env }) {
  const files = [['maintenance', path.join(opsDir, 'maintenance')], ['maintenance.json', path.join(runs, 'maintenance.json')]];
  try {
    const dir = holdDir(opsDir, env);
    for (const n of fs.readdirSync(dir).sort()) if (/^[\w.-]+$/.test(n)) files.push([`hold/${n}`, path.join(dir, n)]);
  } catch {
    // 没有 hold 目录
  }
  const out = [];
  for (const [name, file] of files) {
    const m = inspect(file);
    if (!m || nowMs - m.mtimeMs <= maxAgeMs) continue;
    out.push({ name, since: new Date(m.mtimeMs).toISOString(), ageHours: Math.round((nowMs - m.mtimeMs) / 360_000) / 10, by: m.by, uid: m.uid, reason: m.regular ? m.reason : '(不是普通文件，未读取)' });
  }
  return out;
}

export function staleHoldsText(stale) {
  if (!stale.length) return '';
  return `## ⚠ 长时间存在的停住标记（巡检/修复/卡住处理会一直不动这些服务）\n${stale.map((s) => `- ${s.name}：${s.since} 起已 ${s.ageHours} 小时${s.by ? `，by ${s.by}` : ''}（文件属主 uid ${s.uid}）；原因：${s.reason || '(无说明)'}`).join('\n')}\n确认仍需要就保留；否则删除该文件。\n\n`;
}
