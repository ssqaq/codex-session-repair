#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(process.env.CODEX_ROOT || 'C:/Users/Administrator/.codex');
const SCRIPT_DIR = __dirname;
const REPORT_DIR = path.join(SCRIPT_DIR, 'reports');
const MODE = process.argv[2] || '--check';
const REPORT_ARG = process.argv[3];

function fail(message) { throw new Error(message); }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z'); }

function runJsonScript(fileName, args) {
  const scriptPath = path.join(SCRIPT_DIR, fileName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: SCRIPT_DIR,
    env: { ...process.env, CODEX_ROOT: ROOT },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const details = (result.stderr || '').trim();
    return { ok: false, error: `退出码 ${result.status}${details ? `：${details.slice(-1000)}` : ''}` };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout.trim()) };
  } catch (error) {
    return { ok: false, error: `输出不是有效 JSON：${error.message}` };
  }
}

function compactBulk(result) {
  if (!result.ok) return result;
  const report = result.value;
  const preflight = report.preflight || {};
  return {
    ok: true,
    databaseIntegrity: report.databaseIntegrity?.result || 'unknown',
    targetThreads: preflight.targetThreads || 0,
    rolloutFiles: preflight.rolloutFiles || 0,
    totalBytes: preflight.totalBytes || 0,
    oldProviderDatabaseRows: preflight.oldProviderDatabaseRows || 0,
    oldProviderHeaders: preflight.providerHeaderChanges || 0,
    missingCallIdNotifications: preflight.missingCallIdNotifications || 0,
    unknownNotifications: preflight.unknownNotifications || 0,
    jsonErrors: preflight.jsonErrors || 0,
    detailReport: report.reportPath || null,
  };
}

function compactArchived(result) {
  if (!result.ok) return result;
  const report = result.value;
  return {
    ok: true,
    archivedThreads: report.archivedThreads || 0,
    archiveFiles: report.archiveFiles || 0,
    historyRows: report.historyRows || {},
    indexMatchedLines: report.indexMatchedLines || 0,
  };
}

function compactBackups(result) {
  if (!result.ok) return result;
  const report = result.value;
  return {
    ok: true,
    scannedDirectories: report.scannedDirectories || 0,
    retainedDirectories: report.retainedDirectories || 0,
    deletableDirectories: report.deletableDirectories || 0,
    retainedBytes: report.retainedBytes || 0,
    deletableBytes: report.deletableBytes || 0,
  };
}

function collectIssues(checks) {
  const issues = [];
  for (const [name, value] of Object.entries(checks)) {
    if (!value.ok) issues.push({ kind: 'check-failed', check: name, count: 1, message: value.error });
  }
  const sessions = checks.sessions;
  if (sessions.ok) {
    if (sessions.oldProviderDatabaseRows) issues.push({ kind: 'old-provider-database', count: sessions.oldProviderDatabaseRows, message: '数据库仍有旧 provider 会话' });
    if (sessions.oldProviderHeaders) issues.push({ kind: 'old-provider-header', count: sessions.oldProviderHeaders, message: '历史文件仍有旧 provider 文件头' });
    if (sessions.missingCallIdNotifications) issues.push({ kind: 'missing-call-id', count: sessions.missingCallIdNotifications, message: '存在可修复的缺失 call_id 通知' });
    if (sessions.unknownNotifications) issues.push({ kind: 'unknown-notification', count: sessions.unknownNotifications, message: '存在未识别的缺失 call_id 记录' });
    if (sessions.jsonErrors) issues.push({ kind: 'json-error', count: sessions.jsonErrors, message: '历史文件存在 JSON 错误' });
  }
  const archived = checks.archived;
  if (archived.ok && archived.archivedThreads) issues.push({ kind: 'archived-threads', count: archived.archivedThreads, message: '存在可清理的归档会话' });
  const backups = checks.backups;
  if (backups.ok && backups.deletableDirectories) issues.push({ kind: 'old-backups', count: backups.deletableDirectories, message: '存在可清理的旧重复备份' });
  return issues;
}

