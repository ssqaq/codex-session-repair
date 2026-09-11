---
name: codex-session-repair
description: 检查、修复和清理 Codex 会话：一条命令扫描全部未归档会话并输出中文短报告，修复旧 provider、缺少 call_id、分页缓存、续聊状态和 model_instructions_file 路径错误，安全删除归档会话并清理重复回滚备份。用户提到 Codex 会话报错、全量检查、续聊失败、function_call_output、previous_response_id、模型指令文件、os error 123、删除归档会话或清理重复备份时使用；不处理 plugin 401 登录问题或项目代码。
---

# Codex 修复会话报错

这个 Skill 专门修复 Codex 左侧未归档会话里的常见报错。它会先检查，再备份和修改，最后真实续聊验证；只做静态扫描不算修好。

## 一条命令检查全部会话

优先使用统一健康检查。它会扫描全部未归档会话，同时检查归档残留和重复备份；默认只输出短中文摘要，完整报告保存在 `scripts/reports/`：

```powershell
node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\health-check.cjs"
```

需要机器读取的完整结果时加 `--json`。重新显示已有报告的中文摘要时使用：

```powershell
node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\health-check.cjs" --summary "<health-report.json>"
```

健康检查只读。退出码 `0` 表示正常，`2` 表示发现待处理项，`1` 表示检查失败。

## 看到什么报错怎么处理

| 看到的内容 | 处理方式 |
| --- | --- |
| `codex_local_access`、provider 错误 | 把目标会话切到当前有效的 `custom` provider。 |
| `function_call_output requires call_id`、缺少 `call_id` | 把已识别的心跳/跨会话通知改成普通用户历史消息，不伪造 `call_id`。 |
| 静态检查通过，但 `previous_response_id` 仍续聊失败 | 诊断并刷新 Codex 运行态；必要时重启客户端或从已完成历史 fork 新 task。 |
| `functionCallOutput` 出现在分页缓存里 | 同步 `thread_history_1.sqlite` 投影缓存。 |
| `failed to read model instructions file`、`os error 123` | 检查 `config.toml` 的 `model_instructions_file`；发现乱码、非法字符或失效路径时，先备份再改成唯一可读的 managed prompt 文件。 |
| `servers are currently overloaded` | 中转站过载，等待后重试，不继续改历史。 |
| `plugin 401` | 这是登录问题；本 Skill 不登录、不索要账号，直接跳过。 |

## 修复模型指令文件路径错误

截图里常见的红框是配置文件把中文文件名写成乱码，或者路径里混进了 Windows 不允许的字符（例如 `?`）。先只检查：

```powershell
node .\scripts\config-repair.cjs --dry-run
```

如果结果是 `repairable`，执行修复。工具会备份整个 `config.toml`，只改 `model_instructions_file` 这一行，写完后马上重新读取文件验证：

```powershell
node .\scripts\config-repair.cjs --apply
```

需要撤销时使用输出的 manifest：

```powershell
node .\scripts\config-repair.cjs --rollback .\config-repair-...\manifest.json
```

它会优先使用 `managed-prompts\install-state.json` 指向的文件；没有安装记录时，只有找到唯一 `.md` 候选才会自动修复，候选不唯一就停下来，不会猜错文件。修完后重启 Codex 桌面端，让它重新加载配置。

## 清理归档会话和重复备份

删除归档会话前先预览范围：

```powershell
node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\delete-archived.cjs" --dry-run
```

确认数量和范围后再删除。工具只处理 `archived=1`，会先备份数据库、分页缓存、索引和归档历史；删除后立即验证，失败会自动恢复：

```powershell
node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\delete-archived.cjs" --apply
```

需要撤销时使用删除报告里的 manifest：

```powershell
node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\delete-archived.cjs" --rollback "<archived-delete-manifest.json>"
```

修复备份会按会话去重：每个会话保留最新一份完整回滚备份，旧的重复备份和未完成备份只在 dry-run 列出，确认后再清理：

```powershell
node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\cleanup-backups.cjs" --dry-run
node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\cleanup-backups.cjs" --apply
```

清理工具只删除自身识别的 `run-*`、`projection-run-*` 和 `archived-delete-*` 旧备份目录，并为本次清理留下 manifest；不会碰会话数据库、历史文件或最新保留备份。

## Scope and invariants

