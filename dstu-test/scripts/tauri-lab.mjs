#!/usr/bin/env node
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = process.env.TAURI_LAB_HOME
  ? path.resolve(process.env.TAURI_LAB_HOME)
  : path.join(os.homedir(), 'Library', 'Application Support', 'tauri-lab');

const DEFAULT_PORT = Number(process.env.TAURI_LAB_PORT || 47631);
const DAEMON_FILE = path.join(ROOT, 'daemon.json');
const TOKEN_FILE = path.join(ROOT, 'token');
const REGISTRY_FILE = path.join(ROOT, 'registry.json');
const APPS_DIR = path.join(ROOT, 'apps');
const HOMES_DIR = path.join(ROOT, 'homes');
const LOGS_DIR = path.join(ROOT, 'logs');
const EVIDENCE_DIR = path.join(ROOT, 'evidence');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const IMAGES_DIR = path.join(ROOT, 'images');
const DEFAULT_METRICS_HOST = '127.0.0.1';
const DEFAULT_METRICS_PORT_START = 59331;
const DEFAULT_METRICS_PORT_END = Number(process.env.TAURI_LAB_METRICS_PORT_END || 59680);
const DEFAULT_WEBDAV_PORT_START = 18080;
const DEFAULT_WEBDAV_PORT_END = 18179;
const LAUNCH_AGENT_LABEL = 'com.deepstudent.tauri-lab';
const LAUNCH_AGENT_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
const NODE_BUILTIN_WEBDAV_SCRIPT = String.raw`
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const ROOT = process.env.WEBDAV_ROOT || '/data';
const USERNAME = process.env.USERNAME || 'webdav';
const PASSWORD = process.env.PASSWORD || 'webdav';
const PORT = Number(process.env.PORT || 8080);
const REALM = 'tauri-lab-webdav';
function send(res, status, body = '') {
  res.statusCode = status;
  res.end(body);
}
function authOk(req) {
  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(USERNAME + ':' + PASSWORD).toString('base64');
  return header === expected;
}
function safePath(rawUrl) {
  const parsed = new URL(rawUrl, 'http://127.0.0.1');
  const decoded = decodeURIComponent(parsed.pathname || '/');
  const normalized = path.posix.normalize('/' + decoded).replace(/^\/+/, '');
  const local = path.resolve(ROOT, normalized);
  if (!local.startsWith(path.resolve(ROOT))) throw new Error('invalid path');
  return { local, href: '/' + normalized };
}
function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
}
async function responseXml(file, href) {
  const stat = await fsp.stat(file);
  const isDir = stat.isDirectory();
  const slashHref = isDir && !href.endsWith('/') ? href + '/' : href;
  return [
    '<d:response>',
    '<d:href>' + xmlEscape(slashHref) + '</d:href>',
    '<d:propstat><d:prop>',
    '<d:resourcetype>' + (isDir ? '<d:collection/>' : '') + '</d:resourcetype>',
    '<d:getcontentlength>' + (isDir ? 0 : stat.size) + '</d:getcontentlength>',
    '<d:getlastmodified>' + stat.mtime.toUTCString() + '</d:getlastmodified>',
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>',
    '</d:response>',
  ].join('');
}
async function handlePropfind(req, res, local, href) {
  const stat = await fsp.stat(local);
  const chunks = [await responseXml(local, href)];
  const depth = req.headers.depth || 'infinity';
  if (stat.isDirectory() && depth !== '0') {
    for (const name of await fsp.readdir(local)) {
      chunks.push(await responseXml(path.join(local, name), path.posix.join(href, name)));
    }
  }
  res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
  res.end('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' + chunks.join('') + '</d:multistatus>');
}
async function main(req, res) {
  if (!authOk(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="' + REALM + '"' });
    return res.end('unauthorized');
  }
  let target;
  try {
    target = safePath(req.url);
  } catch {
    return send(res, 400, 'bad path');
  }
  const { local, href } = target;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { DAV: '1,2', Allow: 'OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,PROPFIND' });
      return res.end();
    }
    if (req.method === 'MKCOL') {
      await fsp.mkdir(local, { recursive: true });
      return send(res, 201);
    }
    if (req.method === 'PUT') {
      await fsp.mkdir(path.dirname(local), { recursive: true });
      const existed = fs.existsSync(local);
      const out = fs.createWriteStream(local);
      req.pipe(out);
      out.on('finish', () => send(res, existed ? 204 : 201));
      out.on('error', err => send(res, 500, err.message));
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const stat = await fsp.stat(local);
      if (stat.isDirectory()) {
        const body = (await fsp.readdir(local)).join('\n') + '\n';
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return req.method === 'HEAD' ? res.end() : res.end(body);
      }
      res.writeHead(200, { 'content-length': stat.size });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(local).pipe(res);
    }
    if (req.method === 'DELETE') {
      await fsp.rm(local, { recursive: true, force: true });
      return send(res, 204);
    }
    if (req.method === 'PROPFIND') return handlePropfind(req, res, local, href);
    send(res, 405, 'method not allowed');
  } catch (error) {
    if (error && error.code === 'ENOENT') return send(res, 404, 'not found');
    send(res, 500, error && error.message ? error.message : String(error));
  }
}
fsp.mkdir(ROOT, { recursive: true }).then(() => {
  http.createServer((req, res) => void main(req, res)).listen(PORT, '0.0.0.0', () => {
    console.log('node-builtin-webdav listening on ' + PORT + ' root=' + ROOT);
  });
});
`;
let apiQueue = Promise.resolve();

function usage() {
  console.log(`tauri-lab

Usage:
  tauri-lab service start|status|stop|restart [--with-instances] [--json]
  tauri-lab service install|uninstall [--start] [--stop] [--json]
  tauri-lab project register <id> --cwd <path> --source-app <path> [--name <name>]
  tauri-lab project list [--json]
  tauri-lab project inspect <id> [--json]
  tauri-lab instance create <project-id> <profile> [--display-name <name>] [--bundle-id <id>] [--device-id <id>] [--metrics-addr <addr>]
    [--image <image-id>]
  tauri-lab instance start|restart <instance-id> [--wait] [--metrics] [--timeout <seconds>] [--json]
  tauri-lab instance stop|status <instance-id> [--json]
  tauri-lab instance wait <instance-id> [--metrics] [--timeout <seconds>] [--json]
  tauri-lab instance stop-all [--json]
  tauri-lab instance list [--json]
  tauri-lab pool create <project-id> <pool-id> --count <n> [--json]
    [--image <image-id>]
  tauri-lab pool start|stop|restart <pool-id> [--concurrency <n>] [--wait] [--metrics] [--timeout <seconds>] [--json]
  tauri-lab pool status|list <pool-id> [--json]
  tauri-lab computer-use target <instance-id> [--json]
  tauri-lab computer-use list [--json]
  tauri-lab agent checkout <pool-id> --owner <name> [--purpose <text>] [--ttl <seconds>] [--start] [--wait] [--metrics] [--json]
  tauri-lab agent targets --owner <name> [--json]
  tauri-lab agent verify <instance-id> --owner <name> [--app <path>] [--require-running] [--json]
  tauri-lab agent release <instance-id> --owner <name> [--json]
  tauri-lab lease acquire <instance-id> --owner <name> [--purpose <text>] [--ttl <seconds>] [--force] [--json]
  tauri-lab lease release <instance-id> --owner <name> [--force] [--json]
  tauri-lab lease list|audit [--json]
  tauri-lab lease clear [--owner <name>] [--pool <pool-id>] [--force] [--json]
  tauri-lab logs <instance-id|daemon> [--kind backend|stderr|frontend|daemon|all] [--tail <lines>]
  tauri-lab fixture webdav start <id> [--port <port>] [--username <name>] [--password <pass>] [--root <path>] [--server bytemark|node-builtin] [--image <image>] [--json]
  tauri-lab fixture webdav stop|status|tree|credentials <id> [--json]
  tauri-lab fixture list [--json]
  tauri-lab image create <image-id> --from-instance <instance-id> [--scope home|app-data] [--description <text>] [--force] [--live] [--json]
  tauri-lab image apply <image-id> --to-instance <instance-id> [--force] [--json]
  tauri-lab image list|inspect|remove [image-id] [--json]
  tauri-lab evidence snapshot <instance-id> [--tail <lines>] [--json]
  tauri-lab assert slot <instance-id> [--active <slot>] [--pending <slot|null>] [--json]
  tauri-lab assert sqlite <instance-id> --slot active|slotA --db <chat_v2|vfs|llm_usage|mistakes|...> --query <sql> [--equals <value>] [--json]
  tauri-lab assert credential <instance-id> --cloud-storage present|absent [--json]
  tauri-lab assert webdav-tree <fixture-id> --contains <path> [--json]

Useful global flags:
  --ensure-service  Start the local daemon first when needed.

Environment:
  TAURI_LAB_HOME  Override runtime directory.
  TAURI_LAB_PORT  Override daemon port.
`);
}

function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      flags[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[raw] = true;
    } else {
      flags[raw] = next;
      i += 1;
    }
  }
  return { positionals, flags };
}

