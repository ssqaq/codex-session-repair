---
name: codex-session-repair
description: 修复 Codex 未归档会话报错：旧 provider、缺少 call_id、分页缓存残留、续聊状态错误和中转站过载。自动检查、备份、修复、回滚并做真实续聊验证。只要用户提到 Codex 会话报错、续聊失败、function_call_output、previous_response_id，或要求批量修复未归档会话，就使用这个 Skill；不处理 plugin 401 登录问题、归档会话或项目代码。
---

# Codex 修复会话报错

这个 Skill 专门修复 Codex 左侧未归档会话里的常见报错。它会先检查，再备份和修改，最后真实续聊验证；只做静态扫描不算修好。

## 看到什么报错怎么处理

| 看到的内容 | 处理方式 |
| --- | --- |
| `codex_local_access`、provider 错误 | 把目标会话切到当前有效的 `custom` provider。 |
| `function_call_output requires call_id`、缺少 `call_id` | 把已识别的心跳/跨会话通知改成普通用户历史消息，不伪造 `call_id`。 |
| 静态检查通过，但 `previous_response_id` 仍续聊失败 | 诊断并刷新 Codex 运行态；必要时重启客户端或从已完成历史 fork 新 task。 |
| `functionCallOutput` 出现在分页缓存里 | 同步 `thread_history_1.sqlite` 投影缓存。 |
| `servers are currently overloaded` | 中转站过载，等待后重试，不继续改历史。 |
| `plugin 401` | 这是登录问题；本 Skill 不登录、不索要账号，直接跳过。 |

## Scope and invariants

- Work only on the local Codex home (`CODEX_ROOT`, default `C:\\Users\\Administrator\\.codex`). Never touch project source code.
- Without a selector, the target set is re-read from `state_5.sqlite` at execution time: `archived=0 AND model_provider='codex_local_access'`. With explicit `--thread` or `--name`, an unarchived `custom` session is also eligible so recognized missing-`call_id` notifications can be repaired without changing its provider.
- Keep model, title, directory, timestamps, archive state, ordinary messages, and all unmodified bytes unchanged.
- For old-provider targets, change the database provider to `custom` only after the history preflight succeeds; explicitly selected `custom` targets keep their provider.
- Rewrite only recognized missing-`call_id` heartbeat or cross-session notification records, including their `function_call_output`/`FunctionCallOutput` event representations, as ordinary user history messages. Preserve message IDs, notification text, and internal metadata; never invent a `call_id`.
- Keep the paginated projection (`thread_history_1.sqlite`) consistent with those in-place JSONL rewrites. Only the matching `functionCallOutput` projection rows are changed to the corresponding `userMessage` item; create a projection backup and manifest before writing.
- Require `[model_providers.custom]`, `model_provider="custom"`, and `wire_api="responses"` in `config.toml` before any apply.
- Do not modify `config.toml` during repair. Do not repair archived sessions.
- A clean JSONL/projection scan does not prove that a live Codex task is usable. Always classify the latest real turn as data corruption, poisoned runtime continuation state, or upstream overload.

## Procedure

1. Run a dry-run first:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --dry-run
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
