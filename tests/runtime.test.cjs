'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyError, collectRolloutTurns } = require('../scripts/diagnose-runtime.cjs');
const { collectIssues, compactLocal, chineseSummary } = require('../scripts/health-check.cjs');

test('classifies observed errors without labeling every stream interruption overloaded', () => {
  assert.equal(classifyError(`{"error":{"code":"1210","message":"messages.content.type 参数非法，取值范围 ['text']"}}`), 'unsupported_content_type');
  assert.equal(classifyError('auth token is unavailable'), 'missing_browser_auth');
  assert.equal(classifyError('TOML parse error at line 165, column 18'), 'invalid_config_toml');
  assert.equal(classifyError('Unterminated string in JSON at position 626264'), 'damaged_history_json');
  assert.equal(classifyError('A function call output without a call_id requires a name.'), 'call_id_continuation');
  assert.equal(classifyError('stream disconnected before completion'), 'stream_disconnected');
  assert.equal(classifyError('stream disconnected before completion: Our servers are currently overloaded.'), 'upstream_overloaded');
});

test('reads actual latest turn after ordinal reset and clears historical errors after success', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.jsonl');
  const record = (id, ordinal, error, type = 'task_complete') => JSON.stringify({ ordinal, type: 'event_msg', payload: { type, turn_id: id, error } });
  fs.writeFileSync(file, [record('old', 8000, 'previous_response_id bad'), record('new', 10, { message: "1210 messages.content.type ['text']" })].join('\n'));
  assert.equal((await collectRolloutTurns(file)).turns[0].errorClass, 'unsupported_content_type');
  fs.appendFileSync(file, '\n' + record('success', 20, null));
  const latest = (await collectRolloutTurns(file)).turns[0];
  assert.equal(latest.status, 'completed');
  assert.equal(latest.errorClass, null);
  fs.appendFileSync(file, '\n' + record('running', 21, null, 'task_started'));
  assert.equal((await collectRolloutTurns(file)).turns[0].status, 'inProgress');
});

test('damaged JSON does not hide the following completed turn', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.jsonl');
  fs.writeFileSync(file, '{truncated\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'last', error: null } }));
  const result = await collectRolloutTurns(file);
  assert.equal(result.jsonErrors, 1);
  assert.equal(result.turns[0].turnId, 'last');
});

test('new health sections expose damage even when legacy bulk scan fails and support older reports', () => {
  const checks = { sessions: { ok: false, error: 'corrupt JSON' }, archived: { ok: true }, backups: { ok: true }, config: { ok: true, status: 'healthy' } };
  const old = { status: 'failed', checks, reportPath: 'old.json' };
  assert.doesNotThrow(() => chineseSummary(old));
  checks.local = compactLocal({ ok: true, value: { summary: { damagedHistories: 2, invalidJsonLines: 3, nulPaddingLines: 1 }, checks: { auth: { status: 'repairable' }, configSyntax: { status: 'invalid-toml' }, histories: [] } } });
  const issues = collectIssues(checks);
  assert.ok(issues.some(i => i.kind === 'browser-auth'));
  assert.equal(issues.find(i => i.kind === 'damaged-history').count, 2);
  assert.match(chineseSummary(old), /损坏历史文件：2/);
});
