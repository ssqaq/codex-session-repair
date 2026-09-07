#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(process.env.CODEX_ROOT || 'C:/Users/Administrator/.codex');
const STATE_DB = path.join(ROOT, 'state_5.sqlite');
const HISTORY_DB = path.join(ROOT, 'thread_history_1.sqlite');
const ARCHIVE_DIR = path.join(ROOT, 'archived_sessions');
const INDEX_FILE = path.join(ROOT, 'session_index.jsonl');
const MODE = process.argv[2];
const MANIFEST_ARG = process.argv[3];

function fail(message) { throw new Error(message); }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z'); }
function sqlQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function inList(values) { return values.map(sqlQuote).join(','); }
function chunks(values, size = 20) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
function sqliteJson(query, database) {
  const out = execFileSync('sqlite3', ['-cmd', '.timeout 60000', '-json', database, query], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}
function sqliteExec(query, database) {
  return execFileSync('sqlite3', ['-cmd', '.timeout 60000', database, query], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).trim();
}
function integrity(database) {
  const rows = sqliteJson('PRAGMA integrity_check;', database);
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') fail(`SQLite 完整性检查失败：${database}`);
  return 'ok';
}
function sha256Text(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function backupDatabase(source, destination) {
  const normalized = destination.replaceAll('\\', '/').replaceAll("'", "''");
  execFileSync('sqlite3', ['-cmd', '.timeout 60000', source, `.backup '${normalized}'`], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const stat = fs.statSync(destination);
  if (!stat.isFile() || stat.size === 0) fail(`SQLite 备份为空：${destination}`);
  integrity(destination);
  return stat.size;
}
function databaseCounts(database, tables, ids) {
  const counts = Object.fromEntries(tables.map((table) => [table, 0]));
  for (const batch of chunks(ids)) {
    const list = inList(batch);
    for (const table of tables) {
      counts[table] += sqliteJson(`SELECT count(*) AS count FROM ${table} WHERE thread_id IN (${list});`, database)[0]?.count || 0;
    }
  }
  return counts;
}
function tableCount(database, table) {
  return sqliteJson(`SELECT count(*) AS count FROM ${table};`, database)[0]?.count || 0;
}
function listArchiveFiles() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  const entries = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true });
  if (entries.some((entry) => entry.isDirectory())) fail(`归档目录里有子目录，拒绝递归删除：${ARCHIVE_DIR}`);
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(ARCHIVE_DIR, entry.name));
}
function archiveSnapshot(files) {
  return files.map((file) => {
    const stat = fs.statSync(file);
    return `${path.basename(file)}\0${stat.size}\0${stat.mtimeMs}`;
  }).sort();
}
function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function verifyArchiveBackup(archiveBackup, files) {
  const expected = files.map((file) => path.basename(file)).sort();
  const listed = execFileSync('tar', ['-tzf', archiveBackup], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split(/\r?\n/).map((entry) => entry.replace(/^\.\//, '')).filter((entry) => entry && entry !== '.').sort();
  if (!sameStrings(expected, listed)) fail(`归档文件备份内容不完整：预计 ${expected.length} 份，实际 ${listed.length} 份。`);
}
function readIndex(archivedIds) {
  if (!fs.existsSync(INDEX_FILE)) return { totalLines: 0, matchedLines: 0, matchedHash: sha256Text(''), bytes: 0, raw: Buffer.alloc(0), kept: Buffer.alloc(0) };
  const raw = fs.readFileSync(INDEX_FILE);
  const chunks = raw.toString('utf8').split(/(?<=\n)/);
  const kept = [];
  const matched = [];
  let matchedLines = 0;
  for (const chunk of chunks) {
    if (!chunk) continue;
    let id = null;
    try { id = JSON.parse(chunk).id; } catch { /* 保留无法解析的旧行，避免误删。 */ }
    if (id && archivedIds.has(id)) { matchedLines += 1; matched.push(chunk); }
    else kept.push(chunk);
  }
  return { totalLines: chunks.filter(Boolean).length, matchedLines, matchedHash: sha256Text(matched.join('')), bytes: raw.length, raw, kept: Buffer.from(kept.join(''), 'utf8') };
}
function idHash(rows) { return sha256Text(rows.map((row) => row.id).sort().join('\n')); }
function archivedRows(database = STATE_DB) {
  return sqliteJson('SELECT id, rollout_path, archived, updated_at, archived_at FROM threads WHERE archived=1 ORDER BY id;', database);
}
function unarchivedRows(database = STATE_DB) {
  return sqliteJson('SELECT id FROM threads WHERE archived=0 ORDER BY id;', database);
}
function verifyPaths(rows, files) {
  const archiveRoot = `${path.resolve(ARCHIVE_DIR)}${path.sep}`;
  for (const row of rows) {
    const resolved = path.resolve(row.rollout_path);
    if (!resolved.startsWith(archiveRoot)) fail(`归档会话路径不在 archived_sessions 内：${row.id}`);
  }
  const ids = new Set(rows.map((row) => row.id));
  for (const file of files) {
    const name = path.basename(file);
    const found = [...ids].some((id) => name.includes(id));
    if (!found) fail(`归档目录存在未关联会话文件，拒绝删除：${name}`);
  }
}
function preflight() {
  if (!fs.existsSync(STATE_DB) || !fs.existsSync(HISTORY_DB)) fail('Codex 数据库不完整。');
  integrity(STATE_DB); integrity(HISTORY_DB);
  const rows = archivedRows();
  const ids = rows.map((row) => row.id);
  const idSet = new Set(ids);
  const files = listArchiveFiles();
  verifyPaths(rows, files);
  const index = readIndex(idSet);
  const historyTables = ['thread_items', 'thread_turns', 'thread_realtime_items', 'thread_history_projection_state'];
  const historyCounts = databaseCounts(HISTORY_DB, historyTables, ids);
  const edgeRows = sqliteJson('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges;', STATE_DB);
  const edgeCount = edgeRows.filter((edge) => idSet.has(edge.parent_thread_id) || idSet.has(edge.child_thread_id)).length;
  const stateTableCounts = { threads: rows.length, thread_spawn_edges: edgeCount };
  const unarchived = unarchivedRows();
  return {
    rows, ids, idSet, files, fileSnapshot: archiveSnapshot(files), index, historyCounts, stateTableCounts,
    before: {
      stateBytes: fs.statSync(STATE_DB).size,
      historyBytes: fs.statSync(HISTORY_DB).size,
      archiveBytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0),
      archivedThreads: rows.length,
      unarchivedThreads: unarchived.length,
      unarchivedIds: unarchived.map((row) => row.id),
      unarchivedIdHash: idHash(unarchived),
      historyTableCounts: Object.fromEntries(historyTables.map((table) => [table, tableCount(HISTORY_DB, table)])),
      stateThreadCount: tableCount(STATE_DB, 'threads'),
    },
  };
}
function assertPlanStable(plan) {
  const currentRows = archivedRows();
  const currentIds = currentRows.map((row) => row.id);
  if (!sameStrings(plan.ids, currentIds)) fail('备份期间归档会话范围发生变化，未修改数据；请重新执行。');
  const currentFiles = listArchiveFiles();
  if (!sameStrings(plan.fileSnapshot, archiveSnapshot(currentFiles))) fail('备份期间归档文件发生变化，未修改数据；请重新执行。');
  const currentIndex = readIndex(plan.idSet);
  if (currentIndex.matchedLines !== plan.index.matchedLines || currentIndex.matchedHash !== plan.index.matchedHash) {
    fail('备份期间归档索引发生变化，未修改数据；请重新执行。');
  }
}
function verifyProtectedUnarchived(ids) {
  let found = 0;
  for (const batch of chunks(ids)) {
    found += sqliteJson(`SELECT count(*) AS count FROM threads WHERE archived=0 AND id IN (${inList(batch)});`, STATE_DB)[0]?.count || 0;
  }
  if (found !== ids.length) fail(`未归档会话发生意外变化：预计保留 ${ids.length} 个，实际 ${found} 个。`);
}
function manifestPathFor(directory) { return path.join(directory, 'manifest.json'); }
function writeManifest(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function restoreDatabaseRows(backup, target, ids, kind) {
  integrity(backup);
  const normalizedBackup = backup.replaceAll('\\', '/');
  for (const batch of chunks(ids)) {
    const list = inList(batch);
    const statements = kind === 'state' ? [
      `DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${list}) OR child_thread_id IN (${list});`,
      `DELETE FROM threads WHERE id IN (${list});`,
      `INSERT OR REPLACE INTO threads SELECT * FROM backup.threads WHERE id IN (${list});`,
      `INSERT OR IGNORE INTO thread_spawn_edges SELECT * FROM backup.thread_spawn_edges WHERE parent_thread_id IN (${list}) OR child_thread_id IN (${list});`,
    ] : [
      `DELETE FROM thread_items WHERE thread_id IN (${list});`,
      `DELETE FROM thread_turns WHERE thread_id IN (${list});`,
      `DELETE FROM thread_realtime_items WHERE thread_id IN (${list});`,
      `DELETE FROM thread_history_projection_state WHERE thread_id IN (${list});`,
      `INSERT OR REPLACE INTO thread_items SELECT * FROM backup.thread_items WHERE thread_id IN (${list});`,
      `INSERT OR REPLACE INTO thread_turns SELECT * FROM backup.thread_turns WHERE thread_id IN (${list});`,
      `INSERT OR REPLACE INTO thread_realtime_items SELECT * FROM backup.thread_realtime_items WHERE thread_id IN (${list});`,
      `INSERT OR REPLACE INTO thread_history_projection_state SELECT * FROM backup.thread_history_projection_state WHERE thread_id IN (${list});`,
    ];
    sqliteExec(`ATTACH DATABASE ${sqlQuote(normalizedBackup)} AS backup; BEGIN IMMEDIATE; ${statements.join(' ')} COMMIT; DETACH DATABASE backup;`, target);
  }
  integrity(target);
}
function restoreArchive(archiveBackup, threadIds) {
  const idSet = new Set(threadIds);
  const files = listArchiveFiles();
  for (const file of files) {
    if ([...idSet].some((id) => path.basename(file).includes(id))) fs.rmSync(file, { force: true });
  }
  execFileSync('tar', ['-xzf', archiveBackup, '-C', ARCHIVE_DIR], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function restoreIndex(backup, tempPath, threadIds) {
  const idSet = new Set(threadIds);
  const current = readIndex(idSet).kept;
  const backupRaw = fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : '';
  const restored = [];
  for (const chunk of backupRaw.split(/(?<=\n)/)) {
    if (!chunk) continue;
    try {
      if (idSet.has(JSON.parse(chunk).id)) restored.push(chunk);
    } catch { /* 非目标坏行不从旧快照覆盖回来。 */ }
  }
  fs.writeFileSync(tempPath, Buffer.concat([current, Buffer.from(restored.join(''), 'utf8')]));
  fs.rmSync(INDEX_FILE, { force: true });
  fs.renameSync(tempPath, INDEX_FILE);
}
function deleteInBatches(database, ids, statementsForBatch) {
  for (const batch of chunks(ids)) {
    sqliteExec(`BEGIN IMMEDIATE; ${statementsForBatch(inList(batch)).join(' ')} COMMIT;`, database);
  }
}
async function runDryRun() {
  const plan = preflight();
  const result = {
    mode: 'dry-run', status: 'planned',
    archivedThreads: plan.before.archivedThreads,
    unarchivedThreads: plan.before.unarchivedThreads,
    historyRows: plan.historyCounts,
    spawnEdges: plan.stateTableCounts.thread_spawn_edges,
    indexMatchedLines: plan.index.matchedLines,
    archiveFiles: plan.files.length,
    archiveBytes: plan.before.archiveBytes,
    stateBytes: plan.before.stateBytes,
    historyBytes: plan.before.historyBytes,
    scope: '只处理 archived=1；未归档会话不会触碰。',
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
async function runApply() {
  const plan = preflight();
  if (!plan.rows.length) {
    process.stdout.write(JSON.stringify({ mode: 'apply', status: 'nothing-to-delete' }, null, 2) + '\n');
    return;
  }
  const backupDir = path.join(ROOT, 'backups', `archived-delete-${timestamp()}`);
  fs.mkdirSync(backupDir, { recursive: false });
  const manifestPath = manifestPathFor(backupDir);
  const manifest = {
    schemaVersion: 2, mode: 'delete-archived', status: 'preflight-complete',
    createdAt: new Date().toISOString(), codexRoot: ROOT,
    stateDatabase: STATE_DB, historyDatabase: HISTORY_DB, archiveDirectory: ARCHIVE_DIR,
    manifestPath, threadIds: plan.ids, before: plan.before, historyRows: plan.historyCounts,
    indexMatchedLines: plan.index.matchedLines, archiveFiles: plan.files.length,
  };
  writeManifest(manifestPath, manifest);
  const stateBackup = path.join(backupDir, 'state-before.sqlite');
  const historyBackup = path.join(backupDir, 'thread_history-before.sqlite');
  const indexBackup = path.join(backupDir, 'session_index-before.jsonl');
  const archiveBackup = path.join(backupDir, 'archived_sessions-before.tar.gz');
  let mutationStarted = false;
  try {
    backupDatabase(STATE_DB, stateBackup);
    backupDatabase(HISTORY_DB, historyBackup);
    if (fs.existsSync(INDEX_FILE)) fs.copyFileSync(INDEX_FILE, indexBackup);
    else fs.writeFileSync(indexBackup, '');
    execFileSync('tar', ['-czf', archiveBackup, '-C', ARCHIVE_DIR, '.'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (!fs.statSync(archiveBackup).size) fail('归档文件备份为空。');
    verifyArchiveBackup(archiveBackup, plan.files);
    const stateBackupRows = archivedRows(stateBackup).filter((row) => plan.idSet.has(row.id));
    if (stateBackupRows.length !== plan.rows.length) fail('状态数据库备份缺少目标归档会话。');
    manifest.backups = { stateBackup, historyBackup, indexBackup, archiveBackup };
    assertPlanStable(plan);
    manifest.status = 'backed-up-and-stable';
    writeManifest(manifestPath, manifest);

    mutationStarted = true;
    deleteInBatches(STATE_DB, plan.ids, (ids) => [
      `DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${ids}) OR child_thread_id IN (${ids});`,
      `DELETE FROM threads WHERE archived=1 AND id IN (${ids});`,
    ]);
    deleteInBatches(HISTORY_DB, plan.ids, (ids) => [
      `DELETE FROM thread_items WHERE thread_id IN (${ids});`,
      `DELETE FROM thread_turns WHERE thread_id IN (${ids});`,
      `DELETE FROM thread_realtime_items WHERE thread_id IN (${ids});`,
      `DELETE FROM thread_history_projection_state WHERE thread_id IN (${ids});`,
    ]);
    const tempIndex = `${INDEX_FILE}.delete-${process.pid}.tmp`;
    fs.writeFileSync(tempIndex, readIndex(plan.idSet).kept);
    fs.rmSync(INDEX_FILE, { force: true });
    fs.renameSync(tempIndex, INDEX_FILE);
    for (const file of plan.files) fs.rmSync(file, { force: true });
    const remainingFiles = listArchiveFiles();
    const afterRows = archivedRows();
    const afterUnarchived = unarchivedRows();
    const afterIndex = readIndex(plan.idSet);
    const afterHistory = databaseCounts(HISTORY_DB, Object.keys(plan.historyCounts), plan.ids);
    const plannedRemaining = afterRows.filter((row) => plan.idSet.has(row.id));
    if (plannedRemaining.length !== 0) fail(`目标归档会话仍有残留：${plannedRemaining.length}`);
    verifyProtectedUnarchived(plan.before.unarchivedIds);
    verifyPaths(afterRows, remainingFiles);
    if (Object.values(afterHistory).some((count) => count !== 0)) fail(`分页缓存仍有归档记录：${JSON.stringify(afterHistory)}`);
    if (afterIndex.matchedLines !== 0) fail(`索引仍有归档记录：${afterIndex.matchedLines}`);
    integrity(STATE_DB); integrity(HISTORY_DB);
    manifest.status = afterRows.length ? 'complete-with-concurrent-archives' : 'complete';
    manifest.completedAt = new Date().toISOString();
    manifest.after = { archivedThreads: afterRows.length, concurrentArchivedThreadIds: afterRows.map((row) => row.id), unarchivedThreads: afterUnarchived.length, archiveFiles: remainingFiles.length, indexMatchedLines: 0, historyRows: afterHistory, stateBytes: fs.statSync(STATE_DB).size, historyBytes: fs.statSync(HISTORY_DB).size };
    writeManifest(manifestPath, manifest);
    process.stdout.write(`${JSON.stringify({ mode: 'apply', status: manifest.status, manifestPath, deletedThreads: plan.rows.length, concurrentArchivedThreads: afterRows.length, deletedArchiveFiles: plan.files.length, deletedArchiveBytes: plan.before.archiveBytes, stateBytesAfter: manifest.after.stateBytes, historyBytesAfter: manifest.after.historyBytes }, null, 2)}\n`);
  } catch (error) {
    try {
      if (manifest.backups && mutationStarted) {
        restoreDatabaseRows(historyBackup, HISTORY_DB, plan.ids, 'history');
        restoreDatabaseRows(stateBackup, STATE_DB, plan.ids, 'state');
        restoreIndex(indexBackup, `${INDEX_FILE}.restore-${process.pid}.tmp`, plan.ids);
        restoreArchive(archiveBackup, plan.ids);
      }
      manifest.status = mutationStarted ? 'failed-and-restored' : 'failed-no-change';
      manifest.failure = error.stack || error.message;
      writeManifest(manifestPath, manifest);
    } catch (restoreError) {
      manifest.status = 'failed-restore-incomplete';
      manifest.failure = error.stack || error.message;
      manifest.restoreFailure = restoreError.stack || restoreError.message;
      writeManifest(manifestPath, manifest);
    }
    throw error;
  }
}
async function runRollback() {
  if (!MANIFEST_ARG) fail('--rollback 必须提供删除 manifest.json。');
  const manifestPath = path.resolve(MANIFEST_ARG);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.mode !== 'delete-archived' || !manifest.backups) fail('不是受支持的归档删除 manifest。');
  restoreDatabaseRows(manifest.backups.historyBackup, HISTORY_DB, manifest.threadIds, 'history');
  restoreDatabaseRows(manifest.backups.stateBackup, STATE_DB, manifest.threadIds, 'state');
  restoreIndex(manifest.backups.indexBackup, `${INDEX_FILE}.rollback-${process.pid}.tmp`, manifest.threadIds);
  restoreArchive(manifest.backups.archiveBackup, manifest.threadIds);
  integrity(STATE_DB); integrity(HISTORY_DB);
  const restored = archivedRows().filter((row) => new Set(manifest.threadIds).has(row.id));
  if (restored.length !== manifest.before.archivedThreads) fail(`回滚后目标归档会话数量不符：${restored.length}`);
  const result = { mode: 'rollback', status: 'complete', manifestPath, restoredThreads: restored.length, restoredAt: new Date().toISOString() };
  manifest.status = 'rolled-back'; manifest.rolledBackAt = result.restoredAt; writeManifest(manifestPath, manifest);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
async function main() {
  if (MODE === '--dry-run') return runDryRun();
  if (MODE === '--apply') return runApply();
  if (MODE === '--rollback') return runRollback();
  process.stderr.write('用法：node delete-archived.cjs --dry-run | --apply | --rollback <manifest.json>\n');
  process.exitCode = 2;
}
main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
