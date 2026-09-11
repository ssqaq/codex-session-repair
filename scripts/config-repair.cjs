#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(process.env.CODEX_ROOT || 'C:/Users/Administrator/.codex');
const CONFIG_PATH = path.join(ROOT, 'config.toml');
const MANAGED_PROMPTS = path.join(ROOT, 'managed-prompts');
const REPORT_DIR = path.join(__dirname, 'reports');

function fail(message) { throw new Error(message); }
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z'); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function isFile(filePath) { try { return fs.statSync(filePath).isFile(); } catch { return false; } }
function readText(filePath) { return fs.readFileSync(filePath, 'utf8'); }
function writeAtomic(filePath, data) {
  const temp = `${filePath}.codex-repair.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, filePath);
}

function parseArgs(argv) {
  const args = { mode: '--dry-run', json: false, file: null, manifest: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--apply') args.mode = arg;
    else if (arg === '--json') args.json = true;
    else if (arg === '--file') args.file = argv[++i] || fail('--file 需要路径。');
    else if (arg === '--rollback') args.mode = '--rollback', args.manifest = argv[++i] || fail('--rollback 需要 manifest.json。');
    else fail(`未知参数：${arg}`);
  }
  return args;
}

function parseTomlString(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch (error) { fail(`model_instructions_file 字符串无法解析：${error.message}`); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  fail('model_instructions_file 必须是 TOML 字符串。');
}

function readConfig() {
  if (!isFile(CONFIG_PATH)) fail(`找不到配置文件：${CONFIG_PATH}`);
  const raw = fs.readFileSync(CONFIG_PATH);
  const text = raw.toString('utf8');
  const lines = text.split(/\r?\n/);
  const matches = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*model_instructions_file\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*$/);
    if (match) matches.push({ index: i, line: lines[i], value: parseTomlString(match[1]) });
  }
  if (matches.length !== 1) fail(`model_instructions_file 配置行数量异常：${matches.length}`);
  return { raw, text, lines, match: matches[0], eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

function resolveConfiguredPath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(ROOT, value);
}

function hasInvalidWindowsComponent(filePath) {
  const normalized = filePath.replaceAll('/', '\\');
  const components = normalized.split('\\');
  for (const component of components) {
    if (!component || /^[A-Za-z]:$/.test(component)) continue;
    if (/[<>:"|?*\x00]/.test(component) || /[ .]$/.test(component)) return true;
  }
  return false;
}

function readInstallState() {
  const statePath = path.join(MANAGED_PROMPTS, 'install-state.json');
  if (!isFile(statePath)) return null;
  try { return JSON.parse(readText(statePath)); } catch { return null; }
}

function candidateFromInstallState(state) {
  const values = [state?.targetPrompt, state?.previousLine];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const match = value.match(/(?:model_instructions_file\s*=\s*)?["']?([^"']+\.md)["']?\s*$/i);
    if (match) {
      const candidate = resolveConfiguredPath(match[1]);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function findCandidates(explicitFile, installState) {
  if (explicitFile) {
    const candidate = path.resolve(explicitFile);
    return { candidates: isFile(candidate) ? [candidate] : [], source: 'explicit-file' };
  }
  const fromState = candidateFromInstallState(installState);
  if (fromState) return { candidates: [fromState], source: 'install-state' };
  if (!fs.existsSync(MANAGED_PROMPTS)) return { candidates: [], source: 'managed-prompts-missing' };
  const candidates = fs.readdirSync(MANAGED_PROMPTS, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== 'AGENTS.md.orig')
    .map((entry) => path.join(MANAGED_PROMPTS, entry.name));
  return { candidates, source: 'managed-prompts-scan' };
}

function inspect(args) {
  const config = readConfig();
  const configuredPath = resolveConfiguredPath(config.match.value);
  const invalidPath = hasInvalidWindowsComponent(configuredPath);
  const readable = isFile(configuredPath);
  const installState = readInstallState();
  const found = findCandidates(args.file, installState);
  const candidate = found.candidates.length === 1 ? found.candidates[0] : null;
  const needsRepair = invalidPath || !readable;
  const status = !needsRepair ? 'healthy' : candidate ? 'repairable' : 'ambiguous';
  return {
    mode: 'dry-run',
    status,
    checkedAt: new Date().toISOString(),
    codexRoot: ROOT,
    configPath: CONFIG_PATH,
    modelInstructionsFile: config.match.value,
    resolvedPath: configuredPath,
    invalidWindowsPath: invalidPath,
    exists: readable,
    readable,
    candidateSource: found.source,
    candidates: found.candidates,
    proposedPath: candidate,
    configSha256: sha256(config.raw),
    reason: !needsRepair ? '配置路径存在且可读' : candidate ? '配置路径不存在或含非法字符，可使用候选文件修复' : '找不到唯一候选文件，不能自动决定',
    _config: config,
  };
}

function publicReport(report) {
  const clean = { ...report };
  delete clean._config;
  return clean;
}

function writeReport(report, prefix = 'config-repair') {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${prefix}-${stamp()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(publicReport(report), null, 2));
  return reportPath;
}

function applyRepair(args) {
  const report = inspect(args);
  if (report.status === 'healthy') {
    report.mode = 'apply';
    report.status = 'nothing-to-do';
    return { ...publicReport(report), reportPath: writeReport({ ...report, mode: 'apply', status: 'nothing-to-do' }) };
  }
  if (report.status !== 'repairable' || !report.proposedPath) fail(report.reason);
  const config = report._config;
  const backupDir = path.join(ROOT, 'backups', `config-repair-${stamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, 'config.toml.before');
  fs.copyFileSync(CONFIG_PATH, backupPath);
  const replacement = `model_instructions_file = "${report.proposedPath.replaceAll('\\', '/')}"`;
  const lines = [...config.lines];
  lines[config.match.index] = replacement;
  const nextText = lines.join(config.eol);
  const beforeSha256 = sha256(config.raw);
  const afterSha256 = sha256(Buffer.from(nextText, 'utf8'));
  try {
    writeAtomic(CONFIG_PATH, nextText);
    const verify = inspect(args);
    if (verify.status !== 'healthy') fail(`写入后验证失败：${verify.reason}`);
  } catch (error) {
    fs.copyFileSync(backupPath, CONFIG_PATH);
    throw error;
  }
  const manifest = {
    schemaVersion: 1,
    mode: 'apply',
    status: 'complete',
    appliedAt: new Date().toISOString(),
    codexRoot: ROOT,
    configPath: CONFIG_PATH,
    backupPath,
    beforeSha256,
    afterSha256,
    oldModelInstructionsFile: config.match.value,
    newModelInstructionsFile: replacement.slice(replacement.indexOf('"') + 1, -1),
    candidateSource: report.candidateSource,
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const output = { ...manifest, reportPath: path.join(backupDir, 'manifest.json') };
  writeReport({ ...output, mode: 'apply' });
  return output;
}

function rollback(manifestPath) {
  const manifest = JSON.parse(readText(path.resolve(manifestPath)));
  if (!manifest.configPath || !manifest.backupPath || !isFile(manifest.backupPath)) fail('回滚 manifest 缺少有效配置备份。');
  const backup = fs.readFileSync(manifest.backupPath);
  writeAtomic(manifest.configPath, backup);
  const restored = fs.readFileSync(manifest.configPath);
  if (sha256(restored) !== manifest.beforeSha256) fail('回滚后 SHA-256 不匹配。');
  return { mode: 'rollback', status: 'rolled-back', configPath: manifest.configPath, backupPath: manifest.backupPath, restoredSha256: sha256(restored) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.mode === '--rollback') result = rollback(args.manifest);
  else if (args.mode === '--apply') result = applyRepair(args);
  else result = publicReport(inspect(args));
  if (args.mode !== '--rollback' && !result.reportPath) result.reportPath = writeReport(result);
  process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : JSON.stringify(result)}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }

