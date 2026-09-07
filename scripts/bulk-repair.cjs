#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');

const OLD_PROVIDER = 'codex_local_access';
const NEW_PROVIDER = 'custom';
const KNOWN_BRANCH_PROVIDERS = new Set(['custom', 'openai', '88api']);
const ROOT = process.env.CODEX_ROOT || 'C:/Users/Administrator/.codex';
const DATABASE = path.join(ROOT, 'state_5.sqlite');
const SCRIPT_DIR = __dirname;
const MODE = process.argv[2];
const MANIFEST_ARG = process.argv[3];
const THREAD_FLAG_INDEX = process.argv.indexOf('--thread');
const THREAD_ID = THREAD_FLAG_INDEX >= 0 ? process.argv[THREAD_FLAG_INDEX + 1] : null;
const NAME_FLAG_INDEX = process.argv.indexOf('--name');
const NAME_FILTER = NAME_FLAG_INDEX >= 0 ? process.argv[NAME_FLAG_INDEX + 1] : null;
const SUMMARY_ARG = process.argv[3];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function fail(message) {
  throw new Error(message);
}

function log(message) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlite(query, database = DATABASE) {
  const output = execFileSync(
    'sqlite3',
    ['-cmd', '.timeout 15000', '-json', database, query],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  ).trim();
  return output ? JSON.parse(output) : [];
}

function sqliteExec(query, database = DATABASE) {
  return execFileSync(
    'sqlite3',
    ['-cmd', '.timeout 15000', database, query],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  ).trim();
}

function sqliteIntegrity(database = DATABASE) {
  const rows = sqlite('PRAGMA integrity_check;', database);
  const result = rows.length === 1 ? rows[0].integrity_check : null;
  if (result !== 'ok') fail(`SQLite integrity_check 未通过：${JSON.stringify(rows)}`);
  return { ok: true, result: 'ok' };
}

function sqliteSchemaCheck(database = DATABASE) {
  const columns = sqlite('PRAGMA table_info(threads);', database);
  const names = new Set(columns.map((column) => column.name));
  const required = ['id', 'rollout_path', 'model_provider', 'title', 'archived'];
  const missing = required.filter((name) => !names.has(name));
  const primaryKey = columns.find((column) => column.name === 'id');
  if (missing.length || !primaryKey || primaryKey.pk !== 1) {
    fail(`SQLite threads 表结构不符合预期：${JSON.stringify({ missing, primaryKey: primaryKey?.pk ?? null })}`);
  }
  return { ok: true, table: 'threads', columnCount: columns.length, required };
}

