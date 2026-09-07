#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = process.env.CODEX_ROOT || 'C:/Users/Administrator/.codex';
const STATE_DB = path.join(ROOT, 'state_5.sqlite');
const PROJECTION_DB = path.join(ROOT, 'thread_history_1.sqlite');
const SCRIPT_DIR = __dirname;

function fail(message) {
  throw new Error(message);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlite(query, database = PROJECTION_DB) {
  const output = execFileSync(
    'sqlite3',
    ['-cmd', '.timeout 15000', '-json', database, query],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  ).trim();
  return output ? JSON.parse(output) : [];
}

function sqliteExec(query, database = PROJECTION_DB) {
  const args = ['-cmd', '.timeout 15000', database];
  const options = {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  };
  if (query.length <= 6000) args.push(query);
  else options.input = query;
  return execFileSync(
    'sqlite3',
    args,
    options,
  ).trim();
}

function integrity(database = PROJECTION_DB) {
  const rows = sqlite('PRAGMA integrity_check;', database);
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') {
    fail(`分页缓存 integrity_check 未通过：${JSON.stringify(rows)}`);
  }
  return 'ok';
}

function parseArgs() {
  const args = process.argv.slice(2);
  const threads = [];
  let mode = 'dry-run';
  let manifestPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') mode = 'apply';
    else if (arg === '--dry-run') mode = 'dry-run';
    else if (arg === '--rollback') {
      mode = 'rollback';
      manifestPath = args[++i];
    } else if (arg === '--thread') {
      const id = args[++i];
      if (!id) fail('--thread 缺少会话 ID。');
      threads.push(id);
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：',
        '  node sync-projection.cjs --dry-run --thread <THREAD_ID> [--thread <THREAD_ID> ...]',
        '  node sync-projection.cjs --apply --thread <THREAD_ID> [--thread <THREAD_ID> ...]',
        '  node sync-projection.cjs --rollback <manifest.json>',
      ].join('\n') + '\n');
      process.exit(0);
    } else {
      fail(`未知参数：${arg}`);
    }
  }
  if (mode !== 'rollback' && threads.length === 0) fail('必须明确指定至少一个 --thread。');
  return { mode, threads: [...new Set(threads)], manifestPath };
}

function getThreads(ids) {
  const where = ids.map(sqlQuote).join(',');
  const rows = sqlite(
    `SELECT id, archived, rollout_path FROM threads WHERE id IN (${where}) ORDER BY id;`,
    STATE_DB,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) fail(`state_5.sqlite 中找不到会话：${id}`);
    if (row.archived !== 0) fail(`拒绝处理已归档会话：${id}`);
    if (!fs.existsSync(row.rollout_path)) fail(`历史文件不存在：${row.rollout_path}`);
  }
  return rows;
}

function canonicalItem(item) {
  const value = JSON.parse(JSON.stringify(item));
  if (value.type === 'UserMessage' || value.type === 'FunctionCallOutput') value.type = 'userMessage';
  if (value.client_id !== undefined && value.clientId === undefined) {
    value.clientId = value.client_id;
    delete value.client_id;
  }
  if (value.type !== 'userMessage') {
    fail(`受影响 item 不是可转换的 UserMessage：${JSON.stringify(value).slice(0, 300)}`);
  }
  return value;
}

function collectItems(filePath, threadId) {
  const byId = new Map();
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      fail(`历史文件 JSON 解析失败：${filePath} (${error.message})`);
    }
    const payload = record.payload;
    if (!payload || payload.thread_id !== threadId || payload.type !== 'item_completed') continue;
    if (payload.item && payload.item.id) byId.set(payload.item.id, payload.item);
  }
  return byId;
}

function buildPlan(threads) {
  const plan = [];
  for (const thread of threads) {
    const items = collectItems(thread.rollout_path, thread.id);
    const rows = sqlite(
      `SELECT thread_id, turn_id, item_id, rollout_ordinal, item_type, item_json, updated_at_ordinal
       FROM thread_items
       WHERE thread_id=${sqlQuote(thread.id)} AND item_type='functionCallOutput'
       ORDER BY rollout_ordinal;`,
    );
    for (const row of rows) {
      const source = items.get(row.item_id);
      if (!source) fail(`分页缓存 item 在 JSONL 中找不到对应记录：${thread.id}/${row.item_id}`);
      const after = canonicalItem(source);
      plan.push({
        ...row,
        afterType: 'userMessage',
        afterJson: JSON.stringify(after),
        afterSha256: sha256Text(JSON.stringify(after)),
      });
    }
  }
  return plan;
}

