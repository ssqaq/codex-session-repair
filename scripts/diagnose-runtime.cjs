#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const readline = require('node:readline');

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
  if (text.includes('function_call_output requires call_id') || text.includes('previous_response_id') ||
      text.includes('function call output without a call_id')) {
    return 'call_id_continuation';
  }
  if (text.includes('messages.content.type') &&
      (text.includes('1210') || text.includes('text'))) return 'unsupported_content_type';
  if (text.includes('auth token is unavailable') || text.includes('auth token is not available')) return 'missing_browser_auth';
  if (text.includes('toml parse error') || text.includes('invalid escape sequence')) return 'invalid_config_toml';
  if (text.includes('unterminated string in json') || text.includes('json 解析失败')) return 'damaged_history_json';
  if (text.includes('servers are currently overloaded')) {
    return 'upstream_overloaded';
  }
  if (text.includes('stream disconnected before completion')) return 'stream_disconnected';
  return text ? 'other' : null;
}

// Projection ordinals can be stale after compaction/older repairs. The source file is authoritative.
async function collectRolloutTurns(filePath) {
  const turns = new Map();
  let jsonErrors = 0;
  let line = 0;
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of reader) {
      line += 1;
      if (!raw.trim()) continue;
      let record;
      try { record = JSON.parse(raw); } catch { jsonErrors += 1; continue; }
      if (!record || typeof record !== 'object') { jsonErrors += 1; continue; }
      const p = record.payload;
      if (record.type !== 'event_msg' || !p?.turn_id ||
          !['task_started', 'task_complete', 'turn_aborted'].includes(p.type)) continue;
      const error = p.error ? (typeof p.error === 'string' ? p.error : JSON.stringify(p.error)) : null;
      const prior = turns.get(p.turn_id);
      turns.set(p.turn_id, {
        turnId: p.turn_id,
        rolloutOrdinal: record.ordinal ?? line,
        status: p.type === 'turn_aborted' ? 'interrupted' : p.type === 'task_started' ? 'inProgress' : error ? 'failed' : 'completed',
        errorClass: classifyError(error), error,
        source: 'rollout', line, startedLine: prior?.startedLine ?? line,
      });
    }
  } finally { reader.close(); input.destroy(); }
  return { turns: [...turns.values()].sort((a, b) => b.startedLine - a.startedLine).slice(0, 8), jsonErrors };
}

async function diagnoseThread(row) {
  const projectedTurns = sqlite(
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
  const source = fs.existsSync(row.rollout_path) ? await collectRolloutTurns(row.rollout_path) : { turns: [], jsonErrors: 0 };
  const recentTurns = source.turns.length ? source.turns : projectedTurns;
  // A successful new turn clears older failures; never revive them with find(errorClass).
  const latestErrorClass = recentTurns[0]?.errorClass || null;
  let diagnosis = 'clean_or_unverified';
  let recommendedAction = 'run_bulk_and_projection_dry_run_then_real_continuation_test';
  if (!fs.existsSync(row.rollout_path)) {
    diagnosis = 'missing_history_file';
    recommendedAction = 'stop_and_restore_from_manifest';
  } else if (source.jsonErrors) {
    diagnosis = 'damaged_history_json';
    recommendedAction = 'run_local_repair_dry_run_and_review_quarantine_plan';
  } else if (latestErrorClass === 'unsupported_content_type') {
    diagnosis = 'provider_rejects_non_text_content';
    recommendedAction = 'use_image_capable_model_or_fix_provider_content_mapping_then_verify_do_not_delete_images';
  } else if (latestErrorClass === 'missing_browser_auth') {
    diagnosis = 'browser_auth_unavailable';
    recommendedAction = 'run_local_repair_auth_dry_run_restore_unique_local_backup_if_missing';
  } else if (latestErrorClass === 'invalid_config_toml') {
    diagnosis = 'invalid_config_toml';
    recommendedAction = 'run_local_repair_config_dry_run';
  } else if (projectionCount > 0) {
    diagnosis = 'stale_projection_function_call_output';
    recommendedAction = 'run_sync_projection_apply';
  } else if (latestErrorClass === 'call_id_continuation') {
    diagnosis = 'runtime_continuation_state_poisoned';
    recommendedAction = 'reload_codex_runtime_then_fork_and_verify_if_repeated';
  } else if (latestErrorClass === 'upstream_overloaded') {
    diagnosis = 'upstream_provider_overloaded';
    recommendedAction = 'wait_for_provider_and_retry_without_rewriting_history';
  } else if (latestErrorClass === 'stream_disconnected') {
    diagnosis = 'stream_disconnected_unknown_cause';
    recommendedAction = 'inspect_transport_and_provider_error_do_not_assume_overload';
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
    latestTurnSource: source.turns.length ? 'rollout' : 'projection',
    sourceJsonErrors: source.jsonErrors,
    recentTurns,
    diagnosis,
    recommendedAction,
  };
}

async function main() {
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
    threads: await Promise.all(rows.map(diagnoseThread)),
  }, null, 2) + '\n');
}

module.exports = { classifyError, collectRolloutTurns, diagnoseThread };
if (require.main === module) main().catch((error) => {
  process.stderr.write((error.stack || error.message) + '\n');
  process.exitCode = 1;
});
