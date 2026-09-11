#!/usr/bin/env node
'use strict';

// Python 3.11+ supplies a real TOML parser and read-only SQLite without npm dependencies.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.env.CODEX_REPAIR_PYTHON || 'python',
  [path.join(__dirname, 'local_repair.py'), ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } });
if (result.error) process.stderr.write('Cannot run Python 3.11+. Set CODEX_REPAIR_PYTHON to its executable.\n');
process.exitCode = result.error ? 1 : (result.status ?? 1);
