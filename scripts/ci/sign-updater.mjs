#!/usr/bin/env node
/**
 * Pure-Node Tauri-compatible minisign (.sig) signer & verifier for updater artifacts.
 * Compatible with `tauri-plugin-updater` 2.x and `electron/shell/minisign.ts`.
 *
 * Usage:
 *   node scripts/ci/sign-updater.mjs <file1> [<file2> ...] [--verify-pubkey <base64>]
 *
 * Reads:
 *   TAURI_SIGNING_PRIVATE_KEY            (required, base64-wrapped or raw 2-line minisign secret key)
 *   TAURI_SIGNING_PRIVATE_KEY_PASSWORD   (required when secret key uses scrypt KDF `Sc`)
 */
import { createPrivateKey, createPublicKey, scryptSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake2b } from '@noble/hashes/blake2b';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeSecretKeyLines(rawInput) {
  const trimmed = rawInput.trim();
  if (!trimmed) throw new Error('TAURI_SIGNING_PRIVATE_KEY is empty');
  const text = trimmed.startsWith('untrusted comment:')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[0].startsWith('untrusted comment:')) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is not a valid minisign secret key');
  }
  return Buffer.from(lines[1].trim(), 'base64');
}

export function parseTauriSigningPrivateKey(rawPrivateKey, password = '') {
  const raw = decodeSecretKeyLines(rawPrivateKey);
  if (raw.length !== 158) {
    throw new Error(`Invalid minisign secret key payload length: expected 158, got ${raw.length}`);
  }
  const sigAlg = raw.subarray(0, 2).toString('utf8');
  const kdfAlg = raw.subarray(2, 4).toString('utf8');
  const chkAlg = raw.subarray(4, 6).toString('utf8');
  if (sigAlg !== 'Ed' && sigAlg !== 'ED') {
    throw new Error(`Unsupported minisign signature algorithm: ${sigAlg}`);
  }
  if (chkAlg !== 'B2') {
    throw new Error(`Unsupported minisign checksum algorithm: ${chkAlg}`);
  }

  let secretPayload;
  const encrypted = raw.subarray(54, 158);
  if (kdfAlg === 'Sc') {
    if (!password) {
      throw new Error('TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required for encrypted signing key');
    }
    const salt = raw.subarray(6, 38);
    const opslimit = Number(raw.readBigUInt64LE(38));
    const memlimit = Number(raw.readBigUInt64LE(46));
    const r = 8;
    const N = Math.max(1, memlimit / (128 * r));
    const p = Math.max(1, Math.round(opslimit / (4 * r * N)));
    if (!Number.isInteger(Math.log2(N))) {
      throw new Error(`Unsupported scrypt parameters in signing key (N=${N}, r=${r}, p=${p})`);
    }
    const stream = scryptSync(password, salt, 104, { N, r, p, maxmem: Math.max(memlimit * 2, 64 * 1024 * 1024) });
    secretPayload = Buffer.alloc(104);
    for (let i = 0; i < 104; i++) secretPayload[i] = encrypted[i] ^ stream[i];
  } else if (kdfAlg === '\u0000\u0000') {
    secretPayload = encrypted;
  } else {
    throw new Error(`Unsupported minisign KDF algorithm: ${JSON.stringify(kdfAlg)}`);
  }

  const keynum = secretPayload.subarray(0, 8);
  const keypair = secretPayload.subarray(8, 72);
  const checksum = secretPayload.subarray(72, 104);
  const expectedChecksum = Buffer.from(blake2b(Buffer.concat([raw.subarray(0, 2), keynum, keypair]), { dkLen: 32 }));
  if (!checksum.equals(expectedChecksum)) {
    throw new Error('Failed to decrypt TAURI_SIGNING_PRIVATE_KEY (wrong password or corrupted key)');
  }

  const seed = keypair.subarray(0, 32);
  const pubBytes = keypair.subarray(32, 64);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, pubBytes]), format: 'der', type: 'spki' });
  const encodedPubKey = Buffer.from(
    `untrusted comment: minisign public key: ${Buffer.from(keynum).reverse().toString('hex').toUpperCase()}\n`
    + `${Buffer.concat([Buffer.from('Ed'), keynum, pubBytes]).toString('base64')}\n`,
    'utf8',
  ).toString('base64');

  return { keynum, privateKey, publicKey, encodedPubKey };
}

export function signMinisignPayload(data, keyInfo, filename, timestamp = Math.floor(Date.now() / 1000)) {
  const prehash = Buffer.from(blake2b(data));
  const signature = edSign(null, prehash, keyInfo.privateKey);
  const sigLine = Buffer.concat([Buffer.from('ED'), keyInfo.keynum, signature]).toString('base64');
  const trustedComment = `timestamp:${timestamp}\tfile:${filename}`;
  const globalSig = edSign(null, Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]), keyInfo.privateKey);
  const inner = [
    'untrusted comment: signature from tauri secret key',
    sigLine,
    `trusted comment: ${trustedComment}`,
    globalSig.toString('base64'),
    '',
  ].join('\n');
  return Buffer.from(inner, 'utf8').toString('base64');
}

export function verifyGeneratedSig(data, encodedSig, expectedPubKeyB64) {
  const pubLines = Buffer.from(expectedPubKeyB64.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const pubRaw = Buffer.from(pubLines[1], 'base64');
  const sigLines = Buffer.from(encodedSig.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const sigRaw = Buffer.from(sigLines[1], 'base64');
  const globalRaw = Buffer.from(sigLines[3], 'base64');
  if (!pubRaw.subarray(2, 10).equals(sigRaw.subarray(2, 10))) {
    throw new Error('Generated signature key ID does not match expected public key');
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, pubRaw.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const sigBytes = sigRaw.subarray(10);
  const algorithm = sigRaw.subarray(0, 2).toString('utf8');
  const msg = algorithm === 'ED' ? Buffer.from(blake2b(data)) : data;
  const trustedBody = Buffer.from(sigLines[2].slice('trusted comment: '.length), 'utf8');
  if (!edVerify(null, msg, publicKey, sigBytes) || !edVerify(null, Buffer.concat([sigBytes, trustedBody]), publicKey, globalRaw)) {
    throw new Error('Generated signature failed cryptographic verification');
  }
}

function main() {
  const args = process.argv.slice(2);
  let verifyPubkey = '';
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verify-pubkey') {
      verifyPubkey = args[++i] || '';
      if (!verifyPubkey) throw new Error('--verify-pubkey requires a value');
    } else {
      files.push(args[i]);
    }
  }
  if (files.length === 0) {
    throw new Error('Usage: node scripts/ci/sign-updater.mjs <file1> [<file2> ...] [--verify-pubkey <b64>]');
  }

  const rawKey = process.env.TAURI_SIGNING_PRIVATE_KEY || '';
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '';
  const keyInfo = parseTauriSigningPrivateKey(rawKey, password);
  const pubkeyToVerify = verifyPubkey || keyInfo.encodedPubKey;

  for (const file of files) {
    const resolved = path.resolve(file);
    const bytes = readFileSync(resolved);
    const sig = signMinisignPayload(bytes, keyInfo, path.basename(resolved));
    verifyGeneratedSig(bytes, sig, pubkeyToVerify);
    writeFileSync(`${resolved}.sig`, `${sig}\n`, 'utf8');
    console.log(`[sign-updater] signed ${path.basename(resolved)} -> ${path.basename(resolved)}.sig`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[sign-updater] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
