// 自动质量反馈由 ds-quality-feedback.timer 在主循环外生成（quality-feedback.mjs --spool），调度守护进程只消费结果。
// 原先每次自动集成后在主循环里同步运行（最长 600 秒），期间 fastTick 心跳和派发全部停住。
//
// 生成端把“本轮新问题”写成假脱机文件（每批一个，原子写入），再更新已发送状态；消费端按时间顺序投递，
// 投递成功才删除。这样生成和消费互不等待，主循环漏读或重启都不会丢反馈。
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { reportsDir } from './coord-reports.mjs';

export const spoolDir = (runs) => path.join(reportsDir(runs), 'quality-feedback');
export const statusFile = (runs) => path.join(reportsDir(runs), 'quality-feedback.json');
export const STALE_MS = 90 * 60_000;
const MAX_ITEMS = 30;

/** 写一批新问题；没有任何 lane 有问题时不写。返回文件路径或 null。 */
export function writeBatch(runs, { head, fresh, now = Date.now() }) {
  const lanes = Object.fromEntries(Object.entries(fresh ?? {}).filter(([, items]) => items?.length));
  if (!Object.keys(lanes).length) return null;
  fs.mkdirSync(spoolDir(runs), { recursive: true });
  const file = path.join(spoolDir(runs), `${String(now).padStart(15, '0')}-${String(head).slice(0, 12)}.json`);
  writeFileAtomic(file, JSON.stringify({ head, generatedAt: new Date(now).toISOString(), fresh: lanes }));
  return file;
}

export function writeStatus(runs, status) {
  fs.mkdirSync(reportsDir(runs), { recursive: true });
  writeFileAtomic(statusFile(runs), JSON.stringify(status));
}

/**
 * 生成端流程。scan() 返回 { fresh, state }；先落假脱机文件再 saveState(state)，
 * 崩在两步之间最多重复发一次，不会丢。ifChanged 且 main 未前进时只刷新状态文件。
 */
export function generate({ runs, head, lastCommit, ifChanged = false, scan, saveState, now = Date.now }) {
  if (ifChanged && lastCommit === head) {
    writeStatus(runs, { head, generatedAt: new Date(now()).toISOString(), skipped: 'unchanged' });
    return { skipped: 'unchanged' };
  }
  let result;
  try {
    result = scan();
  } catch (e) {
    writeStatus(runs, { head, generatedAt: new Date(now()).toISOString(), error: String(e.message).split('\n')[0] });
    throw e;
  }
  const file = writeBatch(runs, { head, fresh: result.fresh, now: now() });
  saveState(result.state);
  const lanes = Object.values(result.fresh ?? {}).filter((items) => items?.length).length;
  writeStatus(runs, { head, generatedAt: new Date(now()).toISOString(), lanes, batch: file && path.basename(file) });
  return { file, lanes };
}

/**
 * 消费端：按文件名（时间）顺序把每批交给 deliver(batch)。deliver 抛错则停止、保留该批与其后各批，下个 tick 重试；
 * 读不出的文件（非普通文件、坏 JSON）改名为 .bad 隔离，不再重试。
 */
export function drain(runs, deliver) {
  let names;
  try {
    names = fs.readdirSync(spoolDir(runs)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { delivered: 0, quarantined: 0 };
  }
  let delivered = 0;
  let quarantined = 0;
  for (const name of names) {
    const file = path.join(spoolDir(runs), name);
    let batch;
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error('not a regular file');
      batch = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!batch || typeof batch.fresh !== 'object') throw new Error('no fresh map');
    } catch {
      fs.renameSync(file, `${file}.bad`);
      quarantined++;
      continue;
    }
    deliver(batch);
    fs.rmSync(file, { force: true });
    delivered++;
  }
  return { delivered, quarantined };
}

export function message(items) {
  const shown = items.slice(0, MAX_ITEMS);
  const more = items.length > shown.length ? `\n（另有 ${items.length - shown.length} 条同类问题，运行 node scripts/electron-migration/quality-feedback.mjs 查看全部）` : '';
  return `【自动质量反馈】main 上属于本 lane 的新问题（按 quality.md 处理，修完提交；与当前工作冲突时先完成手头单元再处理）：\n- ${shown.join('\n- ')}${more}`;
}

/** 摘要用：正常时为空串；缺失、过期或上次生成失败时给一行说明。 */
export function statusLine(runs, { now = Date.now(), maxAgeMs = STALE_MS } = {}) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(statusFile(runs), 'utf8'));
  } catch {
    return '（⚠ 质量反馈暂无：等待 ds-quality-feedback.timer 生成）\n\n';
  }
  const age = now - Date.parse(st.generatedAt);
  if (!(age <= maxAgeMs)) return `（⚠ 质量反馈已 ${Math.round(age / 60_000)} 分钟未生成：ds-quality-feedback.timer 可能没在跑）\n\n`;
  if (st.error) return `（⚠ 质量反馈上次生成失败：${st.error}）\n\n`;
  return '';
}
