/**
 * 以打包版 Host 相同的方式（`utilityProcess.fork`，无额外 execArgv）启动 `ASAR_UTILITY_ENTRY`，把它通过
 * parentPort 发回的第一条消息打印成 `ASAR-UTILITY-RESULT <json>`，然后以子进程的退出码退出。
 */
import { app, utilityProcess } from 'electron';

app.whenReady().then(() => {
  const child = utilityProcess.fork(process.env.ASAR_UTILITY_ENTRY, [], { stdio: 'inherit' });
  child.once('message', (message) => process.stdout.write(`ASAR-UTILITY-RESULT ${JSON.stringify(message)}\n`));
  child.once('exit', (code) => app.exit(code));
});