function requireArg(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizeBundlePart(value) {
  return slug(value).replace(/-/g, '.').replace(/[^a-z0-9.]+/g, '.').replace(/\.+/g, '.');
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function ensureBaseDirs() {
  await Promise.all([
    fsp.mkdir(ROOT, { recursive: true }),
    fsp.mkdir(APPS_DIR, { recursive: true }),
    fsp.mkdir(HOMES_DIR, { recursive: true }),
    fsp.mkdir(LOGS_DIR, { recursive: true }),
    fsp.mkdir(EVIDENCE_DIR, { recursive: true }),
    fsp.mkdir(FIXTURES_DIR, { recursive: true }),
    fsp.mkdir(IMAGES_DIR, { recursive: true }),
  ]);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

async function getOrCreateToken() {
  await ensureBaseDirs();
  try {
    const token = (await fsp.readFile(TOKEN_FILE, 'utf8')).trim();
    if (token) return token;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(24).toString('hex');
  await fsp.writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

async function loadRegistry() {
  const registry = await readJson(REGISTRY_FILE, {
    version: 1,
    projects: {},
    instances: {},
    pools: {},
    leases: {},
    fixtures: {},
    images: {},
  });
  registry.projects ||= {};
  registry.instances ||= {};
  registry.pools ||= {};
  registry.leases ||= {};
  registry.fixtures ||= {};
  registry.images ||= {};
  return registry;
}

async function saveRegistry(registry) {
  await writeJson(REGISTRY_FILE, registry);
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveFromCwd(cwd, maybeRelative) {
  if (!maybeRelative) return maybeRelative;
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(cwd, maybeRelative);
}

function isExpiredLease(lease, now = Date.now()) {
  return Boolean(lease?.expires_at && Date.parse(lease.expires_at) <= now);
}

function activeLease(registry, instanceId) {
  const lease = registry.leases?.[instanceId];
  return lease && !isExpiredLease(lease) ? lease : null;
}

function purgeExpiredLeases(registry) {
  let changed = false;
  for (const [id, lease] of Object.entries(registry.leases || {})) {
    if (isExpiredLease(lease)) {
      delete registry.leases[id];
      changed = true;
    }
  }
  return changed;
}

function withLease(registry, instance) {
  return {
    ...publicInstance(instance),
    lease: activeLease(registry, instance.id),
  };
}

function isTcpPortFree(host, port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}

async function allocateMetricsAddr(registry) {
  const used = new Set(
    Object.values(registry.instances || {})
      .map(instance => instance.metrics_addr)
      .filter(Boolean),
  );

  for (let port = DEFAULT_METRICS_PORT_START; port <= DEFAULT_METRICS_PORT_END; port += 1) {
    const addr = `${DEFAULT_METRICS_HOST}:${port}`;
    if (used.has(addr)) continue;
    if (await isTcpPortFree(DEFAULT_METRICS_HOST, port)) return addr;
  }

  throw new Error(
    `No free metrics port found in ${DEFAULT_METRICS_HOST}:${DEFAULT_METRICS_PORT_START}-${DEFAULT_METRICS_PORT_END}`,
  );
}

function poolIndexLabel(index, count) {
  return String(index).padStart(Math.max(2, String(count).length), '0');
}

function defaultDisplayName(projectId, profile) {
  const projectPrefix = projectId === 'deep-student' ? 'ds' : slug(projectId).slice(0, 8);
  const full = `${projectPrefix}-${profile}`;
  if (full.length <= 30) return full;

  const hash = crypto.createHash('sha1').update(full).digest('hex').slice(0, 6);
  const prefix = full.slice(0, 23).replace(/[-_.]+$/, '');
  return `${prefix}-${hash}`;
}

async function createInstanceRecord(registry, body) {
  const projectId = slug(requireArg(body.project_id, 'project_id is required'));
  const profile = slug(requireArg(body.profile, 'profile is required'));
  const project = registry.projects[projectId];
  if (!project) throw new Error(`Unknown project: ${projectId}`);

  const id = slug(body.id || `${projectId}-${profile}`);
  const existing = registry.instances[id];
  const displayName = body.display_name || existing?.display_name || defaultDisplayName(projectId, profile);
  const appPath = existing?.app_path || path.join(APPS_DIR, `${displayName}.app`);
  const binaryPath = existing?.binary_path || path.join(appPath, body.binary_relative_path || project.binary_relative_path);
  const bundleId =
    body.bundle_id ||
    existing?.bundle_id ||
    `com.tauri-lab.${sanitizeBundlePart(projectId)}.${sanitizeBundlePart(profile)}`;

  registry.instances[id] = {
    id,
    project_id: projectId,
    profile,
    display_name: displayName,
    bundle_id: bundleId,
    app_path: appPath,
    binary_path: binaryPath,
    home: path.resolve(body.home || existing?.home || path.join(HOMES_DIR, id)),
    device_id: body.device_id || existing?.device_id || `e2e-${profile}`,
    metrics_addr: body.metrics_addr || existing?.metrics_addr || (await allocateMetricsAddr(registry)),
    computer_use_target: appPath,
    log_stdout: existing?.log_stdout || path.join(LOGS_DIR, `${id}.stdout.log`),
    log_stderr: existing?.log_stderr || path.join(LOGS_DIR, `${id}.stderr.log`),
    log_frontend: existing?.log_frontend || path.join(LOGS_DIR, `${id}.frontend.jsonl`),
    env: {
      ...(existing?.env || {}),
      ...(body.env || {}),
    },
    seed_image_id: body.image_id || existing?.seed_image_id || null,
    seed_image_scope: existing?.seed_image_scope || null,
    seed_image_applied_at: existing?.seed_image_applied_at || null,
    pid: existing?.pid || null,
    state: existing?.state || 'stopped',
    pool_id: body.pool_id || existing?.pool_id || null,
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  return publicInstance(registry.instances[id]);
}

function computerUseTarget(registry, instance) {
  return {
    id: instance.id,
    app: instance.computer_use_target,
    bundle_id: instance.bundle_id,
    pid: isPidAlive(instance.pid) ? instance.pid : null,
    state: isPidAlive(instance.pid) ? 'running' : 'stopped',
    display_name: instance.display_name,
    home: instance.home,
    device_id: instance.device_id,
    metrics_addr: instance.metrics_addr,
    logs: {
      backend: instance.log_stdout,
      stderr: instance.log_stderr,
      frontend: instance.log_frontend,
    },
    lease: activeLease(registry, instance.id),
  };
}

function agentTargets(registry, owner) {
  const targets = Object.values(registry.instances || {})
    .map(instance => computerUseTarget(registry, instance))
    .filter(target => target.lease?.owner === owner)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    owner,
    count: targets.length,
    targets,
  };
}

function auditLeases(registry) {
  const failures = [];
  const active = [];
  const expired = [];
  const byApp = new Map();

  for (const [instanceId, lease] of Object.entries(registry.leases || {})) {
    const instance = registry.instances?.[instanceId];
    if (!instance) {
      failures.push(`lease references unknown instance: ${instanceId}`);
      continue;
    }

    if (isExpiredLease(lease)) {
      expired.push(lease);
      continue;
    }

    const target = computerUseTarget(registry, instance);
    active.push({ ...lease, target });
    const appKey = target.app;
    const sameApp = byApp.get(appKey) || [];
    sameApp.push({ instance_id: instanceId, owner: lease.owner });
    byApp.set(appKey, sameApp);
  }

  for (const [app, leases] of byApp.entries()) {
    if (leases.length > 1) {
      failures.push(`multiple active leases share app target ${app}: ${leases.map(item => `${item.instance_id}/${item.owner}`).join(', ')}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    active_count: active.length,
    expired_count: expired.length,
    owners: [...new Set(active.map(item => item.owner))].sort(),
    active,
    expired,
  };
}

function verifyAgentAssignment(registry, body) {
  const owner = requireArg(body.owner, 'owner is required');
  const instanceId = requireArg(body.instance_id, 'instance_id is required');
  const instance = registry.instances?.[instanceId];
  const failures = [];
  let target = null;

  if (!instance) {
    failures.push(`unknown instance: ${instanceId}`);
  } else {
    target = computerUseTarget(registry, instance);
    if (!target.lease) {
      failures.push(`instance ${instanceId} has no active lease`);
    } else if (target.lease.owner !== owner) {
      failures.push(`instance ${instanceId} is leased to ${target.lease.owner}, not ${owner}`);
    }

    if (body.app && path.resolve(body.app) !== path.resolve(target.app)) {
      failures.push(`app path mismatch: expected ${target.app}, got ${body.app}`);
    }

    if (body.require_running && target.state !== 'running') {
      failures.push(`instance ${instanceId} is ${target.state}, not running`);
    }
  }

  const leaseAudit = auditLeases(registry);
  for (const failure of leaseAudit.failures) failures.push(failure);

  return {
    ok: failures.length === 0,
    failures,
    owner,
    instance_id: instanceId,
    target,
    lease_audit: {
      ok: leaseAudit.ok,
      active_count: leaseAudit.active_count,
      owners: leaseAudit.owners,
    },
  };
}

function poolStatus(registry, pool) {
  const instances = (pool.instance_ids || [])
    .map(id => registry.instances[id])
    .filter(Boolean)
    .map(instance => withLease(registry, instance));
  const running = instances.filter(instance => instance.state === 'running').length;
  return {
    ...pool,
    count: instances.length,
    running,
    stopped: instances.length - running,
    instances,
  };
}

async function runWithConcurrency(items, limit, task) {
  const results = [];
  let next = 0;
  const workerCount = Math.max(1, Math.min(Math.max(1, Number(limit || 1)), items.length || 1));

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function execFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function parseNullableSlot(value) {
  if (value === undefined) return undefined;
  if (value === null || value === 'null' || value === 'none' || value === '') return null;
  return value;
}

async function readTextIfExists(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function tailText(text, lines = 200) {
  const all = text.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

async function listFilesRecursive(root, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const results = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
      } else if (!options.filter || options.filter(absolute, relative)) {
        const stat = await fsp.stat(absolute);
        results.push({
          path: relative,
          absolute,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
    }
  }

  await walk(root, 0);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function findFreePortInRange(registry, start, end, usedValues = []) {
  const used = new Set(usedValues.filter(Boolean));
  for (let port = start; port <= end; port += 1) {
    if (used.has(port) || used.has(`127.0.0.1:${port}`)) continue;
    if (await isTcpPortFree('127.0.0.1', port)) return port;
  }
  throw new Error(`No free port found in 127.0.0.1:${start}-${end}`);
}

async function dockerExec(args, options = {}) {
  return execFile('docker', args, options);
}

async function dockerServerVersion() {
  try {
    const { stdout } = await dockerExec(['version', '--format', '{{.Server.Version}}']);
    return stdout.trim();
  } catch (error) {
    throw new Error(`Docker daemon is not available: ${String(error.stderr || error.message || error).trim()}`);
  }
}

async function dockerContainerInfo(name) {
  try {
    const { stdout } = await dockerExec(['inspect', name]);
    return JSON.parse(stdout)[0] || null;
  } catch (error) {
    if (String(error.stderr || error.message || '').includes('No such object')) return null;
    throw error;
  }
}

function publicFixture(fixture, options = {}) {
  if (!fixture) return fixture;
  return {
    ...fixture,
    password: options.includeSecrets ? fixture.password : '[REDACTED]',
    credentials_command: options.includeSecrets ? undefined : `npm run tauri-lab -- fixture webdav credentials ${fixture.id} --json`,
  };
}

async function webdavFixtureStatus(fixture) {
  const info = await dockerContainerInfo(fixture.container).catch(error => ({ error: error.message || String(error) }));
  const docker = info?.error
    ? { available: false, error: info.error }
    : {
        available: true,
        exists: Boolean(info),
        running: Boolean(info?.State?.Running),
        status: info?.State?.Status || 'missing',
      };
  return {
    ...publicFixture(fixture),
    state: docker.running ? 'running' : 'stopped',
    docker,
  };
}

async function startWebdavFixture(registry, body) {
  const id = slug(requireArg(body.id, 'Fixture id is required'));
  await dockerServerVersion();

  const existing = registry.fixtures[id];
  const usedPorts = Object.values(registry.fixtures || {}).map(fixture => fixture.port);
  const port = body.port
    ? Math.floor(positiveNumber(body.port, DEFAULT_WEBDAV_PORT_START))
    : existing?.port || (await findFreePortInRange(registry, DEFAULT_WEBDAV_PORT_START, DEFAULT_WEBDAV_PORT_END, usedPorts));
  const username = body.username || existing?.username || 'ds-test';
  const password = body.password || existing?.password || `ds-pass-${crypto.randomBytes(4).toString('hex')}`;
  const root = body.root || existing?.root || `deep-student-e2e-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const hostDir = path.resolve(body.host_dir || existing?.host_dir || path.join(FIXTURES_DIR, id, 'webdav-root'));
  const container = body.container || existing?.container || `tauri-lab-webdav-${id}`;
  const server = body.server || existing?.server || 'bytemark';
  const image = body.image || existing?.image || (server === 'node-builtin' ? 'yuqing-agent:latest' : 'bytemark/webdav:latest');
  const endpointPath = body.endpoint_path || existing?.endpoint_path || '/';
  const endpoint = `http://127.0.0.1:${port}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`;

  await fsp.mkdir(path.join(hostDir, root), { recursive: true });

  const current = await dockerContainerInfo(container);
  if (current?.State?.Running) {
    registry.fixtures[id] = {
      id,
      type: 'webdav',
      container,
      server,
      image,
      endpoint,
      endpoint_path: endpointPath,
      port,
      username,
      password,
      root,
      host_dir: hostDir,
      started_at: existing?.started_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    return webdavFixtureStatus(registry.fixtures[id]);
  }

  if (current && body.force) {
    await dockerExec(['rm', '-f', container]);
  } else if (current) {
    await dockerExec(['start', container]);
    registry.fixtures[id] = {
      ...existing,
      id,
      type: 'webdav',
      container,
      server,
      image,
      endpoint,
      endpoint_path: endpointPath,
      port,
      username,
      password,
      root,
      host_dir: hostDir,
      updated_at: new Date().toISOString(),
    };
    return webdavFixtureStatus(registry.fixtures[id]);
  }

  const dockerRunArgs =
    server === 'node-builtin'
      ? [
          'run',
          '-d',
          '--name',
          container,
          '-p',
          `127.0.0.1:${port}:8080`,
          '-e',
          `USERNAME=${username}`,
          '-e',
          `PASSWORD=${password}`,
          '-e',
          'WEBDAV_ROOT=/data',
          '-e',
          'PORT=8080',
          '-v',
          `${hostDir}:/data`,
          image,
          'node',
          '-e',
          NODE_BUILTIN_WEBDAV_SCRIPT,
        ]
      : [
          'run',
          '-d',
          '--name',
          container,
          '-p',
          `127.0.0.1:${port}:80`,
          '-e',
          'AUTH_TYPE=Basic',
          '-e',
          `USERNAME=${username}`,
          '-e',
          `PASSWORD=${password}`,
          '-v',
          `${hostDir}:/var/lib/dav`,
          image,
        ];

  await dockerExec(dockerRunArgs);

  registry.fixtures[id] = {
    id,
    type: 'webdav',
    container,
    server,
    image,
    endpoint,
    endpoint_path: endpointPath,
    port,
    username,
    password,
    root,
    host_dir: hostDir,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return webdavFixtureStatus(registry.fixtures[id]);
}

async function stopWebdavFixture(registry, id, body = {}) {
  const fixture = registry.fixtures[id];
  if (!fixture) throw new Error(`Unknown fixture: ${id}`);
  const info = await dockerContainerInfo(fixture.container);
  if (info?.State?.Running) await dockerExec(['stop', fixture.container]);
  if (body.remove && info) await dockerExec(['rm', '-f', fixture.container]);
  fixture.updated_at = new Date().toISOString();
  await saveRegistry(registry);
  return webdavFixtureStatus(fixture);
}

function appSupportDir(instance) {
  return path.join(instance.home, 'Library', 'Application Support', 'com.deepstudent.app');
}

function imageDir(id) {
  return path.join(IMAGES_DIR, slug(id));
}

function imageDataDir(id) {
  return path.join(imageDir(id), 'data');
}

async function isDirectoryEmpty(dir) {
  try {
    const entries = await fsp.readdir(dir);
    return entries.length === 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function shouldCopyImagePath(sourceRoot, absolute) {
  const relative = path.relative(sourceRoot, absolute);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (parts.includes('Caches')) return false;
  if (parts.includes('Logs')) return false;
  if (relative.includes(`Library${path.sep}Saved Application State`)) return false;
  return true;
}

async function summarizeDirectory(root) {
  const files = await listFilesRecursive(root, { maxDepth: 20 }).catch(() => []);
  return {
    file_count: files.length,
    bytes: files.reduce((sum, file) => sum + Number(file.size || 0), 0),
  };
}

async function rewriteBundleScopedPaths(root, sourceBundleId, targetBundleId) {
  if (!sourceBundleId || !targetBundleId || sourceBundleId === targetBundleId) return [];
  const rewrites = [];

  async function walk(dir) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
    }

    for (const entry of entries) {
      if (!entry.name.includes(sourceBundleId)) continue;
      const from = path.join(dir, entry.name);
      const to = path.join(dir, entry.name.replaceAll(sourceBundleId, targetBundleId));
      if (from === to) continue;
      await fsp.rm(to, { recursive: true, force: true });
      await fsp.rename(from, to);
      rewrites.push({ from, to });
    }
  }

  await walk(root);
  return rewrites;
}

function publicImage(image) {
  if (!image) return image;
  return {
    ...image,
    path: imageDir(image.id),
    data_path: imageDataDir(image.id),
  };
}

function imageSourceDir(instance, scope) {
  if (scope === 'app-data') return appSupportDir(instance);
  if (scope === 'home') return instance.home;
  throw new Error(`Unsupported image scope: ${scope}`);
}

async function createDataImage(registry, body) {
  const id = slug(requireArg(body.id, 'image id is required'));
  const instanceId = requireArg(body.from_instance, 'from_instance is required');
  const instance = registry.instances[instanceId];
  if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
  if (isPidAlive(instance.pid) && !body.live) {
    throw new Error(`Instance ${instanceId} is running. Stop it first, or pass --live to snapshot a running instance.`);
  }

  const scope = body.scope || 'home';
  const source = imageSourceDir(instance, scope);
  if (!fs.existsSync(source)) throw new Error(`Image source does not exist: ${source}`);

  const dir = imageDir(id);
  const dataDir = imageDataDir(id);
  if (fs.existsSync(dir) && !body.force) {
    throw new Error(`Image already exists: ${id}. Use --force to replace it.`);
  }
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.cp(source, dataDir, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: absolute => shouldCopyImagePath(source, absolute),
  });

  const summary = await summarizeDirectory(dataDir);
  const image = {
    id,
    description: body.description || '',
    scope,
    source_instance_id: instanceId,
    source_project_id: instance.project_id,
    source_bundle_id: instance.bundle_id,
    source_device_id: instance.device_id,
    source_home: instance.home,
    source_path: source,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    file_count: summary.file_count,
    bytes: summary.bytes,
    live: Boolean(body.live),
  };
  registry.images[id] = image;
  await writeJson(path.join(dir, 'image.json'), image);
  await saveRegistry(registry);
  return publicImage(image);
}

async function applyDataImage(registry, body) {
  const imageId = slug(requireArg(body.image_id, 'image_id is required'));
  const instanceId = requireArg(body.to_instance, 'to_instance is required');
  const image = registry.images[imageId] || (await readJson(path.join(imageDir(imageId), 'image.json'), null));
  if (!image) throw new Error(`Unknown image: ${imageId}`);
  registry.images[imageId] = image;

  const instance = registry.instances[instanceId];
  if (!instance) throw new Error(`Unknown instance: ${instanceId}`);
  if (isPidAlive(instance.pid)) {
    throw new Error(`Instance ${instanceId} is running. Stop it before applying image ${imageId}.`);
  }

  const source = imageDataDir(imageId);
  if (!fs.existsSync(source)) throw new Error(`Image data does not exist: ${source}`);
  const target = image.scope === 'app-data' ? appSupportDir(instance) : instance.home;
  if (!(await isDirectoryEmpty(target)) && !body.force) {
    throw new Error(`Target data directory is not empty: ${target}. Use --force to replace it.`);
  }

  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(source, target, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });

  const rewrites = image.scope === 'home'
    ? await rewriteBundleScopedPaths(target, image.source_bundle_id, instance.bundle_id)
    : [];

  instance.seed_image_id = imageId;
  instance.seed_image_scope = image.scope;
  instance.seed_image_applied_at = new Date().toISOString();
  instance.updated_at = new Date().toISOString();
  await saveRegistry(registry);

  return {
    ok: true,
    image: publicImage(image),
    instance: publicInstance(instance),
    target,
    bundle_path_rewrites: rewrites,
  };
}

async function removeDataImage(registry, id) {
  const imageId = slug(requireArg(id, 'image id is required'));
  const existing = registry.images[imageId] || null;
  await fsp.rm(imageDir(imageId), { recursive: true, force: true });
  delete registry.images[imageId];
  await saveRegistry(registry);
  return { ok: true, removed: Boolean(existing), image_id: imageId };
}

function slotsDir(instance) {
  return path.join(appSupportDir(instance), 'slots');
}

async function readSlotState(instance) {
  const file = path.join(slotsDir(instance), 'state.json');
  const state = await readJson(file, null);
  return {
    file,
    active: state?.active || 'slotA',
    pending: state?.pending ?? null,
    raw: state,
  };
}

async function resolveSlotName(instance, requested) {
  if (!requested || requested === 'active') {
    const state = await readSlotState(instance);
    return state.active || 'slotA';
  }
  return requested;
}

async function resolveDbFile(instance, slot, dbName) {
  const base = path.join(slotsDir(instance), slot);
  const candidates = [
    path.join(base, `${dbName}.db`),
    path.join(base, 'databases', `${dbName}.db`),
    path.join(base, dbName),
    path.join(base, 'databases', dbName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Database not found for ${instance.id}: slot=${slot} db=${dbName}`);
}

async function sqliteScalar(dbFile, query) {
  const { stdout } = await execFile('sqlite3', ['-batch', '-noheader', dbFile, query]);
  return stdout.trim();
}

async function sqliteTables(dbFile) {
  const raw = await sqliteScalar(dbFile, "select name from sqlite_master where type='table' order by name;");
  return raw ? raw.split(/\r?\n/).filter(Boolean) : [];
}

async function collectSqliteSummary(dbFile) {
  const summary = { file: dbFile, tables: [], counts: {}, error: null };
  try {
    const tables = await sqliteTables(dbFile);
    summary.tables = tables;
    for (const table of ['chat_v2_sessions', 'chat_v2_messages', '__change_log', '__sync_conflicts']) {
      if (!tables.includes(table)) continue;
      summary.counts[table] = Number(await sqliteScalar(dbFile, `select count(*) from ${table};`));
    }
  } catch (error) {
    summary.error = error.message || String(error);
  }
  return summary;
}

async function findCloudCredentialFiles(instance) {
  const roots = [
    appSupportDir(instance),
    path.join(os.homedir(), 'Library', 'Application Support', 'deep-student'),
  ];
  const seen = new Map();
  for (const root of roots) {
    const files = await listFilesRecursive(root, {
      maxDepth: 8,
      filter: absolute => path.basename(absolute) === 'cloud_storage_credentials.enc',
    }).catch(() => []);
    for (const file of files) {
      if (!seen.has(file.absolute)) seen.set(file.absolute, file);
    }
  }
  return [...seen.values()];
}

async function httpGetText(url, timeoutMs = 1000) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', error => resolve({ ok: false, status: null, text: '', error: error.message || String(error) }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: null, text: '', error: 'timeout' });
    });
  });
}

async function collectEvidenceSnapshot(registry, id, options = {}) {
  const instance = registry.instances[id];
  if (!instance) throw new Error(`Unknown instance: ${id}`);
  const publicStatus = publicInstance(instance);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(EVIDENCE_DIR, id, timestamp);
  const tailLinesCount = Math.floor(positiveNumber(options.tail, 300));
  await fsp.mkdir(dir, { recursive: true });

  const slotState = await readSlotState(instance).catch(error => ({ error: error.message || String(error) }));
  const logs = {
    backend: tailText(await readTextIfExists(instance.log_stdout), tailLinesCount),
    stderr: tailText(await readTextIfExists(instance.log_stderr), tailLinesCount),
    frontend: tailText(await readTextIfExists(instance.log_frontend), tailLinesCount),
  };
  await fsp.writeFile(path.join(dir, 'status.json'), `${JSON.stringify(publicStatus, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'computer-use-target.json'), `${JSON.stringify(computerUseTarget(registry, instance), null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'slot-state.json'), `${JSON.stringify(slotState, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'backend.log'), logs.backend);
  await fsp.writeFile(path.join(dir, 'stderr.log'), logs.stderr);
  await fsp.writeFile(path.join(dir, 'frontend.jsonl'), logs.frontend);

  const metrics = instance.metrics_addr ? await httpGetText(`http://${instance.metrics_addr}/metrics`, 1200) : null;
  if (metrics?.text) await fsp.writeFile(path.join(dir, 'metrics.txt'), metrics.text);

  const dbFiles = await listFilesRecursive(slotsDir(instance), {
    maxDepth: 5,
    filter: absolute => absolute.endsWith('.db'),
  }).catch(() => []);
  const sqlite = [];
  for (const file of dbFiles) {
    sqlite.push(await collectSqliteSummary(file.absolute));
  }
  await fsp.writeFile(path.join(dir, 'sqlite-summary.json'), `${JSON.stringify(sqlite, null, 2)}\n`);

  const credentials = await findCloudCredentialFiles(instance);
  await fsp.writeFile(path.join(dir, 'credentials.json'), `${JSON.stringify(credentials, null, 2)}\n`);

  const snapshot = {
    ok: true,
    path: dir,
    instance: publicStatus,
    target: computerUseTarget(registry, instance),
    slot_state: slotState,
    metrics: metrics ? { ok: metrics.ok, status: metrics.status, error: metrics.error } : null,
    sqlite,
    credentials,
    logs: {
      backend: path.join(dir, 'backend.log'),
      stderr: path.join(dir, 'stderr.log'),
      frontend: path.join(dir, 'frontend.jsonl'),
    },
  };
  await fsp.writeFile(path.join(dir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

async function assertSlot(registry, id, body) {
  const instance = registry.instances[id];
  if (!instance) throw new Error(`Unknown instance: ${id}`);
  const state = await readSlotState(instance);
  const expectedActive = body.active;
  const expectedPending = parseNullableSlot(body.pending);
  const failures = [];
  if (expectedActive !== undefined && state.active !== expectedActive) {
    failures.push(`active expected ${expectedActive}, got ${state.active}`);
  }
  if (expectedPending !== undefined && state.pending !== expectedPending) {
    failures.push(`pending expected ${expectedPending}, got ${state.pending}`);
  }
  return { ok: failures.length === 0, failures, state };
}

async function assertSqlite(registry, id, body) {
  const instance = registry.instances[id];
  if (!instance) throw new Error(`Unknown instance: ${id}`);
  const slot = await resolveSlotName(instance, requireArg(body.slot, 'slot is required'));
  const dbFile = await resolveDbFile(instance, slot, requireArg(body.db, 'db is required'));
  const value = await sqliteScalar(dbFile, requireArg(body.query, 'query is required'));
  const expected = body.equals;
  const ok = expected === undefined || String(value) === String(expected);
  return {
    ok,
    failures: ok ? [] : [`query expected ${expected}, got ${value}`],
    instance_id: id,
    slot,
    db: dbFile,
    query: body.query,
    value,
    expected,
  };
}

async function assertCredential(registry, id, body) {
  const instance = registry.instances[id];
  if (!instance) throw new Error(`Unknown instance: ${id}`);
  const expectation = requireArg(body.cloud_storage, 'cloud_storage expectation is required');
  const files = await findCloudCredentialFiles(instance);
  const present = files.length > 0;
  const ok = expectation === 'present' ? present : !present;
  return {
    ok,
    failures: ok ? [] : [`cloud storage credential expected ${expectation}, present=${present}`],
    present,
    files,
  };
}

async function assertWebdavTree(registry, id, body) {
  const fixture = registry.fixtures[id];
  if (!fixture) throw new Error(`Unknown fixture: ${id}`);
  const contains = requireArg(body.contains, 'contains is required').replace(/^\/+/, '');
  const root = path.join(fixture.host_dir, fixture.root);
  const files = await listFilesRecursive(root, { maxDepth: 12 });
  const found = files.some(file => file.path === contains || file.path.endsWith(`/${contains}`));
  return {
    ok: found,
    failures: found ? [] : [`webdav tree does not contain ${contains}`],
    fixture: publicFixture(fixture),
    root,
    contains,
    files,
  };
}

async function plistSetString(plistPath, key, value) {
  if (process.platform !== 'darwin') return;
  const tool = '/usr/libexec/PlistBuddy';
  try {
    await execFile(tool, ['-c', `Set :${key} ${value}`, plistPath]);
  } catch {
    await execFile(tool, ['-c', `Add :${key} string ${value}`, plistPath]);
  }
}

async function patchMacBundle(appPath, instance) {
  if (process.platform !== 'darwin') return;
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  await plistSetString(plistPath, 'CFBundleIdentifier', instance.bundle_id);
  await plistSetString(plistPath, 'CFBundleName', instance.display_name);
  await plistSetString(plistPath, 'CFBundleDisplayName', instance.display_name);
  try {
    await execFile('xattr', ['-dr', 'com.apple.quarantine', appPath]);
  } catch {
    // Best effort only; local debug bundles usually do not need this.
  }
}

async function prepareAppBundle(project, instance) {
  if (fs.existsSync(instance.app_path)) return;
  await fsp.mkdir(path.dirname(instance.app_path), { recursive: true });
  await fsp.cp(project.source_app, instance.app_path, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
  await patchMacBundle(instance.app_path, instance);
}

async function waitForExit(pid, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return !isPidAlive(pid);
}

function publicInstance(instance) {
  const alive = isPidAlive(instance.pid);
  return {
    ...instance,
    state: alive ? 'running' : 'stopped',
    pid: alive ? instance.pid : null,
  };
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function textResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function startInstance(registry, id) {
  const instance = registry.instances[id];
  if (!instance) throw new Error(`Unknown instance: ${id}`);
  const project = registry.projects[instance.project_id];
  if (!project) throw new Error(`Unknown project for instance: ${instance.project_id}`);

  if (isPidAlive(instance.pid)) {
    return publicInstance(instance);
  }

  if (!fs.existsSync(project.source_app)) {
    throw new Error(`Source app does not exist: ${project.source_app}`);
  }

  await prepareAppBundle(project, instance);
  await fsp.mkdir(instance.home, { recursive: true });
  await fsp.mkdir(path.dirname(instance.log_stdout), { recursive: true });

  const stdoutFd = fs.openSync(instance.log_stdout, 'a');
  const stderrFd = fs.openSync(instance.log_stderr, 'a');
  const env = {
    ...process.env,
    ...(project.default_env || {}),
    ...(instance.env || {}),
    HOME: instance.home,
    DEVICE_ID: instance.device_id,
    DSTU_METRICS_ADDR: instance.metrics_addr,
    DSTU_E2E_STANDARD_WINDOW: '1',
    TAURI_LAB_INSTANCE_ID: instance.id,
    TAURI_LAB_LOG_DIR: LOGS_DIR,
    TAURI_LAB_FRONTEND_LOG: instance.log_frontend,
  };

  const child = childProcess.spawn(instance.binary_path, [], {
    cwd: project.cwd,
    env,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
  });
  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  instance.pid = child.pid;
  instance.state = 'running';
  instance.started_at = new Date().toISOString();
  instance.last_error = null;
  await saveRegistry(registry);
  return publicInstance(instance);
}

async function stopInstance(registry, id) {
  const instance = registry.instances[id];
  if (!instance) throw new Error(`Unknown instance: ${id}`);
  const pid = instance.pid;
  if (isPidAlive(pid)) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    const exited = await waitForExit(pid, 5000);
    if (!exited) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      await waitForExit(pid, 1500);
    }
  }
  instance.pid = null;
  instance.state = 'stopped';
  instance.stopped_at = new Date().toISOString();
  await saveRegistry(registry);
  return publicInstance(instance);
}

async function handleApi(req, res, token, server) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/health') {
      jsonResponse(res, 200, { ok: true, pid: process.pid, root: ROOT });
      return;
    }

    if (req.headers['x-tauri-lab-token'] !== token) {
      jsonResponse(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/shutdown') {
      const body = await readRequestJson(req);
      const stoppedInstances = [];
      if (body.with_instances) {
        const registry = await loadRegistry();
        for (const instance of Object.values(registry.instances)) {
          if (!isPidAlive(instance.pid)) continue;
          const stopped = await stopInstance(registry, instance.id);
          stoppedInstances.push({ id: stopped.id, state: stopped.state });
        }
      }
      jsonResponse(res, 200, { ok: true, stopped_instances: stoppedInstances });
      setTimeout(() => server.close(() => process.exit(0)), 50);
      return;
    }

    const registry = await loadRegistry();
    const purgedLeases = purgeExpiredLeases(registry);

    if (req.method === 'POST' && url.pathname === '/v1/projects/register') {
      const body = await readRequestJson(req);
      const id = slug(requireArg(body.id, 'Project id is required'));
      const cwd = path.resolve(requireArg(body.cwd, 'Project cwd is required'));
      const sourceApp = resolveFromCwd(cwd, requireArg(body.source_app, 'Project source_app is required'));
      registry.projects[id] = {
        id,
        name: body.name || id,
        cwd,
        source_app: sourceApp,
        binary_relative_path: body.binary_relative_path || 'Contents/MacOS/deep-student',
        default_env: body.default_env || { RUST_LOG: 'info' },
        registered_at: registry.projects[id]?.registered_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await saveRegistry(registry);
      jsonResponse(res, 200, registry.projects[id]);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/projects') {
      jsonResponse(res, 200, Object.values(registry.projects));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/projects/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const project = registry.projects[id];
      if (!project) throw new Error(`Unknown project: ${id}`);
      jsonResponse(res, 200, project);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/instances/create') {
      const body = await readRequestJson(req);
      const instance = await createInstanceRecord(registry, body);
      if (body.image_id) {
        const applied = await applyDataImage(registry, {
          image_id: body.image_id,
          to_instance: instance.id,
          force: true,
        });
        jsonResponse(res, 200, { ...applied.instance, image_applied: applied });
        return;
      }
      await saveRegistry(registry);
      jsonResponse(res, 200, instance);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/instances') {
      if (purgedLeases) await saveRegistry(registry);
      const instances = Object.values(registry.instances).map(instance => withLease(registry, instance));
      jsonResponse(res, 200, instances);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/instances/stop-all') {
      const stoppedInstances = [];
      for (const instance of Object.values(registry.instances)) {
        if (!isPidAlive(instance.pid)) {
          instance.pid = null;
          instance.state = 'stopped';
          continue;
        }
        const stopped = await stopInstance(registry, instance.id);
        stoppedInstances.push({ id: stopped.id, state: stopped.state });
      }
      await saveRegistry(registry);
      jsonResponse(res, 200, { ok: true, stopped_instances: stoppedInstances });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/pools/create') {
      const body = await readRequestJson(req);
      const projectId = slug(requireArg(body.project_id, 'project_id is required'));
      const poolId = slug(requireArg(body.pool_id, 'pool_id is required'));
      const count = Math.max(1, Math.min(64, Math.floor(positiveNumber(body.count, 1))));
      const project = registry.projects[projectId];
      if (!project) throw new Error(`Unknown project: ${projectId}`);

      const instanceIds = [];
      for (let i = 1; i <= count; i += 1) {
        const label = poolIndexLabel(i, count);
        const instanceId = `${poolId}-${label}`;
        instanceIds.push(instanceId);
        await createInstanceRecord(registry, {
          project_id: projectId,
          profile: instanceId,
          id: instanceId,
          display_name: body.display_prefix ? `${body.display_prefix} ${label}` : undefined,
          bundle_id: body.bundle_prefix
            ? `${body.bundle_prefix}.${label}`
            : `com.tauri-lab.${sanitizeBundlePart(projectId)}.${sanitizeBundlePart(poolId)}.${label}`,
          device_id: body.device_prefix ? `${body.device_prefix}-${label}` : instanceId,
          pool_id: poolId,
          image_id: body.image_id,
        });
        if (body.image_id) {
          await applyDataImage(registry, {
            image_id: body.image_id,
            to_instance: instanceId,
            force: true,
          });
        }
      }

      registry.pools[poolId] = {
        id: poolId,
        project_id: projectId,
        instance_ids: instanceIds,
        created_at: registry.pools[poolId]?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await saveRegistry(registry);
      jsonResponse(res, 200, poolStatus(registry, registry.pools[poolId]));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/images') {
      jsonResponse(res, 200, Object.values(registry.images || {}).map(publicImage));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/images/create') {
      const body = await readRequestJson(req);
      jsonResponse(res, 200, await createDataImage(registry, body));
      return;
    }

    const imageAction = url.pathname.match(/^\/v1\/images\/([^/]+)(?:\/([^/]+))?$/);
    if (imageAction) {
      const id = decodeURIComponent(imageAction[1]);
      const action = imageAction[2] || 'inspect';
      if (req.method === 'GET' && action === 'inspect') {
        const image = registry.images[id] || (await readJson(path.join(imageDir(id), 'image.json'), null));
        if (!image) throw new Error(`Unknown image: ${id}`);
        registry.images[id] = image;
        if (purgedLeases) await saveRegistry(registry);
        jsonResponse(res, 200, publicImage(image));
        return;
      }
      if (req.method === 'POST' && action === 'apply') {
        const body = await readRequestJson(req);
        jsonResponse(res, 200, await applyDataImage(registry, { ...body, image_id: id }));
        return;
      }
      if (req.method === 'POST' && action === 'remove') {
        jsonResponse(res, 200, await removeDataImage(registry, id));
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/v1/pools') {
      if (purgedLeases) await saveRegistry(registry);
      jsonResponse(
        res,
        200,
        Object.values(registry.pools).map(pool => poolStatus(registry, pool)),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/pools/')) {
      if (purgedLeases) await saveRegistry(registry);
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const pool = registry.pools[id];
      if (!pool) throw new Error(`Unknown pool: ${id}`);
      jsonResponse(res, 200, poolStatus(registry, pool));
      return;
    }

    const instanceAction = url.pathname.match(/^\/v1\/instances\/([^/]+)(?:\/([^/]+))?$/);
    if (instanceAction) {
      const id = decodeURIComponent(instanceAction[1]);
      const action = instanceAction[2] || 'status';
      if (req.method === 'GET' && action === 'status') {
        const instance = registry.instances[id];
        if (!instance) throw new Error(`Unknown instance: ${id}`);
        jsonResponse(res, 200, publicInstance(instance));
        return;
      }
      if (req.method === 'POST' && action === 'start') {
        jsonResponse(res, 200, await startInstance(registry, id));
        return;
      }
      if (req.method === 'POST' && action === 'stop') {
        jsonResponse(res, 200, await stopInstance(registry, id));
        return;
      }
      if (req.method === 'POST' && action === 'restart') {
        await stopInstance(registry, id);
        const fresh = await loadRegistry();
        jsonResponse(res, 200, await startInstance(fresh, id));
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/v1/computer-use') {
      if (purgedLeases) await saveRegistry(registry);
      const targets = Object.values(registry.instances).map(instance => computerUseTarget(registry, instance));
      jsonResponse(res, 200, targets);
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/computer-use/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const instance = registry.instances[id];
      if (!instance) throw new Error(`Unknown instance: ${id}`);
      jsonResponse(res, 200, computerUseTarget(registry, instance));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/agents/checkout') {
      const body = await readRequestJson(req);
      const poolId = requireArg(body.pool_id, 'pool_id is required');
      const owner = requireArg(body.owner, 'owner is required');
      const pool = registry.pools[poolId];
      if (!pool) throw new Error(`Unknown pool: ${poolId}`);

      const instance = (pool.instance_ids || [])
        .map(id => registry.instances[id])
        .filter(Boolean)
        .find(candidate => !activeLease(registry, candidate.id));
      if (!instance) {
        jsonResponse(res, 409, { error: 'no free instances in pool', pool_id: poolId });
        return;
      }

      const ttlSeconds = positiveNumber(body.ttl, 3600);
      const now = Date.now();
      const lease = {
        instance_id: instance.id,
        owner,
        purpose: body.purpose || '',
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
      };
      registry.leases[instance.id] = lease;
      await saveRegistry(registry);
      jsonResponse(res, 200, {
        ok: true,
        lease,
        target: computerUseTarget(registry, instance),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/agents/verify') {
      const body = await readRequestJson(req);
      jsonResponse(res, 200, verifyAgentAssignment(registry, body));
      return;
    }

    const agentTargetsAction = url.pathname.match(/^\/v1\/agents\/([^/]+)\/targets$/);
    if (req.method === 'GET' && agentTargetsAction) {
      if (purgedLeases) await saveRegistry(registry);
      const owner = decodeURIComponent(agentTargetsAction[1]);
      jsonResponse(res, 200, agentTargets(registry, owner));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/leases') {
      if (purgedLeases) await saveRegistry(registry);
      jsonResponse(res, 200, Object.values(registry.leases));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/leases/audit') {
      if (purgedLeases) await saveRegistry(registry);
      jsonResponse(res, 200, auditLeases(registry));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/leases/acquire') {
      const body = await readRequestJson(req);
      const instanceId = requireArg(body.instance_id, 'instance_id is required');
      const owner = requireArg(body.owner, 'owner is required');
      const instance = registry.instances[instanceId];
      if (!instance) throw new Error(`Unknown instance: ${instanceId}`);

      const existing = activeLease(registry, instanceId);
      if (existing && existing.owner !== owner && !body.force) {
        jsonResponse(res, 409, { error: 'lease already held', lease: existing });
        return;
      }

      const ttlSeconds = positiveNumber(body.ttl, 3600);
      const now = Date.now();
      const lease = {
        instance_id: instanceId,
        owner,
        purpose: body.purpose || '',
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
      };
      registry.leases[instanceId] = lease;
      await saveRegistry(registry);
      jsonResponse(res, 200, lease);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/leases/release') {
      const body = await readRequestJson(req);
      const instanceId = requireArg(body.instance_id, 'instance_id is required');
      const owner = requireArg(body.owner, 'owner is required');
      const existing = registry.leases[instanceId];

      if (!existing) {
        jsonResponse(res, 200, { ok: true, already_released: true, instance_id: instanceId });
        return;
      }

      if (existing.owner !== owner && !body.force) {
        jsonResponse(res, 409, { error: 'lease owned by another owner', lease: existing });
        return;
      }

      delete registry.leases[instanceId];
      await saveRegistry(registry);
      jsonResponse(res, 200, { ok: true, released: true, instance_id: instanceId });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/fixtures') {
      const fixtures = await Promise.all(
        Object.values(registry.fixtures || {}).map(async fixture => {
          if (fixture.type === 'webdav') return webdavFixtureStatus(fixture);
          return publicFixture(fixture);
        }),
      );
      jsonResponse(res, 200, fixtures);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/fixtures/webdav/start') {
      const body = await readRequestJson(req);
      const fixture = await startWebdavFixture(registry, body);
      await saveRegistry(registry);
      jsonResponse(res, 200, fixture);
      return;
    }

    const fixtureAction = url.pathname.match(/^\/v1\/fixtures\/([^/]+)(?:\/([^/]+))?$/);
    if (fixtureAction) {
      const id = decodeURIComponent(fixtureAction[1]);
      const action = fixtureAction[2] || 'status';
      const fixture = registry.fixtures[id];
      if (!fixture) throw new Error(`Unknown fixture: ${id}`);

      if (req.method === 'GET' && action === 'status') {
        jsonResponse(res, 200, fixture.type === 'webdav' ? await webdavFixtureStatus(fixture) : publicFixture(fixture));
        return;
      }
      if (req.method === 'GET' && action === 'credentials') {
        jsonResponse(res, 200, publicFixture(fixture, { includeSecrets: true }));
        return;
      }
      if (req.method === 'GET' && action === 'tree') {
        const root = fixture.type === 'webdav' ? path.join(fixture.host_dir, fixture.root) : fixture.host_dir;
        const files = await listFilesRecursive(root, { maxDepth: Number(url.searchParams.get('maxDepth') || 12) });
        jsonResponse(res, 200, { fixture: publicFixture(fixture), root, files });
        return;
      }
      if (req.method === 'POST' && action === 'stop') {
        const body = await readRequestJson(req);
        if (fixture.type !== 'webdav') throw new Error(`Unsupported fixture type for stop: ${fixture.type}`);
        jsonResponse(res, 200, await stopWebdavFixture(registry, id, body));
        return;
      }
    }

    const evidenceAction = url.pathname.match(/^\/v1\/evidence\/([^/]+)\/snapshot$/);
    if (req.method === 'POST' && evidenceAction) {
      const id = decodeURIComponent(evidenceAction[1]);
      const body = await readRequestJson(req);
      jsonResponse(res, 200, await collectEvidenceSnapshot(registry, id, body));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/assert/slot') {
      const body = await readRequestJson(req);
      jsonResponse(res, 200, await assertSlot(registry, requireArg(body.instance_id, 'instance_id is required'), body));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/assert/sqlite') {
      const body = await readRequestJson(req);
      jsonResponse(res, 200, await assertSqlite(registry, requireArg(body.instance_id, 'instance_id is required'), body));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/assert/credential') {
      const body = await readRequestJson(req);
      jsonResponse(res, 200, await assertCredential(registry, requireArg(body.instance_id, 'instance_id is required'), body));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/assert/webdav-tree') {
      const body = await readRequestJson(req);
      jsonResponse(res, 200, await assertWebdavTree(registry, requireArg(body.fixture_id, 'fixture_id is required'), body));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/logs/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const kind = url.searchParams.get('kind') || 'backend';
      const tail = Number(url.searchParams.get('tail') || 200);
      const instance = registry.instances[id];
      if (!instance && !(id === 'daemon' || kind === 'daemon')) throw new Error(`Unknown instance: ${id}`);

      const files = [];
      if (kind === 'daemon') {
        files.push(path.join(LOGS_DIR, 'daemon.log'));
      } else if (kind === 'backend' || kind === 'stdout') {
        files.push(instance.log_stdout);
      } else if (kind === 'stderr') {
        files.push(instance.log_stderr);
      } else if (kind === 'frontend') {
        files.push(instance.log_frontend);
      } else if (kind === 'all') {
        files.push(instance.log_stdout, instance.log_stderr, instance.log_frontend);
      } else {
        throw new Error(`Unknown log kind: ${kind}`);
      }

      const chunks = [];
      for (const file of files) {
        let text = '';
        try {
          text = await fsp.readFile(file, 'utf8');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const lines = text.split(/\r?\n/).filter(line => line.length > 0);
        chunks.push(...lines.map(line => `[${path.basename(file)}] ${line}`));
      }
      textResponse(res, 200, `${chunks.slice(Math.max(0, chunks.length - tail)).join('\n')}\n`);
      return;
    }

    jsonResponse(res, 404, { error: 'not found' });
  } catch (error) {
    jsonResponse(res, 500, { error: error.message || String(error), stack: process.env.TAURI_LAB_DEBUG ? error.stack : undefined });
  }
}

async function runDaemon() {
  await ensureBaseDirs();
  const token = await getOrCreateToken();
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.startsWith('/health')) {
      void handleApi(req, res, token, server);
      return;
    }
    apiQueue = apiQueue
      .then(() => handleApi(req, res, token, server))
      .catch(error => {
        if (!res.headersSent) jsonResponse(res, 500, { error: error.message || String(error) });
      });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(DEFAULT_PORT, '127.0.0.1', resolve);
  });
  await writeJson(DAEMON_FILE, {
    pid: process.pid,
    port: DEFAULT_PORT,
    root: ROOT,
    started_at: new Date().toISOString(),
  });
  console.log(`[tauri-lab] daemon listening on 127.0.0.1:${DEFAULT_PORT}`);
}

async function readDaemonInfo() {
  return readJson(DAEMON_FILE, null);
}

function launchAgentDomain() {
  return `gui/${os.userInfo().uid}`;
}

function launchAgentPlist() {
  const nodePath = process.execPath;
  const daemonLog = path.join(LOGS_DIR, 'daemon.launchd.log');
  const daemonErr = path.join(LOGS_DIR, 'daemon.launchd.err.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCH_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(__filename)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TAURI_LAB_HOME</key>
    <string>${xmlEscape(ROOT)}</string>
    <key>TAURI_LAB_PORT</key>
    <string>${xmlEscape(String(DEFAULT_PORT))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(path.dirname(__filename))}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(daemonLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(daemonErr)}</string>
</dict>
</plist>
`;
}

async function launchAgentStatus() {
  if (process.platform !== 'darwin') {
    return { supported: false, installed: false, path: LAUNCH_AGENT_PLIST };
  }
  const installed = fs.existsSync(LAUNCH_AGENT_PLIST);
  let loaded = false;
  let detail = '';
  try {
    const { stdout } = await execFile('launchctl', ['print', `${launchAgentDomain()}/${LAUNCH_AGENT_LABEL}`]);
    loaded = true;
    detail = stdout.split(/\r?\n/).slice(0, 8).join('\n');
  } catch (error) {
    detail = String(error.stderr || error.message || '').trim();
  }
  return { supported: true, installed, loaded, path: LAUNCH_AGENT_PLIST, detail };
}

async function installLaunchAgent(flags) {
  if (process.platform !== 'darwin') throw new Error('LaunchAgent install is only supported on macOS.');
  await ensureBaseDirs();
  await fsp.mkdir(path.dirname(LAUNCH_AGENT_PLIST), { recursive: true });
  await fsp.writeFile(LAUNCH_AGENT_PLIST, launchAgentPlist(), { mode: 0o644 });
  const existing = await health();
  let bootstrapped = false;
  let bootstrap_error = null;
  let already_running = false;
  if (flags.start && existing?.ok) {
    already_running = true;
  } else if (flags.start) {
    try {
      await execFile('launchctl', ['bootout', launchAgentDomain(), LAUNCH_AGENT_PLIST]);
    } catch {
      // Not loaded yet.
    }
    try {
      await execFile('launchctl', ['bootstrap', launchAgentDomain(), LAUNCH_AGENT_PLIST]);
      bootstrapped = true;
    } catch (error) {
      bootstrap_error = String(error.stderr || error.message || error).trim();
    }
  }
  const result = {
    ok: !bootstrap_error,
    installed: true,
    bootstrapped,
    already_running,
    bootstrap_error,
    launch_agent: await launchAgentStatus(),
  };
  print(result, flags);
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function uninstallLaunchAgent(flags) {
  if (process.platform !== 'darwin') throw new Error('LaunchAgent uninstall is only supported on macOS.');
  let bootout_error = null;
  if (flags.stop) {
    try {
      await execFile('launchctl', ['bootout', launchAgentDomain(), LAUNCH_AGENT_PLIST]);
    } catch (error) {
      bootout_error = String(error.stderr || error.message || error).trim();
    }
  }
  try {
    await fsp.unlink(LAUNCH_AGENT_PLIST);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const result = {
    ok: true,
    installed: false,
    bootout_error,
    launch_agent: await launchAgentStatus(),
  };
  print(result, flags);
  return result;
}

async function api(method, pathname, body = undefined, expectText = false) {
  const info = await readDaemonInfo();
  if (!info?.port) throw new Error('tauri-lab daemon is not running. Run: tauri-lab service start, or add --ensure-service.');
  const token = (await fsp.readFile(TOKEN_FILE, 'utf8')).trim();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: info.port,
        method,
        path: pathname,
        headers: {
          'x-tauri-lab-token': token,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            try {
              reject(new Error(JSON.parse(raw).error || raw));
            } catch {
              reject(new Error(raw || `HTTP ${res.statusCode}`));
            }
            return;
          }
          if (expectText) {
            resolve(raw);
            return;
          }
          resolve(raw ? JSON.parse(raw) : null);
        });
      },
    );
    req.on('error', error => {
      if (error?.code === 'ECONNREFUSED') {
        reject(
          new Error(
            `tauri-lab daemon is not running on 127.0.0.1:${info.port}. Run: tauri-lab service start, or add --ensure-service.`,
          ),
        );
        return;
      }
      reject(error);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function health() {
  const info = await readDaemonInfo();
  if (!info?.port) return null;
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${info.port}/health`, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpGetOk(url, timeoutMs = 1000) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForInstance(id, flags) {
  const timeoutMs = positiveNumber(flags.timeout, 30) * 1000;
  const requireMetrics = Boolean(flags.metrics);
  const started = Date.now();
  let lastStatus = null;

  while (Date.now() - started < timeoutMs) {
    lastStatus = await api('GET', `/v1/instances/${encodeURIComponent(id)}`);
    const running = lastStatus.state === 'running' && lastStatus.pid;
    if (running && !requireMetrics) {
      return { ok: true, ready: true, waited_ms: Date.now() - started, metrics_ready: null, instance: lastStatus };
    }

    if (running && requireMetrics && lastStatus.metrics_addr) {
      const metricsReady = await httpGetOk(`http://${lastStatus.metrics_addr}/metrics`, 1000);
      if (metricsReady) {
        return { ok: true, ready: true, waited_ms: Date.now() - started, metrics_ready: true, instance: lastStatus };
      }
    }

    await sleep(250);
  }

  return {
    ok: false,
    ready: false,
    waited_ms: Date.now() - started,
    metrics_ready: false,
    instance: lastStatus,
  };
}

async function runPoolInstances(poolId, action, flags) {
  const pool = await api('GET', `/v1/pools/${encodeURIComponent(poolId)}`);
  const concurrency = Math.max(1, Math.floor(positiveNumber(flags.concurrency, 4)));
  const results = await runWithConcurrency(pool.instance_ids || [], concurrency, async id => {
    const result = await api('POST', `/v1/instances/${encodeURIComponent(id)}/${action}`, {});
    if (flags.wait && ['start', 'restart'].includes(action)) {
      return { ...result, wait: await waitForInstance(id, flags) };
    }
    return result;
  });
  return { ok: true, pool_id: poolId, action, concurrency, results };
}

async function startService(flags) {
  await ensureBaseDirs();
  const existing = await health();
  if (existing?.ok) {
    const result = { ok: true, already_running: true, ...existing };
    if (!flags.quiet) print(result, flags);
    return result;
  }

  const out = fs.openSync(path.join(LOGS_DIR, 'daemon.log'), 'a');
  const child = childProcess.spawn(process.execPath, [__filename, 'daemon', 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, TAURI_LAB_PORT: String(DEFAULT_PORT), TAURI_LAB_HOME: ROOT },
  });
  child.unref();
  fs.closeSync(out);

  const started = Date.now();
  while (Date.now() - started < 5000) {
    await new Promise(resolve => setTimeout(resolve, 150));
    const ok = await health();
    if (ok?.ok) {
      const result = { ok: true, started: true, ...ok };
      if (!flags.quiet) print(result, flags);
      return result;
    }
  }
  throw new Error(`daemon did not become healthy; see ${path.join(LOGS_DIR, 'daemon.log')}`);
}

async function stopService(flags) {
  const status = await health();
  if (!status?.ok) {
    const result = { ok: true, already_stopped: true };
    if (!flags.quiet) print(result, flags);
    return result;
  }
  const stopped = await api('POST', '/shutdown', {
    with_instances: Boolean(flags['with-instances'] || flags.force),
  });
  const result = { ok: true, stopped: true, ...stopped };
  if (!flags.quiet) print(result, flags);
  return result;
}

async function restartService(flags) {
  await stopService({ ...flags, quiet: true });
  await new Promise(resolve => setTimeout(resolve, 250));
  return startService(flags);
}

async function ensureServiceForCommand(flags) {
  const status = await health();
  if (status?.ok) return;
  if (flags['ensure-service']) {
    await startService({ ...flags, quiet: true });
    return;
  }
  throw new Error('tauri-lab daemon is not running. Run: tauri-lab service start, or add --ensure-service.');
}

function print(value, flags = {}) {
  if (flags.json || typeof value !== 'object') {
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const { positionals, flags } = parseArgv(process.argv.slice(2));
  const [group, command, ...rest] = positionals;

  if (!group || flags.help || group === 'help') {
    usage();
    return;
  }

  if (group === 'daemon' && command === 'run') {
    await runDaemon();
    return;
  }

  if (group === 'service') {
    if (command === 'start') return startService(flags);
    if (command === 'restart') return restartService(flags);
    if (command === 'install') return installLaunchAgent(flags);
    if (command === 'uninstall') return uninstallLaunchAgent(flags);
    if (command === 'status') {
      const status = await health();
      print(
        {
          ...(status?.ok ? status : { ok: false, state: 'stopped', root: ROOT }),
          launch_agent: await launchAgentStatus(),
        },
        flags,
      );
      return;
    }
    if (command === 'stop') return stopService(flags);
  }

  const daemonBackedGroups = new Set([
    'project',
    'instance',
    'pool',
    'computer-use',
    'agent',
    'lease',
    'logs',
    'fixture',
    'image',
    'evidence',
    'assert',
  ]);
  if (daemonBackedGroups.has(group)) await ensureServiceForCommand(flags);

  if (group === 'project') {
    if (command === 'register') {
      const id = requireArg(rest[0], 'Project id is required');
      const body = {
        id,
        name: flags.name,
        cwd: requireArg(flags.cwd, '--cwd is required'),
        source_app: requireArg(flags['source-app'], '--source-app is required'),
        binary_relative_path: flags['binary-relative-path'],
      };
      print(await api('POST', '/v1/projects/register', body), flags);
      return;
    }
    if (command === 'list') {
      print(await api('GET', '/v1/projects'), flags);
      return;
    }
    if (command === 'inspect') {
      const id = requireArg(rest[0], 'Project id is required');
      print(await api('GET', `/v1/projects/${encodeURIComponent(id)}`), flags);
      return;
    }
  }

  if (group === 'instance') {
    if (command === 'create') {
      const [projectId, profile] = rest;
      const body = {
        project_id: requireArg(projectId, 'Project id is required'),
        profile: requireArg(profile, 'Profile is required'),
        id: flags.id,
        display_name: flags['display-name'],
        bundle_id: flags['bundle-id'],
        device_id: flags['device-id'],
        metrics_addr: flags['metrics-addr'],
        home: flags.home,
        image_id: flags.image,
      };
      print(await api('POST', '/v1/instances/create', body), flags);
      return;
    }
    if (command === 'list') {
      print(await api('GET', '/v1/instances'), flags);
      return;
    }
    if (command === 'stop-all') {
      print(await api('POST', '/v1/instances/stop-all', {}), flags);
      return;
    }
    if (['start', 'stop', 'restart'].includes(command)) {
      const id = requireArg(rest[0], 'Instance id is required');
      const result = await api('POST', `/v1/instances/${encodeURIComponent(id)}/${command}`, {});
      if (flags.wait && ['start', 'restart'].includes(command)) {
        const waitResult = await waitForInstance(id, flags);
        print({ ...result, wait: waitResult }, flags);
        if (!waitResult.ready) process.exitCode = 1;
        return;
      }
      print(result, flags);
      return;
    }
    if (command === 'wait') {
      const id = requireArg(rest[0], 'Instance id is required');
      const result = await waitForInstance(id, flags);
      print(result, flags);
      if (!result.ready) process.exitCode = 1;
      return;
    }
    if (command === 'status') {
      const id = requireArg(rest[0], 'Instance id is required');
      print(await api('GET', `/v1/instances/${encodeURIComponent(id)}`), flags);
      return;
    }
  }

  if (group === 'computer-use') {
    if (command === 'list') {
      print(await api('GET', '/v1/computer-use'), flags);
      return;
    }
    if (command === 'target') {
      const id = requireArg(rest[0], 'Instance id is required');
      print(await api('GET', `/v1/computer-use/${encodeURIComponent(id)}`), flags);
      return;
    }
  }

  if (group === 'pool') {
    if (command === 'create') {
      const [projectId, poolId] = rest;
      print(
        await api('POST', '/v1/pools/create', {
          project_id: requireArg(projectId, 'Project id is required'),
          pool_id: requireArg(poolId, 'Pool id is required'),
          count: requireArg(flags.count, '--count is required'),
          display_prefix: flags['display-prefix'],
          bundle_prefix: flags['bundle-prefix'],
          device_prefix: flags['device-prefix'],
          image_id: flags.image,
        }),
        flags,
      );
      return;
    }
    if (command === 'list') {
      print(await api('GET', '/v1/pools'), flags);
      return;
    }
    if (command === 'status') {
      const poolId = requireArg(rest[0], 'Pool id is required');
      print(await api('GET', `/v1/pools/${encodeURIComponent(poolId)}`), flags);
      return;
    }
    if (['start', 'stop', 'restart'].includes(command)) {
      const poolId = requireArg(rest[0], 'Pool id is required');
      const result = await runPoolInstances(poolId, command, flags);
      print(result, flags);
      if (result.results?.some(item => item?.wait && !item.wait.ready)) process.exitCode = 1;
      return;
    }
  }

  if (group === 'agent') {
    if (command === 'checkout') {
      const poolId = requireArg(rest[0], 'Pool id is required');
      const checkout = await api('POST', '/v1/agents/checkout', {
        pool_id: poolId,
        owner: requireArg(flags.owner, '--owner is required'),
        purpose: flags.purpose,
        ttl: flags.ttl,
      });
      if (flags.start) {
        const started = await api('POST', `/v1/instances/${encodeURIComponent(checkout.lease.instance_id)}/start`, {});
        checkout.started = started;
        if (flags.wait) checkout.wait = await waitForInstance(checkout.lease.instance_id, flags);
      }
      print(checkout, flags);
      if (checkout.wait && !checkout.wait.ready) process.exitCode = 1;
      return;
    }
    if (command === 'targets') {
      const owner = requireArg(flags.owner, '--owner is required');
      print(await api('GET', `/v1/agents/${encodeURIComponent(owner)}/targets`), flags);
      return;
    }
    if (command === 'verify') {
      const instanceId = requireArg(rest[0] || flags.instance, 'Instance id is required');
      const result = await api('POST', '/v1/agents/verify', {
        instance_id: instanceId,
        owner: requireArg(flags.owner, '--owner is required'),
        app: flags.app,
        require_running: Boolean(flags['require-running']),
      });
      print(result, flags);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === 'release') {
      const instanceId = requireArg(rest[0], 'Instance id is required');
      print(
        await api('POST', '/v1/leases/release', {
          instance_id: instanceId,
          owner: requireArg(flags.owner, '--owner is required'),
          force: Boolean(flags.force),
        }),
        flags,
      );
      return;
    }
  }

  if (group === 'lease') {
    if (command === 'list') {
      print(await api('GET', '/v1/leases'), flags);
      return;
    }
    if (command === 'audit') {
      const result = await api('GET', '/v1/leases/audit');
      print(result, flags);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === 'clear') {
      if (!flags.owner && !flags.pool && !flags.force) {
        throw new Error('lease clear requires --owner, --pool, or --force');
      }
      const leases = await api('GET', '/v1/leases');
      const instances = await api('GET', '/v1/instances');
      const instanceById = new Map(instances.map(instance => [instance.id, instance]));
      const selected = leases.filter(lease => {
        if (flags.owner && lease.owner !== flags.owner) return false;
        if (flags.pool && instanceById.get(lease.instance_id)?.pool_id !== flags.pool) return false;
        return true;
      });
      const released = [];
      for (const lease of selected) {
        const result = await api('POST', '/v1/leases/release', {
          instance_id: lease.instance_id,
          owner: lease.owner,
          force: Boolean(flags.force),
        });
        released.push({ ...result, owner: lease.owner });
      }
      print(
        {
          ok: true,
          selected_count: selected.length,
          released_count: released.filter(item => item.released || item.already_released).length,
          released,
        },
        flags,
      );
      return;
    }
    if (command === 'acquire') {
      const instanceId = requireArg(rest[0], 'Instance id is required');
      print(
        await api('POST', '/v1/leases/acquire', {
          instance_id: instanceId,
          owner: requireArg(flags.owner, '--owner is required'),
          purpose: flags.purpose,
          ttl: flags.ttl,
          force: Boolean(flags.force),
        }),
        flags,
      );
      return;
    }
    if (command === 'release') {
      const instanceId = requireArg(rest[0], 'Instance id is required');
      print(
        await api('POST', '/v1/leases/release', {
          instance_id: instanceId,
          owner: requireArg(flags.owner, '--owner is required'),
          force: Boolean(flags.force),
        }),
        flags,
      );
      return;
    }
  }

  if (group === 'logs') {
    const id = requireArg(command, 'Instance id is required');
    const tail = Number(flags.tail || 200);
    const kind = flags.kind || 'backend';
    const text = await api(
      'GET',
      `/v1/logs/${encodeURIComponent(id)}?tail=${tail}&kind=${encodeURIComponent(kind)}`,
      undefined,
      true,
    );
    process.stdout.write(text);
    return;
  }

  if (group === 'fixture') {
    if (command === 'list') {
      print(await api('GET', '/v1/fixtures'), flags);
      return;
    }
    if (command === 'webdav') {
      const [action, id] = rest;
      const fixtureId = requireArg(id, 'Fixture id is required');
      if (action === 'start') {
        print(
          await api('POST', '/v1/fixtures/webdav/start', {
            id: fixtureId,
            port: flags.port,
            username: flags.username,
            password: flags.password,
            root: flags.root,
            host_dir: flags['host-dir'],
            container: flags.container,
            image: flags.image,
            server: flags.server,
            endpoint_path: flags['endpoint-path'],
            force: Boolean(flags.force),
          }),
          flags,
        );
        return;
      }
      if (action === 'stop') {
        print(
          await api('POST', `/v1/fixtures/${encodeURIComponent(fixtureId)}/stop`, {
            remove: Boolean(flags.remove),
          }),
          flags,
        );
        return;
      }
      if (action === 'status') {
        print(await api('GET', `/v1/fixtures/${encodeURIComponent(fixtureId)}/status`), flags);
        return;
      }
      if (action === 'tree') {
        print(await api('GET', `/v1/fixtures/${encodeURIComponent(fixtureId)}/tree`), flags);
        return;
      }
      if (action === 'credentials') {
        print(await api('GET', `/v1/fixtures/${encodeURIComponent(fixtureId)}/credentials`), flags);
        return;
      }
    }
  }

  if (group === 'image') {
    if (command === 'list') {
      print(await api('GET', '/v1/images'), flags);
      return;
    }
    if (command === 'create') {
      const id = requireArg(rest[0], 'Image id is required');
      print(
        await api('POST', '/v1/images/create', {
          id,
          from_instance: requireArg(flags['from-instance'], '--from-instance is required'),
          scope: flags.scope || 'home',
          description: flags.description,
          force: Boolean(flags.force),
          live: Boolean(flags.live),
        }),
        flags,
      );
      return;
    }
    if (command === 'inspect') {
      const id = requireArg(rest[0], 'Image id is required');
      print(await api('GET', `/v1/images/${encodeURIComponent(id)}`), flags);
      return;
    }
    if (command === 'apply') {
      const id = requireArg(rest[0], 'Image id is required');
      print(
        await api('POST', `/v1/images/${encodeURIComponent(id)}/apply`, {
          to_instance: requireArg(flags['to-instance'], '--to-instance is required'),
          force: Boolean(flags.force),
        }),
        flags,
      );
      return;
    }
    if (command === 'remove') {
      const id = requireArg(rest[0], 'Image id is required');
      print(await api('POST', `/v1/images/${encodeURIComponent(id)}/remove`, {}), flags);
      return;
    }
  }

  if (group === 'evidence') {
    if (command === 'snapshot') {
      const id = requireArg(rest[0], 'Instance id is required');
      print(
        await api('POST', `/v1/evidence/${encodeURIComponent(id)}/snapshot`, {
          tail: flags.tail,
        }),
        flags,
      );
      return;
    }
  }

  if (group === 'assert') {
    let result = null;
    if (command === 'slot') {
      const id = requireArg(rest[0], 'Instance id is required');
      result = await api('POST', '/v1/assert/slot', {
        instance_id: id,
        active: flags.active,
        pending: flags.pending,
      });
    } else if (command === 'sqlite') {
      const id = requireArg(rest[0], 'Instance id is required');
      result = await api('POST', '/v1/assert/sqlite', {
        instance_id: id,
        slot: flags.slot,
        db: flags.db,
        query: flags.query,
        equals: flags.equals,
      });
    } else if (command === 'credential') {
      const id = requireArg(rest[0], 'Instance id is required');
      result = await api('POST', '/v1/assert/credential', {
        instance_id: id,
        cloud_storage: flags['cloud-storage'],
      });
    } else if (command === 'webdav-tree') {
      const id = requireArg(rest[0], 'Fixture id is required');
      result = await api('POST', '/v1/assert/webdav-tree', {
        fixture_id: id,
        contains: flags.contains,
      });
    }

    if (result) {
      print(result, flags);
      if (!result.ok) process.exitCode = 1;
      return;
    }
  }

  usage();
  process.exitCode = 1;
}

main().catch(error => {
  console.error(`tauri-lab: ${error.message || error}`);
  if (process.env.TAURI_LAB_DEBUG && error.stack) console.error(error.stack);
  process.exit(1);
});
