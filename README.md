# Codex Session Repair

Version: `1.5.0`

Codex Skill for safely repairing unarchived local sessions affected by the legacy `codex_local_access` provider or recognized missing-`call_id` heartbeat and cross-session notifications. It repairs both the API `function_call_output` record and the matching `FunctionCallOutput` event record when both are present.

## Usage

Run a read-only preflight first:

```powershell
node .\scripts\bulk-repair.cjs --dry-run
```

只检查一个会话：

```powershell
node .\scripts\bulk-repair.cjs --dry-run --thread <thread-id>
```

按会话名称或标题筛选：

```powershell
node .\scripts\bulk-repair.cjs --dry-run --name "关键词"
```

按名称直接修复：

```powershell
node .\scripts\bulk-repair.cjs --apply --name "关键词"
```

After reviewing the preflight and explicitly authorizing the local mutation:

```powershell
node .\scripts\bulk-repair.cjs --apply
```

Each apply run creates a SQLite backup, compressed affected-line backups, a manifest, and validation reports. Roll back with the manifest emitted by that run:

```powershell
node .\scripts\bulk-repair.cjs --rollback .\run-...\manifest.json
```

把 JSON 报告转成中文摘要：

```powershell
node .\scripts\bulk-repair.cjs --summary .\run-...\repair-report.json
```

每次 dry-run 和 apply 都会先执行 SQLite `PRAGMA integrity_check`；检查不通过会立即停止。
同时会检查 `threads` 表是否包含必要字段和主键，以及 `archived`、`model_provider` 关键索引。apply 完成后会生成 Markdown、JSON 和 HTML 报告。

分页会话还要同步 `thread_history_1.sqlite` 的投影缓存，否则 Codex 续聊仍可能读取旧的 `functionCallOutput`。只对明确指定的未归档会话执行：

```powershell
node .\scripts\sync-projection.cjs --dry-run --thread <thread-id>
node .\scripts\sync-projection.cjs --apply --thread <thread-id>
```

同步器会为分页数据库生成备份和 manifest，只把已经在 JSONL 中改成 `userMessage` 的对应缓存行原子更新；需要撤销时使用：

```powershell
node .\scripts\sync-projection.cjs --rollback .\projection-run-...\manifest.json
```

The tool reads `CODEX_ROOT` when set and otherwise uses the standard Windows Codex home. Without a selector it targets `archived=0` rows whose provider is `codex_local_access`. An explicit `--thread` or `--name` selector may also target an unarchived `custom` session to repair recognized missing-`call_id` records while leaving its provider unchanged.

Do not commit local Codex databases, rollout JSONL files, configuration files, API keys, manifests containing history, or backup directories.
