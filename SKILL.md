---
name: codex-session-repair
description: 检查、修复和清理本地 Codex 会话。用于旧 provider、缺少 call_id、续聊失败、模型指令路径或 TOML 错误、浏览器 auth token 不可用、JSONL 截断和 NUL 填充；可从本地备份恢复丢失的登录文件，隔离损坏历史，诊断 1210 内容类型不兼容，并清理归档和重复备份。不自动登录，不修改项目业务代码。
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
| 浏览器 `auth token is unavailable`、`auth.json` 被改名 | 先运行 `local-repair.cjs --dry-run --auth`；仅在登录文件缺失且备份唯一可用时恢复，保留原备份，不覆盖已有登录文件。 |
| `TOML parse error`、项目表头路径转义错误 | 使用 `local-repair.cjs --dry-run --config` 检查整个 TOML；指定实际存在的路径和行号后修复。 |
| `Unterminated string in JSON`、NUL 填充、扫描中断 | 用 `local-repair.cjs --dry-run --all-unarchived` 汇总损坏文件，再逐会话恢复；不能补回的坏行须获授权后隔离。 |
| `1210`、`messages.content.type ... ['text']` | 用 `diagnose-runtime.cjs` 识别内容格式不兼容，核对模型/服务商映射；不自动删除图片，也不当作 `call_id` 错误处理。 |
| `servers are currently overloaded` | 中转站过载，等待后重试，不继续改历史。 |
| `plugin 401` | 不自动登录或索要账号；只有确认本地登录文件缺失时才检查可恢复的备份，其他 401 跳过。 |

## 登录文件、配置语法与损坏历史

遇到上表新增的登录文件、TOML 或 JSONL 损坏问题，先读 [references/local-recovery.md](references/local-recovery.md)。其中给出具体命令、修复范围、备份与回滚方法。

1. 新检查需要 Python 3.11+，可用 `CODEX_REPAIR_PYTHON` 指定；健康检查会自动汇总登录文件、TOML 和当前登记历史文件的问题，一个坏文件不影响新检查扫描其他文件。
2. `local-repair.cjs` 默认只读。实际修改只针对用户授权的对象，需关闭 Codex 后在外部终端执行，并传入 `--runtime-stopped`；更新 Skill 本身不等于授权修改真实会话。
3. 历史恢复保留文件大小和正常记录的字节位置；完整原文留在本地备份。截断坏行只能隔离，不能称为恢复原文；`--quarantine-invalid` 需要用户已授权接受这种处理。
4. 新命令通过后仍需真实续聊/浏览器列表验证，不能把 `validated-static` 报告当作在线恢复成功。

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
- Keep model, title, directory, timestamps, archive state, ordinary messages, and all unmodified bytes unchanged. The separate local history recovery may replace only reported damaged/padding lines with same-length empty usage events, with complete backups and explicit quarantine authorization for invalid JSON.
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

5. Diagnose the live continuation state before declaring success. Run `diagnose-runtime.cjs --thread <THREAD_ID>` after the static checks; it prefers the latest raw rollout turn over stale projection ordinals and does not revive older errors after a successful turn. If the latest turn is `call_id_continuation`, reload the Codex runtime by navigating away and back and perform one real no-tool continuation test. If the same error repeats, fork the completed history into a new task or restart the Codex desktop process; do not keep rewriting clean history. If the latest error is `upstream_overloaded`, wait and retry; a generic disconnected stream alone does not establish overload. For `unsupported_content_type`, follow the 1210 guidance in the local recovery reference. A repair is complete only when static checks and a real continuation test both pass.

6. If validation fails or the user requests reversal, use the exact `manifest.json` emitted by that run:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --rollback "<manifest.json>"
   ```

7. Keep all reports and backups local. Never commit `state_5.sqlite`, `thread_history_1.sqlite`, rollout JSONL files, manifests containing history, `config.toml`, API keys, or backup directories to a repository.

## Boundaries

The featured-plugin 401 may require ChatGPT authentication. Local backup recovery only addresses a missing auth.json with an identifiable OAuth backup; it does not establish token validity on the server. Never request credentials or attempt login as part of this skill. Do not create automations unless the user separately asks for them.
