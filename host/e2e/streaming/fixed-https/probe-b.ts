/** Actual F1 transport/decoder, default constructor; not an IPC/login golden. */
import { IlinkClient } from '../../../plugins/ilink/api.ts';

const client = new IlinkClient();
const qr = await client.getBotQrcode();
const status = await client.getQrcodeStatus(qr.qrcode);
const updates = await client.getUpdates({ token: 'x5-offline-token', baseUrl: '', accountId: 'x5-offline-bot',
  userId: '', getUpdatesBuf: '原始 cursor /+ "', contextTokens: {} }, 35_000);
process.stdout.write(JSON.stringify({ evidence: 'B-production-client-only', qr, status, updates }) + '\n');