- Work only on the local Codex home (`CODEX_ROOT`, default `C:\\Users\\Administrator\\.codex`). Never touch project source code.
- Without a selector, the target set is re-read from `state_5.sqlite` at execution time: `archived=0 AND model_provider='codex_local_access'`. With explicit `--thread` or `--name`, an unarchived `custom` session is also eligible so recognized missing-`call_id` notifications can be repaired without changing its provider.
- Keep model, title, directory, timestamps, archive state, ordinary messages, and all unmodified bytes unchanged.
- For old-provider targets, change the database provider to `custom` only after the history preflight succeeds; explicitly selected `custom` targets keep their provider.
- Rewrite only recognized missing-`call_id` heartbeat or cross-session notification records, including their `function_call_output`/`FunctionCallOutput` event representations, as ordinary user history messages. Preserve message IDs, notification text, and internal metadata; never invent a `call_id`.
- Keep the paginated projection (`thread_history_1.sqlite`) consistent with those in-place JSONL rewrites. Only the matching `functionCallOutput` projection rows are changed to the corresponding `userMessage` item; create a projection backup and manifest before writing.
- Require `[model_providers.custom]`, `model_provider="custom"`, and `wire_api="responses"` in `config.toml` before session repair apply.
- `bulk-repair.cjs` does not modify `config.toml`; `config-repair.cjs` is the separate, explicit path repair command described above.
- Do not repair archived sessions.
- A clean JSONL/projection scan does not prove that a live Codex task is usable. Always classify the latest real turn as data corruption, poisoned runtime continuation state, or upstream overload.

## Procedure

1. Run a dry-run first:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --dry-run
   ```

   To audit every unarchived session, including sessions already on `custom`, use:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --dry-run --all-unarchived
   ```

   Use `--thread <thread-id>` for one session or `--name <text>` to match the visible session name/title literally:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --dry-run --name "关键词"
   ```

   名称筛选也可以直接用于正式修复：`node ... --apply --name "关键词"`。执行前仍会完整预检，并在报告中记录匹配范围。

   The tool checks SQLite integrity, the required `threads` table schema, and indexes covering `archived` and `model_provider` before scanning. Review target count, files, provider headers, recognized notifications, JSON errors, and minimum padding slack. Stop if schema/integrity/index checks, unknown notifications, JSON parsing, missing files, or padding checks fail. An explicitly selected `custom` session keeps its provider; only its recognized missing-`call_id` records are rewritten.

2. On explicit user authorization to mutate the local session store, run `--apply`. The tool creates a SQLite backup, compressed affected-line backups, a manifest, and reports. It checks hashes and file sizes before each write, writes replacements in place, validates all targets, and rolls back the affected session or the full run on failure.

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --apply
   ```

3. After apply, confirm the report shows zero database old-provider rows, zero old provider headers, zero missing `call_id` notifications, zero unknown notifications, zero JSON errors, zero size mismatches, zero unchanged-region hash mismatches, and zero row mismatches.
   JSON and HTML reports are written beside the manifest; the HTML file can be opened directly in a browser.

4. For paginated sessions, synchronize the projection after the JSONL apply. Use explicit unarchived thread IDs only:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\sync-projection.cjs" --dry-run --thread <THREAD_ID>
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\sync-projection.cjs" --apply --thread <THREAD_ID>
   ```

   The synchronizer refuses archived sessions, requires every old projection item to match a rewritten JSONL item, updates only those rows, validates SQLite integrity and leaves a rollback manifest. Roll back with:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\sync-projection.cjs" --rollback "<projection-manifest.json>"
   ```

5. Diagnose the live continuation state before declaring success. Run `diagnose-runtime.cjs --thread <THREAD_ID>` after the static checks. If the latest turn is `call_id_continuation`, reload the Codex runtime by navigating away and back and perform one real no-tool continuation test. If the same error repeats, fork the completed history into a new task or restart the Codex desktop process; do not keep rewriting clean history. If the latest error is `upstream_overloaded`, wait and retry; it is not a local history repair failure. A repair is complete only when static checks and a real continuation test both pass.

6. If validation fails or the user requests reversal, use the exact `manifest.json` emitted by that run:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --rollback "<manifest.json>"
   ```

7. Keep all reports and backups local. Never commit `state_5.sqlite`, `thread_history_1.sqlite`, rollout JSONL files, manifests containing history, `config.toml`, API keys, or backup directories to a repository.

## Boundaries

The featured-plugin 401 requires ChatGPT authentication and is independent of the local session repair. Treat it as a separately reported, user-skippable check; never request credentials or attempt login as part of this skill. Do not create automations unless the user separately asks for them.
