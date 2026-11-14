/** Observe the actual main/preload traffic; commands still reach the official Host and ACL. */
import { appendFileSync } from 'node:fs';
import { app, ipcMain } from 'electron';
import { start } from '../../main.ts';
import { IPC_CHANNEL_TO_MAIN, IPC_CHANNEL_TO_RENDERER } from '../../shell/bridge-messages.ts';

const record = (entry: unknown) => appendFileSync(process.env.BOOT_WIRE!, `${JSON.stringify(entry)}\n`);
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send.bind(contents);
  contents.send = (channel, ...args) => {
    if (channel === IPC_CHANNEL_TO_RENDERER) record({ direction: 'reply', contents: contents.id, message: args[0] });
    send(channel, ...args);
  };
});
ipcMain.on(IPC_CHANNEL_TO_MAIN, (event, message) => {
  if (message.type === 'invoke') record({ direction: 'invoke', at: performance.timeOrigin + performance.now(), contents: event.sender.id, url: event.senderFrame?.url, message });
});
void app.whenReady().then(() => start()).catch((error: unknown) => {
  record({ fatal: String(error) });
  app.exit(1);
});
