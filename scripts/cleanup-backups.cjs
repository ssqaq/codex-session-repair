#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.CODEX_ROOT || 'C:/Users/Administrator/.codex';
const SCRIPT_DIR = __dirname;
const MODE = process.argv[2];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function fail(message) {
  throw new Error(message);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function readManifest(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { manifest, manifestPath, manifestSha256: sha256File(manifestPath) };
  } catch {
    return { manifest: null, manifestPath, manifestSha256: null };
  }
}

function candidateDirs(root, prefix) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(root, entry.name));
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

function timeOf(manifest, dir) {
  const value = manifest.completedAt || manifest.checkedAt || manifest.startedAt;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fs.statSync(dir).mtimeMs;
}

function discover() {
  const groups = [];
  for (const [kind, root, prefix, validStatuses, threadReader] of [
    ['bulk', SCRIPT_DIR, 'run-', new Set(['complete']), (m) => (m.targetRows || []).map((row) => row.id)],
    ['projection', SCRIPT_DIR, 'projection-run-', new Set(['validated']), (m) => (m.threads || []).map((row) => row.id)],
    ['archived-delete', path.join(ROOT, 'backups'), 'archived-delete-', new Set(['complete']), (m) => m.threadIds || []],
  ]) {
    for (const dir of candidateDirs(root, prefix)) {
      const loaded = readManifest(dir);
      if (!loaded) continue;
      const { manifest, manifestPath, manifestSha256 } = loaded;
      const threadIds = manifest ? [...new Set(threadReader(manifest).filter((id) => UUID_RE.test(id)))] : [];
      groups.push({
        kind,
        dir,
        name: path.basename(dir),
        manifestPath,
        manifestSha256,
        status: manifest?.status || 'invalid',
        valid: Boolean(manifest && validStatuses.has(manifest.status) && threadIds.length),
        threadIds,
        time: manifest ? timeOf(manifest, dir) : fs.statSync(dir).mtimeMs,
        bytes: dirBytes(dir),
      });
    }
  }
  return groups;
}

function planCleanup(groups) {
  const latestByThread = new Map();
  for (const group of groups.filter((item) => item.valid)) {
    for (const threadId of group.threadIds) {
      const previous = latestByThread.get(`${group.kind}:${threadId}`);
      if (!previous || group.time > previous.time || (group.time === previous.time && group.name > previous.name)) {
        latestByThread.set(`${group.kind}:${threadId}`, group);
      }
    }
  }
  const retained = [];
  const deleted = [];
  for (const group of groups) {
    const keepFor = group.threadIds.filter((id) => latestByThread.get(`${group.kind}:${id}`)?.dir === group.dir);
    const keep = group.valid && keepFor.length > 0;
    const item = { ...group, keepFor, reason: keep ? '每个会话保留最新备份' : (group.valid ? '同一会话有更新的备份' : '无效或未完成的旧备份') };
    (keep ? retained : deleted).push(item);
  }
  return { latestByThread, retained, deleted };
}

function publicItem(item) {
  return {
    kind: item.kind,
    name: item.name,
    path: item.dir,
    status: item.status,
    threadIds: item.threadIds,
    keepFor: item.keepFor,
    bytes: item.bytes,
    manifestSha256: item.manifestSha256,
    reason: item.reason,
  };
}

function assertSafeDirectory(dir) {
  const resolved = path.resolve(dir);
  const scriptBackup = path.dirname(resolved) === path.resolve(SCRIPT_DIR) && /^(run|projection-run)-/.test(path.basename(resolved));
  const archivedBackup = path.dirname(resolved) === path.resolve(ROOT, 'backups') && /^archived-delete-/.test(path.basename(resolved));
  if (!scriptBackup && !archivedBackup) {
    fail(`拒绝删除非备份目录：${dir}`);
  }
}

function runDryRun() {
  const groups = discover();
  const plan = planCleanup(groups);
  const result = {
    mode: 'dry-run',
    status: 'planned',
    scriptDirectory: SCRIPT_DIR,
    scannedDirectories: groups.length,
    retainedDirectories: plan.retained.length,
    deletableDirectories: plan.deleted.length,
    retainedBytes: plan.retained.reduce((sum, item) => sum + item.bytes, 0),
    deletableBytes: plan.deleted.reduce((sum, item) => sum + item.bytes, 0),
    retained: plan.retained.map(publicItem),
    deleted: plan.deleted.map(publicItem),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function runApply() {
  const groups = discover();
  const plan = planCleanup(groups);
  if (!plan.deleted.length) {
    process.stdout.write(`${JSON.stringify({ mode: 'apply', status: 'nothing-to-delete', scannedDirectories: groups.length }, null, 2)}\n`);
    return;
  }
  const cleanupDir = path.join(SCRIPT_DIR, `cleanup-run-${timestamp()}`);
  fs.mkdirSync(cleanupDir, { recursive: false });
  const manifestPath = path.join(cleanupDir, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    mode: 'cleanup-backups',
    status: 'planned',
    createdAt: new Date().toISOString(),
    scriptDirectory: SCRIPT_DIR,
    retained: plan.retained.map(publicItem),
    deleted: plan.deleted.map(publicItem),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  try {
    for (const item of plan.deleted) {
      assertSafeDirectory(item.dir);
      const current = readManifest(item.dir);
      if (!current || current.manifestSha256 !== item.manifestSha256) {
        fail(`备份目录在删除前发生变化：${item.dir}`);
      }
      fs.rmSync(item.dir, { recursive: true, force: false });
    }
    const remaining = discover();
    const remainingDirs = new Set(remaining.map((item) => item.dir));
    const failed = plan.deleted.filter((item) => remainingDirs.has(item.dir));
    if (failed.length) fail(`仍有旧备份未删除：${failed.map((item) => item.name).join(', ')}`);
    manifest.status = 'complete';
    manifest.completedAt = new Date().toISOString();
    manifest.deletedBytes = plan.deleted.reduce((sum, item) => sum + item.bytes, 0);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    process.stdout.write(`${JSON.stringify({ mode: 'apply', status: manifest.status, manifestPath, deletedDirectories: plan.deleted.length, deletedBytes: manifest.deletedBytes, retainedDirectories: plan.retained.length }, null, 2)}\n`);
  } catch (error) {
    manifest.status = 'failed';
    manifest.failure = error.stack || error.message;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    throw error;
  }
}

function main() {
  if (MODE === '--dry-run') return runDryRun();
  if (MODE === '--apply') return runApply();
  process.stderr.write('用法：node cleanup-backups.cjs --dry-run | --apply\n');
  process.exitCode = 2;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