function chineseSummary(report) {
  const sessions = report.checks.sessions;
  const archived = report.checks.archived;
  const backups = report.checks.backups;
  const status = report.status === 'healthy' ? '正常' : report.status === 'needs-attention' ? '发现待处理项' : '检查失败';
  return [
    `Codex 全会话检查：${status}`,
    `未归档会话：${sessions.ok ? sessions.targetThreads : '检查失败'}`,
    `历史文件：${sessions.ok ? sessions.rolloutFiles : '检查失败'}`,
    `旧 provider（数据库/文件）：${sessions.ok ? `${sessions.oldProviderDatabaseRows}/${sessions.oldProviderHeaders}` : '检查失败'}`,
    `缺失 call_id：${sessions.ok ? sessions.missingCallIdNotifications : '检查失败'}`,
    `未知通知：${sessions.ok ? sessions.unknownNotifications : '检查失败'}`,
    `JSON 错误：${sessions.ok ? sessions.jsonErrors : '检查失败'}`,
    `归档会话：${archived.ok ? archived.archivedThreads : '检查失败'}`,
    `可删旧备份：${backups.ok ? backups.deletableDirectories : '检查失败'}`,
    `数据库完整性：${sessions.ok ? sessions.databaseIntegrity : '检查失败'}`,
    `详细报告：${report.reportPath}`,
  ].join('\n');
}

function markdownSummary(report) {
  return `# Codex 全会话健康检查\n\n\`\`\`text\n${chineseSummary(report)}\n\`\`\`\n\n## 待处理项\n\n${report.issues.length ? report.issues.map((issue) => `- ${issue.message}：${issue.count}`).join('\n') : '- 没有'}\n`;
}

function writeReport(report) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = timestamp();
  report.reportPath = path.join(REPORT_DIR, `health-check-${stamp}.json`);
  report.summaryPath = path.join(REPORT_DIR, `health-check-${stamp}.md`);
  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(report.summaryPath, markdownSummary(report));
  fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2));
}

function runSummary(reportPath) {
  if (!reportPath) fail('--summary 必须提供 health-check JSON 报告。');
  const report = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8'));
  if (report.mode !== 'health-check') fail('不是 health-check 报告。');
  process.stdout.write(`${chineseSummary(report)}\n`);
}

function runHealthCheck(jsonOutput) {
  const startedAt = new Date().toISOString();
  const checks = {
    sessions: compactBulk(runJsonScript('bulk-repair.cjs', ['--dry-run', '--all-unarchived'])),
    archived: compactArchived(runJsonScript('delete-archived.cjs', ['--dry-run'])),
    backups: compactBackups(runJsonScript('cleanup-backups.cjs', ['--dry-run'])),
  };
  const issues = collectIssues(checks);
  const failed = Object.values(checks).some((check) => !check.ok);
  const report = {
    schemaVersion: 1,
    mode: 'health-check',
    status: failed ? 'failed' : issues.length ? 'needs-attention' : 'healthy',
    startedAt,
    completedAt: new Date().toISOString(),
    codexRoot: ROOT,
    checks,
    issues,
    reportPath: null,
    summaryPath: null,
  };
  writeReport(report);
  process.stdout.write(jsonOutput ? `${JSON.stringify(report, null, 2)}\n` : `${chineseSummary(report)}\n`);
  if (report.status === 'failed') process.exitCode = 1;
  else if (report.status === 'needs-attention') process.exitCode = 2;
}

function main() {
  if (MODE === '--summary') return runSummary(REPORT_ARG);
  if (!['--check', '--json'].includes(MODE)) {
    process.stderr.write('用法：node health-check.cjs [--check | --json] | --summary <health-report.json>\n');
    process.exitCode = 2;
    return;
  }
  runHealthCheck(MODE === '--json');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