function backupDatabase(destination) {
  const normalized = destination.replaceAll('\\', '/').replaceAll("'", "''");
  execFileSync('sqlite3', ['-cmd', '.timeout 15000', DATABASE, `.backup '${normalized}'`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const stat = fs.statSync(destination);
  if (!stat.isFile() || stat.size === 0) fail('SQLite 备份为空。');
  sqliteIntegrity(destination);
}

function fileStat(filePath) {
  const stat = fs.statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameStat(left, right) {
  return left.size === right.size && Math.abs(left.mtimeMs - right.mtimeMs) < 0.5;
}

async function writeWithBackpressure(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

async function closeWritable(stream, output) {
  stream.end();
  await finished(output);
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}

function getTargetRows(threadId = null, nameFilter = null) {
  const filter = threadId ? ` AND id=${sqlQuote(threadId)}` : '';
  const name = nameFilter
    ? ` AND (instr(lower(COALESCE(name,'')), lower(${sqlQuote(nameFilter)})) > 0 OR instr(lower(COALESCE(title,'')), lower(${sqlQuote(nameFilter)})) > 0)`
    : '';
  return sqlite(
    `SELECT * FROM threads WHERE archived=0 AND model_provider=${sqlQuote(OLD_PROVIDER)}${filter}${name} ORDER BY id;`,
  );
}

function getCurrentRow(threadId) {
  return sqlite(`SELECT * FROM threads WHERE id=${sqlQuote(threadId)};`)[0] || null;
}

function assertCustomProviderConfig() {
  const configPath = path.join(ROOT, 'config.toml');
  const text = fs.readFileSync(configPath, 'utf8');
  if (!/^\s*model_provider\s*=\s*["']custom["']/m.test(text)) {
    fail('config.toml 当前默认 model_provider 不是 custom。');
  }
  if (!/^\s*\[model_providers\.custom\]\s*$/m.test(text)) {
    fail('config.toml 缺少 [model_providers.custom]。');
  }
  if (!/^\s*wire_api\s*=\s*["']responses["']/m.test(text)) {
    fail('custom provider 未配置 wire_api="responses"。');
  }
  return { configPath, provider: NEW_PROVIDER, wireApi: 'responses' };
}

async function walkJsonl(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  }
  return found;
}

async function discoverFiles(rows) {
  const targetIds = new Set(rows.map((row) => row.id));
  const byPath = new Map();
  for (const row of rows) {
    const full = path.resolve(row.rollout_path);
    if (!fs.existsSync(full)) fail(`当前 rollout_path 不存在：${full}`);
    byPath.set(full.toLowerCase(), { path: full, threadId: row.id, isCurrent: true });
  }
  const roots = [path.join(ROOT, 'sessions'), path.join(ROOT, 'archived_sessions')];
  const lists = await Promise.all(roots.map(walkJsonl));
  for (const filePath of lists.flat()) {
    const match = path.basename(filePath).match(UUID_RE);
    if (!match) continue;
    const threadId = match[0].toLowerCase();
    if (!targetIds.has(threadId)) continue;
    const key = path.resolve(filePath).toLowerCase();
    const existing = byPath.get(key);
    byPath.set(key, {
      path: path.resolve(filePath),
      threadId,
      isCurrent: existing ? existing.isCurrent : false,
    });
  }
  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const row of rows) {
    if (!files.some((file) => file.threadId === row.id && file.isCurrent)) {
      fail(`未发现当前 rollout：${row.id}`);
    }
  }
  return files;
}

function normalizeNotifications(value, changes, location = '$') {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'function_call_output' && !value.call_id) {
    const output = value.output;
    const match = typeof output === 'string'
      ? output.match(/^\s*<(heartbeat|codex_delegation)>/)
      : null;
    if (!match) {
      changes.push({
        location,
        recognized: false,
        name: value.name ?? null,
        outputType: typeof output,
      });
      return;
    }
    const id = value.id;
    const metadata = value.internal_chat_message_metadata_passthrough;
    const originalName = value.name ?? null;
    for (const key of Object.keys(value)) delete value[key];
    Object.assign(value, {
      type: 'message',
      id,
      role: 'user',
      content: [{ type: 'input_text', text: output }],
    });
    if (metadata !== undefined) {
      value.internal_chat_message_metadata_passthrough = metadata;
    }
    changes.push({
      location,
      recognized: true,
      notificationType: match[1],
      name: originalName,
      id: id ?? null,
      outputSha256: sha256(Buffer.from(output)),
    });
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      normalizeNotifications(child, changes, `${location}.${key}`);
    }
  }
}

function replacementBytes(record, rawLength, hadCarriageReturn) {
  const usable = rawLength - (hadCarriageReturn ? 1 : 0);
  const encoded = Buffer.from(JSON.stringify(record));
  if (encoded.length > usable) return { encoded, padded: null, slack: usable - encoded.length };
  const padded = Buffer.alloc(rawLength, 0x20);
  encoded.copy(padded);
  if (hadCarriageReturn) padded[rawLength - 1] = 0x0d;
  return { encoded, padded, slack: usable - encoded.length };
}

function backupFileName(filePath, attempt) {
  const digest = sha256(Buffer.from(filePath.toLowerCase())).slice(0, 20);
  return `lines-${digest}-${attempt}.ndjson.gz`;
}

async function scanFile(file, options = {}) {
  const beforeStat = fileStat(file.path);
  const fullHash = crypto.createHash('sha256');
  const unchangedHash = crypto.createHash('sha256');
  const excludedLines = options.excludeLineNumbers || new Set();
  let backupGzip = null;
  let backupOutput = null;
  let backupRelativePath = null;
  let pending = Buffer.alloc(0);
  let pendingOffset = 0;
  let consumed = 0;
  let lineNo = 0;
  let header = null;
  let headerProvider = null;
  let headerBackupBase64 = null;
  let jsonErrors = 0;
  let notificationCount = 0;
  let unknownNotificationCount = 0;
  let minSlack = null;
  const edits = [];
  const notificationNames = {};

  async function ensureBackup() {
    if (!options.backupDirectory || backupGzip) return;
    backupRelativePath = path.join('lines', backupFileName(file.path, options.attempt || 0));
    const full = path.join(options.backupDirectory, backupRelativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    backupOutput = fs.createWriteStream(full, { flags: 'wx' });
    backupGzip = zlib.createGzip({ level: 9 });
    backupGzip.pipe(backupOutput);
  }

  async function handleLine(raw, offset, hasLf) {
    lineNo++;
    const originalSha256 = sha256(raw);
    let record;
    try {
      record = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      jsonErrors++;
      fail(`JSON 解析失败：${file.path}:${lineNo} (${error.message})`);
    }

    let providerChanged = false;
    if (lineNo === 1) {
      header = record;
      if (record?.type !== 'session_meta' || record?.payload?.id !== file.threadId) {
        fail(`文件头与目标会话不匹配：${file.path}`);
      }
      headerProvider = record.payload.model_provider ?? null;
      if (headerProvider === OLD_PROVIDER) {
        record.payload.model_provider = NEW_PROVIDER;
        providerChanged = true;
        headerBackupBase64 = raw.toString('base64');
      }
    }

    const notificationChanges = [];
    normalizeNotifications(record, notificationChanges);
    const recognized = notificationChanges.filter((change) => change.recognized);
    const unknown = notificationChanges.filter((change) => !change.recognized);
    notificationCount += recognized.length;
    unknownNotificationCount += unknown.length;
    for (const change of recognized) {
      const key = change.name || '(missing-name)';
      notificationNames[key] = (notificationNames[key] || 0) + 1;
    }

    const shouldEdit = providerChanged || recognized.length > 0;
    const explicitlyExcluded = excludedLines.has(lineNo);
    if (shouldEdit || explicitlyExcluded) {
      if (hasLf) unchangedHash.update(Buffer.from([0x0a]));
    } else {
      unchangedHash.update(raw);
      if (hasLf) unchangedHash.update(Buffer.from([0x0a]));
    }

    if (!shouldEdit) return;
    const hadCarriageReturn = raw.length > 0 && raw[raw.length - 1] === 0x0d;
    const replacement = replacementBytes(record, raw.length, hadCarriageReturn);
    if (!replacement.padded) {
      fail(`原位写回空间不足：${file.path}:${lineNo}，超出 ${-replacement.slack} 字节`);
    }
    minSlack = minSlack === null ? replacement.slack : Math.min(minSlack, replacement.slack);
    if (recognized.length > 0 && options.backupDirectory) {
      await ensureBackup();
      const item = {
        path: file.path,
        threadId: file.threadId,
        line: lineNo,
        offset,
        rawLength: raw.length,
        sha256: originalSha256,
        rawBase64: raw.toString('base64'),
      };
      await writeWithBackpressure(backupGzip, `${JSON.stringify(item)}\n`);
    }
    edits.push({
      line: lineNo,
      offset,
      rawLength: raw.length,
      originalSha256,
      replacementSha256: sha256(replacement.padded),
      providerChanged,
      notificationCount: recognized.length,
      unknownNotificationCount: unknown.length,
      slack: replacement.slack,
    });
  }

  try {
    for await (const chunk of fs.createReadStream(file.path, { highWaterMark: 8 * 1024 * 1024 })) {
      fullHash.update(chunk);
      const block = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const blockOffset = pending.length ? pendingOffset : consumed;
      let start = 0;
      while (true) {
        const end = block.indexOf(0x0a, start);
        if (end < 0) break;
        await handleLine(block.subarray(start, end), blockOffset + start, true);
        start = end + 1;
      }
      pending = start < block.length ? Buffer.from(block.subarray(start)) : Buffer.alloc(0);
      pendingOffset = blockOffset + start;
      consumed += chunk.length;
    }
    if (pending.length) await handleLine(pending, pendingOffset, false);
  } finally {
    if (backupGzip) await closeWritable(backupGzip, backupOutput);
  }
  const afterStat = fileStat(file.path);
  if (!sameStat(beforeStat, afterStat)) {
    fail(`扫描期间文件发生变化：${file.path}`);
  }
  return {
    ...file,
    size: beforeStat.size,
    mtimeMs: beforeStat.mtimeMs,
    beforeSha256: fullHash.digest('hex'),
    unchangedSha256: unchangedHash.digest('hex'),
    lineCount: lineNo,
    headerProvider,
    headerBackupBase64,
    backupRelativePath,
    edits,
    jsonErrors,
    notificationCount,
    unknownNotificationCount,
    notificationNames,
    minSlack,
    afterSha256: null,
  };
}

async function readLineBackups(plan, manifestDirectory) {
  const items = new Map();
  if (!plan.backupRelativePath) return items;
  const full = path.join(manifestDirectory, plan.backupRelativePath);
  const input = fs.createReadStream(full).pipe(zlib.createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const item = JSON.parse(line);
    items.set(item.line, item);
  }
  return items;
}

async function verifyPlanStillCurrent(plan) {
  const stat = fileStat(plan.path);
  if (!sameStat(stat, { size: plan.size, mtimeMs: plan.mtimeMs })) return false;
  return (await sha256File(plan.path)) === plan.beforeSha256;
}

async function applyFile(plan, manifestDirectory) {
  if (!(await verifyPlanStillCurrent(plan))) {
    fail(`写入前哈希或时间戳变化：${plan.path}`);
  }
  if (!plan.edits.length) {
    plan.afterSha256 = plan.beforeSha256;
    return;
  }
  const fd = await fsp.open(plan.path, 'r+');
  try {
    const openedStat = await fd.stat();
    if (openedStat.size !== plan.size || Math.abs(openedStat.mtimeMs - plan.mtimeMs) >= 0.5) {
      fail(`打开写入句柄后文件又发生变化：${plan.path}`);
    }
    for (const edit of plan.edits) {
      const raw = Buffer.alloc(edit.rawLength);
      const read = await fd.read(raw, 0, raw.length, edit.offset);
      if (read.bytesRead !== raw.length || sha256(raw) !== edit.originalSha256) {
        fail(`待改行与备份不一致：${plan.path}:${edit.line}`);
      }
      const record = JSON.parse(raw.toString('utf8'));
      if (edit.providerChanged) {
        if (record?.type !== 'session_meta' || record?.payload?.id !== plan.threadId || record.payload.model_provider !== OLD_PROVIDER) {
          fail(`provider 文件头已变化：${plan.path}`);
        }
        record.payload.model_provider = NEW_PROVIDER;
      }
      const changes = [];
      normalizeNotifications(record, changes);
      const recognized = changes.filter((change) => change.recognized).length;
      const unknown = changes.filter((change) => !change.recognized).length;
      if (recognized !== edit.notificationCount || unknown !== edit.unknownNotificationCount) {
        fail(`通知数量与预检不一致：${plan.path}:${edit.line}`);
      }
      const hadCarriageReturn = raw.length > 0 && raw[raw.length - 1] === 0x0d;
      const replacement = replacementBytes(record, raw.length, hadCarriageReturn);
      if (!replacement.padded || sha256(replacement.padded) !== edit.replacementSha256) {
        fail(`替换内容与预检不一致：${plan.path}:${edit.line}`);
      }
      const written = await fd.write(replacement.padded, 0, replacement.padded.length, edit.offset);
      if (written.bytesWritten !== replacement.padded.length) fail(`短写入：${plan.path}:${edit.line}`);
    }
    await fd.sync();
  } finally {
    await fd.close();
  }
  if (fileStat(plan.path).size !== plan.size) fail(`写入后文件大小变化：${plan.path}`);
  plan.afterSha256 = await sha256File(plan.path);
  if (plan.afterSha256 === plan.beforeSha256) fail(`预期修改未写入：${plan.path}`);
}

async function restoreFile(plan, manifestDirectory, expectedAfterHash = null) {
  const currentStat = fileStat(plan.path);
  if (currentStat.size !== plan.size) fail(`回滚前文件大小变化：${plan.path}`);
  if (expectedAfterHash) {
    const currentHash = await sha256File(plan.path);
    if (currentHash !== expectedAfterHash && currentHash !== plan.beforeSha256) {
      fail(`回滚前文件已有新变化，拒绝覆盖：${plan.path}`);
    }
    if (currentHash === plan.beforeSha256) return;
  }
  const lineBackups = await readLineBackups(plan, manifestDirectory);
  const fd = await fsp.open(plan.path, 'r+');
  try {
    for (const edit of [...plan.edits].sort((a, b) => b.offset - a.offset)) {
      let original;
      if (edit.providerChanged && edit.line === 1 && plan.headerBackupBase64) {
        original = Buffer.from(plan.headerBackupBase64, 'base64');
      } else {
        const item = lineBackups.get(edit.line);
        if (!item) fail(`缺少行备份：${plan.path}:${edit.line}`);
        original = Buffer.from(item.rawBase64, 'base64');
      }
      if (original.length !== edit.rawLength || sha256(original) !== edit.originalSha256) {
        fail(`行备份校验失败：${plan.path}:${edit.line}`);
      }
      const written = await fd.write(original, 0, original.length, edit.offset);
      if (written.bytesWritten !== original.length) fail(`回滚短写入：${plan.path}:${edit.line}`);
    }
    await fd.sync();
  } finally {
    await fd.close();
  }
  const restored = await sha256File(plan.path);
  if (restored !== plan.beforeSha256) fail(`文件回滚后哈希不一致：${plan.path}`);
}

function updateThreadProvider(threadId, fromProvider, toProvider) {
  const result = sqlite(
    `BEGIN IMMEDIATE; UPDATE threads SET model_provider=${sqlQuote(toProvider)} ` +
    `WHERE id=${sqlQuote(threadId)} AND archived=0 AND model_provider=${sqlQuote(fromProvider)}; ` +
    'SELECT changes() AS changed; COMMIT;',
  );
  if (result[0]?.changed !== 1) fail(`数据库条件更新失败：${threadId}`);
}

function compareRows(beforeRows, afterRows) {
  const afterById = new Map(afterRows.map((row) => [row.id, row]));
  const mismatches = [];
  for (const before of beforeRows) {
    const after = afterById.get(before.id);
    if (!after) {
      mismatches.push({ id: before.id, reason: 'missing' });
      continue;
    }
    const expected = { ...before, model_provider: NEW_PROVIDER };
    if (JSON.stringify(expected) !== JSON.stringify(after)) {
      const changedFields = Object.keys(expected).filter(
        (key) => JSON.stringify(expected[key]) !== JSON.stringify(after[key]),
      );
      mismatches.push({ id: before.id, reason: 'fields-changed', changedFields });
    }
  }
  return mismatches;
}

function summarizePlans(rows, plans) {
  const providerHeaders = {};
  const notificationNames = {};
  let notificationCount = 0;
  let notificationLines = 0;
  let unknownNotificationCount = 0;
  let headerChanges = 0;
  let totalBytes = 0;
  let minSlack = null;
  for (const plan of plans) {
    providerHeaders[plan.headerProvider] = (providerHeaders[plan.headerProvider] || 0) + 1;
    if (plan.headerProvider === OLD_PROVIDER) headerChanges++;
    notificationCount += plan.notificationCount;
    notificationLines += plan.edits.filter((edit) => edit.notificationCount > 0).length;
    unknownNotificationCount += plan.unknownNotificationCount;
    totalBytes += plan.size;
    if (plan.minSlack !== null) minSlack = minSlack === null ? plan.minSlack : Math.min(minSlack, plan.minSlack);
    for (const [name, count] of Object.entries(plan.notificationNames)) {
      notificationNames[name] = (notificationNames[name] || 0) + count;
    }
  }
  return {
    targetThreads: rows.length,
    rolloutFiles: plans.length,
    totalBytes,
    providerHeaders,
    providerHeaderChanges: headerChanges,
    missingCallIdNotifications: notificationCount,
    affectedNotificationLines: notificationLines,
    unknownNotifications: unknownNotificationCount,
    notificationNames,
    minimumSlackBytes: minSlack,
    jsonErrors: plans.reduce((sum, plan) => sum + plan.jsonErrors, 0),
  };
}

async function preflight(rows, discovered, backupDirectory = null) {
  const plans = [];
  let index = 0;
  for (const file of discovered) {
    index++;
    if (index === 1 || index % 25 === 0 || index === discovered.length) {
      log(`扫描历史文件 ${index}/${discovered.length}`);
    }
    plans.push(await scanFile(file, {
      backupDirectory,
      attempt: 0,
    }));
  }
  const summary = summarizePlans(rows, plans);
  if (summary.jsonErrors !== 0) fail('预检发现 JSON 错误。');
  if (summary.unknownNotifications !== 0) fail('预检发现未识别的缺失 call_id 记录。');
  return { plans, summary };
}

function markdownReport(report) {
  const s = report.preflight;
  const v = report.validation || {};
  const rollback = report.manifestPath ? `node "${report.toolPath}" --rollback "${report.manifestPath}"` : '';
  return [
    '# Codex 未归档会话批量修复报告',
    '',
    `- 执行时间：${report.completedAt || report.startedAt}`,
    `- 状态：${report.status}`,
    `- 目标筛选：${report.selectedName || report.selectedThread || '全部未归档目标'}`,
    `- 目标会话：${s.targetThreads}`,
    `- 历史文件：${s.rolloutFiles}`,
    `- provider 文件头修复：${s.providerHeaderChanges}`,
    `- 缺失 call_id 通知修复：${s.missingCallIdNotifications}`,
    `- 受影响历史行：${s.affectedNotificationLines}`,
    `- 未识别通知：${s.unknownNotifications}`,
    `- JSON 错误：${s.jsonErrors}`,
    `- 数据库残留旧 provider：${v.databaseOldProviderCount ?? '未验证'}`,
    `- 历史文件头残留旧 provider：${v.oldProviderHeaders ?? '未验证'}`,
    `- 修复后缺失 call_id：${v.missingCallIdNotifications ?? '未验证'}`,
    `- 修复后 JSON 错误：${v.jsonErrors ?? '未验证'}`,
    `- 文件大小异常：${v.sizeMismatches ?? '未验证'}`,
    `- 未修改区域哈希异常：${v.unchangedHashMismatches ?? '未验证'}`,
    `- 数据库字段异常：${v.rowMismatches ?? '未验证'}`,
    `- 备份目录：${report.backupDirectory || '无（dry-run）'}`,
    `- 回滚命令：${rollback || '无（dry-run）'}`,
    '',
  ].join('\n');
}

function chineseSummary(report) {
  const p = report.preflight || {};
  const v = report.validation || {};
  const selected = report.selectedName || report.selectedThread || report.threadId || '全部未归档目标';
  const lines = [
    `Codex 会话修复摘要：${report.status || '未知'}`,
    `目标范围：${selected}`,
    `目标会话：${p.targetThreads ?? v.targetThreads ?? 0}`,
    `历史文件：${p.rolloutFiles ?? 0}`,
    `provider 文件头修复：${p.providerHeaderChanges ?? 0}`,
    `缺失 call_id 通知修复：${p.missingCallIdNotifications ?? v.missingCallIdNotifications ?? 0}`,
    `JSON 错误：${p.jsonErrors ?? v.jsonErrors ?? 0}`,
    `数据库完整性：${report.databaseIntegrity?.result || '已通过'}`,
  ];
  if (report.mode === 'apply') {
    lines.push(`修复后残留旧 provider：${v.databaseOldProviderCount ?? '未验证'}`);
    lines.push(`文件大小异常：${v.sizeMismatches ?? '未验证'}`);
    lines.push(`未修改区域异常：${v.unchangedHashMismatches ?? '未验证'}`);
  }
  return lines.join('\n');
}

function htmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function htmlReport(report) {
  const title = `Codex 会话修复报告 - ${report.status || 'unknown'}`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${htmlEscape(title)}</title><style>body{font:15px system-ui,sans-serif;max-width:980px;margin:32px auto;padding:0 20px;color:#202124}h1{font-size:24px}pre{background:#f6f8fa;padding:16px;overflow:auto;border-radius:8px}table{border-collapse:collapse}td{border-bottom:1px solid #ddd;padding:8px 16px 8px 0}</style><h1>${htmlEscape(title)}</h1><table><tr><td>模式</td><td>${htmlEscape(report.mode || '')}</td></tr><tr><td>目标范围</td><td>${htmlEscape(report.selectedName || report.selectedThread || '全部未归档目标')}</td></tr><tr><td>数据库完整性</td><td>${htmlEscape(report.databaseIntegrity?.result || 'ok')}</td></tr></table><pre>${htmlEscape(JSON.stringify(report, null, 2))}</pre></html>`;
}

function writeHtmlReport(filePath, report) {
  fs.writeFileSync(filePath, htmlReport(report));
  return filePath;
}

function runSummary(reportArgument) {
  if (!reportArgument) fail('--summary 必须提供报告 JSON 路径。');
  const report = JSON.parse(fs.readFileSync(path.resolve(reportArgument), 'utf8'));
  process.stdout.write(`${chineseSummary(report)}\n`);
}

async function runDryRun() {
  const config = assertCustomProviderConfig();
  const databaseIntegrity = sqliteIntegrity();
  const schema = sqliteSchemaCheck();
  const rows = getTargetRows(THREAD_ID, NAME_FILTER);
  const discovered = await discoverFiles(rows);
  const { plans, summary } = await preflight(rows, discovered);
  const report = {
    mode: 'dry-run',
    status: 'ready',
    checkedAt: new Date().toISOString(),
    config,
    selectedThread: THREAD_ID,
    selectedName: NAME_FILTER,
    databaseIntegrity,
    schema,
    preflight: summary,
    files: plans.map((plan) => ({
      path: plan.path,
      threadId: plan.threadId,
      isCurrent: plan.isCurrent,
      size: plan.size,
      sha256: plan.beforeSha256,
      headerProvider: plan.headerProvider,
      edits: plan.edits.length,
      notifications: plan.notificationCount,
    })),
  };
  fs.mkdirSync(path.join(SCRIPT_DIR, 'reports'), { recursive: true });
  const reportStamp = timestamp();
  report.reportPath = path.join(SCRIPT_DIR, 'reports', `dry-run-${reportStamp}.json`);
  report.htmlReportPath = path.join(SCRIPT_DIR, 'reports', `dry-run-${reportStamp}.html`);
  atomicJson(report.reportPath, report);
  writeHtmlReport(report.htmlReportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function validateApply(manifest) {
  log('开始全量验证。');
  const oldProviderRows = sqlite(
    `SELECT COUNT(*) AS count FROM threads WHERE archived=0 AND model_provider=${sqlQuote(OLD_PROVIDER)};`,
  )[0].count;
  const ids = manifest.targetRows.map((row) => sqlQuote(row.id)).join(',');
  const afterRows = ids ? sqlite(`SELECT * FROM threads WHERE id IN (${ids}) ORDER BY id;`) : [];
  const rowMismatches = compareRows(manifest.targetRows, afterRows);
  let oldProviderHeaders = 0;
  let missingCallIdNotifications = 0;
  let unknownNotifications = 0;
  let jsonErrors = 0;
  let sizeMismatches = 0;
  let unchangedHashMismatches = 0;
  let branchProviderMismatches = 0;
  const providerHeaders = {};
  let index = 0;
  for (const plan of manifest.files) {
    index++;
    if (index === 1 || index % 25 === 0 || index === manifest.files.length) {
      log(`验证历史文件 ${index}/${manifest.files.length}`);
    }
    const excluded = new Set(plan.edits.map((edit) => edit.line));
    const current = await scanFile(
      { path: plan.path, threadId: plan.threadId, isCurrent: plan.isCurrent },
      { excludeLineNumbers: excluded },
    );
    providerHeaders[current.headerProvider] = (providerHeaders[current.headerProvider] || 0) + 1;
    if (current.headerProvider === OLD_PROVIDER) oldProviderHeaders++;
    if (plan.headerProvider !== OLD_PROVIDER && current.headerProvider !== plan.headerProvider) {
      branchProviderMismatches++;
    }
    missingCallIdNotifications += current.notificationCount;
    unknownNotifications += current.unknownNotificationCount;
    jsonErrors += current.jsonErrors;
    if (current.size !== plan.size) sizeMismatches++;
    if (current.unchangedSha256 !== plan.unchangedSha256) unchangedHashMismatches++;
    plan.afterSha256 = current.beforeSha256;
  }
  const validation = {
    databaseOldProviderCount: oldProviderRows,
    oldProviderHeaders,
    providerHeaders,
    missingCallIdNotifications,
    unknownNotifications,
    jsonErrors,
    sizeMismatches,
    unchangedHashMismatches,
    branchProviderMismatches,
    rowMismatches: rowMismatches.length,
    rowMismatchDetails: rowMismatches,
  };
  const failed = Object.entries(validation).some(([key, value]) => {
    if (key === 'providerHeaders' || key === 'rowMismatchDetails') return false;
    return typeof value === 'number' && value !== 0;
  });
  if (failed) fail(`全量验证失败：${JSON.stringify(validation)}`);
  return validation;
}

async function runApply() {
  const startedAt = new Date().toISOString();
  const runName = `run-${startedAt.replaceAll(':', '').replaceAll('-', '').replace('.000Z', 'Z')}`;
  const backupDirectory = path.join(SCRIPT_DIR, runName);
  fs.mkdirSync(backupDirectory, { recursive: false });
  const manifestPath = path.join(backupDirectory, 'manifest.json');
  const config = assertCustomProviderConfig();
  const databaseIntegrity = sqliteIntegrity();
  const schema = sqliteSchemaCheck();
  const rows = getTargetRows(THREAD_ID, NAME_FILTER);
  const discovered = await discoverFiles(rows);
  log(`最终范围：${rows.length} 个未归档旧 provider 会话，${discovered.length} 份历史文件。`);
  backupDatabase(path.join(backupDirectory, 'state-before.sqlite'));
  fs.writeFileSync(path.join(backupDirectory, 'database-rows-before.json'), JSON.stringify(rows, null, 2));
  const { plans, summary } = await preflight(rows, discovered, backupDirectory);
  const manifest = {
    schemaVersion: 1,
    mode: 'apply',
    status: 'preflight-complete',
    startedAt,
    toolPath: __filename,
    codexRoot: ROOT,
    database: DATABASE,
    backupDirectory,
    manifestPath,
    config,
    selectedThread: THREAD_ID,
    selectedName: NAME_FILTER,
    databaseIntegrity,
    schema,
    preflight: summary,
    targetRows: rows,
    files: plans,
    appliedThreadIds: [],
    completedAt: null,
    validation: null,
  };
  atomicJson(manifestPath, manifest);
  if (summary.unknownNotifications !== 0 || summary.jsonErrors !== 0) fail('预检未通过。');

  const plansByThread = new Map();
  for (const plan of plans) {
    if (!plansByThread.has(plan.threadId)) plansByThread.set(plan.threadId, []);
    plansByThread.get(plan.threadId).push(plan);
  }
  let completed = 0;
  for (const row of rows) {
    const threadPlans = plansByThread.get(row.id) || [];
    const currentRow = getCurrentRow(row.id);
    if (!currentRow || currentRow.archived !== 0 || currentRow.model_provider !== OLD_PROVIDER) {
      fail(`正式写入前数据库目标变化：${row.id}`);
    }
    const changed = [];
    try {
      for (const plan of threadPlans) {
        if (plan.edits.length) changed.push(plan);
        await applyFile(plan, backupDirectory);
      }
      updateThreadProvider(row.id, OLD_PROVIDER, NEW_PROVIDER);
      manifest.appliedThreadIds.push(row.id);
      completed++;
      if (completed === 1 || completed % 25 === 0 || completed === rows.length) {
        log(`修复会话 ${completed}/${rows.length}`);
      }
      atomicJson(manifestPath, manifest);
    } catch (error) {
      log(`会话 ${row.id} 失败，开始恢复该会话：${error.message}`);
      for (const plan of changed.reverse()) {
        await restoreFile(plan, backupDirectory, plan.afterSha256);
      }
      const dbRow = getCurrentRow(row.id);
      if (dbRow?.model_provider === NEW_PROVIDER) {
        updateThreadProvider(row.id, NEW_PROVIDER, OLD_PROVIDER);
      }
      manifest.status = 'failed-and-thread-rolled-back';
      manifest.failure = { threadId: row.id, message: error.stack || error.message };
      atomicJson(manifestPath, manifest);
      throw error;
    }
  }

  manifest.status = 'validating';
  atomicJson(manifestPath, manifest);
  try {
    manifest.validation = await validateApply(manifest);
  } catch (error) {
    log(`全量验证失败，开始恢复全部已修会话：${error.message}`);
    for (const plan of [...plans].reverse()) {
      if (!plan.edits.length) continue;
      await restoreFile(plan, backupDirectory, plan.afterSha256 || null);
    }
    const rollbackStatements = rows.map((row) =>
      `UPDATE threads SET model_provider=${sqlQuote(row.model_provider)} ` +
      `WHERE id=${sqlQuote(row.id)} AND model_provider=${sqlQuote(NEW_PROVIDER)}`,
    );
    sqliteExec(`BEGIN IMMEDIATE; ${rollbackStatements.join('; ')}; COMMIT;`);
    manifest.status = 'validation-failed-and-rolled-back';
    manifest.failure = { message: error.stack || error.message };
    atomicJson(manifestPath, manifest);
    throw error;
  }
  manifest.status = 'complete';
  manifest.completedAt = new Date().toISOString();
  atomicJson(manifestPath, manifest);
  const report = {
    mode: 'apply',
    status: manifest.status,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    toolPath: manifest.toolPath,
    backupDirectory,
    manifestPath,
    selectedThread: manifest.selectedThread,
    selectedName: manifest.selectedName,
    databaseIntegrity: manifest.databaseIntegrity,
    schema: manifest.schema,
    preflight: manifest.preflight,
    validation: manifest.validation,
  };
  fs.writeFileSync(path.join(backupDirectory, 'repair-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(backupDirectory, '修复报告.md'), markdownReport(report));
  report.htmlReportPath = path.join(backupDirectory, '修复报告.html');
  writeHtmlReport(report.htmlReportPath, report);
  fs.writeFileSync(path.join(backupDirectory, 'repair-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function runRollback(manifestArgument) {
  if (!manifestArgument) fail('--rollback 必须提供 manifest.json。');
  const manifestPath = path.resolve(manifestArgument);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestDirectory = path.dirname(manifestPath);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.targetRows)) {
    fail('manifest 格式不受支持。');
  }
  log(`开始回滚 ${manifest.files.length} 份历史文件。`);
  for (const plan of [...manifest.files].reverse()) {
    if (!plan.edits.length) continue;
    await restoreFile(plan, manifestDirectory, plan.afterSha256 || null);
  }
  const rollbackStatements = [];
  for (const row of manifest.targetRows) {
    const current = getCurrentRow(row.id);
    if (!current) fail(`回滚时数据库行缺失：${row.id}`);
    if (current.model_provider === row.model_provider) continue;
    if (current.model_provider !== NEW_PROVIDER) fail(`回滚时 provider 已被另行修改：${row.id}`);
    rollbackStatements.push(
      `UPDATE threads SET model_provider=${sqlQuote(row.model_provider)} WHERE id=${sqlQuote(row.id)}`,
    );
  }
  if (rollbackStatements.length) {
    sqliteExec(`BEGIN IMMEDIATE; ${rollbackStatements.join('; ')}; COMMIT;`);
  }
  const restoredRows = manifest.targetRows.filter((row) => getCurrentRow(row.id)?.model_provider === row.model_provider);
  if (restoredRows.length !== manifest.targetRows.length) fail('数据库回滚验证失败。');
  const rollbackReport = {
    mode: 'rollback',
    status: 'complete',
    manifestPath,
    restoredThreads: restoredRows.length,
    restoredFiles: manifest.files.filter((plan) => plan.edits.length).length,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(manifestDirectory, 'rollback-report.json'), JSON.stringify(rollbackReport, null, 2));
  process.stdout.write(`${JSON.stringify(rollbackReport, null, 2)}\n`);
}

async function main() {
  if (!['--dry-run', '--apply', '--rollback', '--summary'].includes(MODE)) {
    process.stderr.write(
      '用法：node bulk-repair.cjs --dry-run [--thread <id>] | --apply [--thread <id>] | --rollback <manifest.json> | --summary <report.json>\n',
    );
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(DATABASE)) fail(`数据库不存在：${DATABASE}`);
  if (MODE === '--dry-run') await runDryRun();
  else if (MODE === '--apply') await runApply();
  else if (MODE === '--rollback') await runRollback(MANIFEST_ARG);
  else runSummary(SUMMARY_ARG);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
