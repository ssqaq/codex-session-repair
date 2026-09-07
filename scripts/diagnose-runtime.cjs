#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = process.env.CODEX_ROOT || 'C:/Users/Administrator/.codex';
const STATE_DB = path.join(ROOT, 'state_5.sqlite');
const PROJECTION_DB = path.join(ROOT, 'thread_history_1.sqlite');

function fail(message) { throw new Error(message); }
function sqlQuote(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }

function sqlite(query, database) {
  const output = execFileSync(
    'sqlite3',
    ['-cmd', '.timeout 15000', '-json', database, query],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  return output ? JSON.parse(output) : [];
}

function parseArgs() {
  const ids = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--thread') {
      const id = args[++i];
      if (!id) fail('--thread 缺少会话 ID。');
      ids.push(id);
    } else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write('用法：node diagnose-runtime.cjs --thread <THREAD_ID> [--thread <THREAD_ID> ...]\n');
      process.exit(0);
    } else {
      fail('未知参数：' + args[i]);
    }
  }
  if (!ids.length) fail('必须明确指定至少一个 --thread。');
  return [...new Set(ids)];
}

function classifyError(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('function_call_output requires call_id') || text.includes('previous_response_id')) {
    return 'call_id_continuation';
  }
  if (text.includes('servers are currently overloaded') || text.includes('stream disconnected before completion')) {
    return 'upstream_overloaded';
  }
  return text ? 'other' : null;
}

function diagnoseThread(row) {
  const recentTurns = sqlite(
    'SELECT turn_id, rollout_ordinal, status, error_json FROM thread_turns ' +
    'WHERE thread_id=' + sqlQuote(row.id) + ' ORDER BY rollout_ordinal DESC LIMIT 8;',
    PROJECTION_DB,
  ).map((turn) => ({
    turnId: turn.turn_id,
    rolloutOrdinal: turn.rollout_ordinal,
    status: turn.status,
    errorClass: classifyError(turn.error_json),
    error: turn.error_json || null,
  }));
  const projectionCount = sqlite(
    'SELECT COUNT(*) AS count FROM thread_items WHERE thread_id=' +
    sqlQuote(row.id) + " AND item_type='functionCallOutput';",
    PROJECTION_DB,
  )[0]?.count || 0;
  const latestErrorClass = recentTurns.find((turn) => turn.errorClass)?.errorClass || null;
  let diagnosis = 'clean_or_unverified';
  let recommendedAction = 'run_bulk_and_projection_dry_run_then_real_continuation_test';
  if (!fs.existsSync(row.rollout_path)) {
    diagnosis = 'missing_history_file';
    recommendedAction = 'stop_and_restore_from_manifest';
  } else if (projectionCount > 0) {
    diagnosis = 'stale_projection_function_call_output';
    recommendedAction = 'run_sync_projection_apply';
  } else if (latestErrorClass === 'call_id_continuation') {
    diagnosis = 'runtime_continuation_state_poisoned';
    recommendedAction = 'reload_codex_runtime_then_fork_and_verify_if_repeated';
  } else if (latestErrorClass === 'upstream_overloaded') {
    diagnosis = 'upstream_provider_overloaded';
    recommendedAction = 'wait_for_provider_and_retry_without_rewriting_history';
  } else if (latestErrorClass === 'other') {
    diagnosis = 'unclassified_runtime_error';
    recommendedAction = 'inspect_latest_turn_error_before_mutation';
  }
  return {
    id: row.id,
    archived: row.archived,
    modelProvider: row.model_provider,
    model: row.model,
    historyMode: row.history_mode,
    historyPath: row.rollout_path,
    historyExists: fs.existsSync(row.rollout_path),
    projectionFunctionCallOutputCount: projectionCount,
    latestErrorClass,
    recentTurns,
    diagnosis,
    recommendedAction,
  };
}

function main() {
  const ids = parseArgs();
  if (!fs.existsSync(STATE_DB) || !fs.existsSync(PROJECTION_DB)) fail('Codex SQLite 数据库不存在。');
  const rows = sqlite(
    'SELECT id, archived, model_provider, model, history_mode, rollout_path FROM threads ' +
    'WHERE id IN (' + ids.map(sqlQuote).join(',') + ') ORDER BY id;',
    STATE_DB,
  );
  const found = new Set(rows.map((row) => row.id));
  for (const id of ids) if (!found.has(id)) fail('找不到会话：' + id);
  process.stdout.write(JSON.stringify({
    checkedAt: new Date().toISOString(),
    stateDatabase: STATE_DB,
    projectionDatabase: PROJECTION_DB,
    threads: rows.map(diagnoseThread),
  }, null, 2) + '\n');
}

try { main(); } catch (error) {
  process.stderr.write((error.stack || error.message) + '\n');
  process.exitCode = 1;
}
