#!/usr/bin/env node
// 重任务作业客户端：类型检查、测试、构建等占 CPU 的命令一律经全局作业队列执行（并发受限，排队期间你可以做别的事）。
//
//   node scripts/electron-migration/jobs/job.mjs submit -- <命令...>     提交并立即返回作业号（异步）
//   node scripts/electron-migration/jobs/job.mjs result <作业号> [--tail 80]  取结果：未完成时显示排队/运行状态；完成后打印输出末尾与退出码
//   node scripts/electron-migration/jobs/job.mjs wait <作业号> [--tail 80]    等到完成再打印（会阻塞，尽量用 submit + 做别的事 + result）
//   node scripts/electron-migration/jobs/job.mjs run -- <命令...>        提交并等待（等价于 submit + wait）
//   node scripts/electron-migration/jobs/job.mjs status                  队列概况
//
// 示例：job.mjs submit -- npx tsc --noEmit -p tsconfig.json
//      job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/notes
// 退出码：result/wait/run 以作业自身退出码退出；作业未完成时 result 以 75 退出。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const JOBS = process.env.OC_JOBS_DIR ?? path.join(process.env.HOME ?? '/tmp', '.oc-jobs');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function submit() {
  const i = argv.indexOf('--');
  const command = i >= 0 ? argv.slice(i + 1) : [];
  if (!command.length) throw new Error('用法：submit -- <命令...>');
  if (command.some(arg => /(?:^|\/)(?:lane-gate|fulltest|gate-runner)\.mjs$/.test(arg))) {
    throw new Error('编排父任务必须直接运行，不能占队列槽再等待同队列子任务；仅提交其叶子检查。');
  }
  fs.mkdirSync(path.join(JOBS, 'queue'), { recursive: true });
  // 去重：同一工作目录、同一命令已在排队（尚未开始）时直接复用，避免重复占用 CPU。
  for (const f of fs.readdirSync(path.join(JOBS, 'queue')).filter((x) => x.endsWith('.json'))) {
    try {
      const q = JSON.parse(fs.readFileSync(path.join(JOBS, 'queue', f), 'utf8'));
      if (q.cwd === process.cwd() && JSON.stringify(q.cmd) === JSON.stringify(command)) {
        console.error(`相同作业已在排队，复用 ${q.id}`);
        return q.id;
      }
    } catch {
      // 刚被执行器取走
    }
  }
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const job = { id, cwd: process.cwd(), cmd: command, from: path.basename(process.cwd()), submittedAt: new Date().toISOString() };
  const f = path.join(JOBS, 'queue', `${id}.json`);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(job));
  fs.renameSync(`${f}.tmp`, f);
  return id;
}

function state(id) {
  const done = path.join(JOBS, 'done', `${id}.json`);
  if (fs.existsSync(done)) return { phase: 'done', ...JSON.parse(fs.readFileSync(done, 'utf8')) };
  if (fs.existsSync(path.join(JOBS, 'running', `${id}.json`))) return { phase: 'running' };
  const q = fs.existsSync(path.join(JOBS, 'queue')) ? fs.readdirSync(path.join(JOBS, 'queue')).filter((f) => f.endsWith('.json')).sort() : [];
  const pos = q.indexOf(`${id}.json`);
  if (pos >= 0) return { phase: 'queued', position: pos + 1 };
  return { phase: 'unknown' };
}

function printResult(id, s) {
  const tail = Number(opt('tail', '80'));
  let out = '';
  try {
    out = fs.readFileSync(path.join(JOBS, 'done', `${id}.log`), 'utf8');
  } catch {
    out = '';
  }
  const lines = out.split('\n');
  console.log(lines.slice(-tail).join('\n'));
  console.log(`\n[作业 ${id}] ${s.cmd?.join(' ')}\n[作业 ${id}] 退出码 ${s.code}${s.note ? `（${s.note}）` : ''}；完整输出 ${path.join(JOBS, 'done', `${id}.log`)}`);
  process.exit(typeof s.code === 'number' && s.code >= 0 ? s.code : 1);
}

async function wait(id) {
  const started = Date.now();
  for (;;) {
    const s = state(id);
    if (s.phase === 'done') printResult(id, s);
    if (s.phase === 'unknown') {
      // A previous runner version removed QUEUE before publishing RUNNING.
      // Briefly tolerate that real hand-off race, not an unlimited missing job.
      if (Date.now() - started < 15_000) { await sleep(250); continue; }
      console.log(`未找到作业 ${id}`);
      process.exit(2);
    }
    await sleep(3000);
  }
}

if (cmd === 'submit') {
  const id = submit();
  const st = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(JOBS, 'status.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  console.log(id);
  console.error(`已提交作业 ${id}${st ? `（当前排队 ${st.queued}，运行中 ${JSON.stringify(st.running)}）` : ''}。排队期间请做不占 CPU 的事（审读实现、对照 Rust、写文档），之后用 job.mjs result ${id} 取结果。`);
} else if (cmd === 'result') {
  const id = argv[1];
  const s = state(id);
  if (s.phase === 'done') printResult(id, s);
  console.log(s.phase === 'queued' ? `作业 ${id} 排队中（第 ${s.position} 位），稍后再取` : s.phase === 'running' ? `作业 ${id} 运行中，稍后再取` : `未找到作业 ${id}`);
  process.exit(s.phase === 'unknown' ? 2 : 75);
} else if (cmd === 'wait') {
  await wait(argv[1]);
} else if (cmd === 'run') {
  await wait(submit());
} else if (cmd === 'status') {
  try {
    console.log(fs.readFileSync(path.join(JOBS, 'status.json'), 'utf8'));
  } catch {
    console.log('作业执行器未运行或尚无状态');
  }
} else {
  console.log('用法见文件头注释：submit | result | wait | run | status');
  process.exit(1);
}