function verifyPlan(plan) {
  for (const expected of plan) {
    const rows = sqlite(
      `SELECT item_type, item_json FROM thread_items
       WHERE thread_id=${sqlQuote(expected.thread_id)} AND item_id=${sqlQuote(expected.item_id)};`,
    );
    if (rows.length !== 1) fail(`分页缓存更新后 item 消失：${expected.item_id}`);
    const actual = rows[0];
    if (actual.item_type !== expected.afterType || actual.item_json !== expected.afterJson) {
      fail(`分页缓存更新校验失败：${expected.item_id}`);
    }
  }
  const ids = [...new Set(plan.map((row) => row.thread_id))];
  const remaining = ids.length
    ? sqlite(`SELECT thread_id, COUNT(*) AS count FROM thread_items
              WHERE item_type='functionCallOutput' AND thread_id IN (${ids.map(sqlQuote).join(',')})
              GROUP BY thread_id;`)
    : [];
  if (remaining.length) fail(`目标会话仍有旧 functionCallOutput：${JSON.stringify(remaining)}`);
}

function writeManifest(filePath, manifest) {
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
}

function runApply(plan, manifestPath) {
  const statements = ['BEGIN IMMEDIATE;'];
  for (const row of plan) {
    statements.push(
      `UPDATE thread_items SET item_type=${sqlQuote(row.afterType)}, item_json=${sqlQuote(row.afterJson)} ` +
      `WHERE thread_id=${sqlQuote(row.thread_id)} AND item_id=${sqlQuote(row.item_id)} ` +
      `AND item_type=${sqlQuote(row.item_type)} AND item_json=${sqlQuote(row.item_json)};`,
    );
  }
  statements.push('COMMIT;');
  sqliteExec(statements.join('\n'));
  verifyPlan(plan);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.status = 'validated';
  manifest.completedAt = new Date().toISOString();
  manifest.afterProjectionSha256 = sha256File(PROJECTION_DB);
  manifest.remainingOldItems = 0;
  writeManifest(manifestPath, manifest);
  return manifest;
}

function runRollback(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) fail(`manifest 不存在：${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.items) || !manifest.items.length) fail('manifest 没有可回滚的分页缓存项。');
  integrity();
  for (const expected of manifest.items) {
    const rows = sqlite(
      `SELECT item_type, item_json FROM thread_items
       WHERE thread_id=${sqlQuote(expected.thread_id)} AND item_id=${sqlQuote(expected.item_id)};`,
    );
    if (rows.length !== 1 || rows[0].item_type !== expected.afterType || rows[0].item_json !== expected.afterJson) {
      fail(`回滚前校验失败，当前 item 已发生其他变化：${expected.item_id}`);
    }
  }
  const statements = ['BEGIN IMMEDIATE;'];
  for (const row of manifest.items) {
    statements.push(
      `UPDATE thread_items SET item_type=${sqlQuote(row.item_type)}, item_json=${sqlQuote(row.item_json)} ` +
      `WHERE thread_id=${sqlQuote(row.thread_id)} AND item_id=${sqlQuote(row.item_id)};`,
    );
  }
  statements.push('COMMIT;');
  sqliteExec(statements.join('\n'));
  integrity();
  manifest.status = 'rolled-back';
  manifest.rolledBackAt = new Date().toISOString();
  writeManifest(manifestPath, manifest);
  process.stdout.write(JSON.stringify({ mode: 'rollback', status: manifest.status, manifestPath, items: manifest.items.length }, null, 2) + '\n');
}

function main() {
  const args = parseArgs();
  if (args.mode === 'rollback') return runRollback(args.manifestPath);
  integrity();
  const threads = getThreads(args.threads);
  const plan = buildPlan(threads);
  const result = {
    mode: args.mode,
    status: 'ready',
    checkedAt: new Date().toISOString(),
    projectionDatabase: PROJECTION_DB,
    projectionSha256: sha256File(PROJECTION_DB),
    threads: threads.map((row) => ({ id: row.id, rolloutPath: row.rollout_path })),
    items: plan,
    itemCount: plan.length,
  };
  if (args.mode === 'dry-run') {
    process.stdout.write(JSON.stringify({ ...result, items: plan.map((row) => ({
      thread_id: row.thread_id,
      turn_id: row.turn_id,
      item_id: row.item_id,
      rollout_ordinal: row.rollout_ordinal,
      beforeType: row.item_type,
      afterType: row.afterType,
      beforeSha256: sha256Text(row.item_json),
      afterSha256: row.afterSha256,
    })) }, null, 2) + '\n');
    return;
  }
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace('.000Z', 'Z');
  const directory = path.join(SCRIPT_DIR, `projection-run-${stamp}`);
  fs.mkdirSync(directory, { recursive: false });
  const backupPath = path.join(directory, 'thread_history-before.sqlite');
  sqliteExec(`.backup ${sqlQuote(backupPath)}`, PROJECTION_DB);
  if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) fail('分页缓存备份为空。');
  integrity(backupPath);
  result.backupPath = backupPath;
  result.manifestPath = path.join(directory, 'manifest.json');
  result.status = 'preflight-complete';
  writeManifest(result.manifestPath, result);
  const validated = runApply(plan, result.manifestPath);
  process.stdout.write(JSON.stringify({
    mode: 'apply',
    status: validated.status,
    manifestPath: result.manifestPath,
    backupPath,
    itemCount: plan.length,
    projectionSha256: validated.afterProjectionSha256,
  }, null, 2) + '\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
