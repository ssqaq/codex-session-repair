# 登录文件、TOML 和损坏历史恢复

1. `local-repair.cjs` 调用同目录的 `local_repair.py`。需要 Python 3.11+（标准库 `tomllib`、`sqlite3`）；可用 `CODEX_REPAIR_PYTHON` 指定解释器路径。新脚本不需要额外 pip/npm 包。原有脚本仍使用 Node.js 和 `sqlite3` CLI。
2. `CODEX_ROOT` 指定 Codex 数据目录，默认当前用户的 `.codex`。检查只读；报告不含 token、密钥或历史正文。`health-check.cjs` 会保存新检查的摘要和逐文件问题。
3. 用户要求“更新 Skill”只授权更新工具，不能据此批量修改真实会话。实际恢复只针对已授权的文件/会话；这些离线命令要求先关闭 Codex，在外部终端传入 `--runtime-stopped`。该参数是操作者的停机声明，脚本不会自行关闭进程，也不能检测其他机器上的写入者。

## 浏览器报 auth token is unavailable

1. 原因可能是浏览器需要的 OAuth 登录文件缺失。模型 API 能调用不代表浏览器具备登录态。先检查：

   ```powershell
   node .\scripts\local-repair.cjs --dry-run --auth
   ```

2. 只有 `auth.json` 不存在且找到唯一的可用 OAuth 备份，才报告 `repairable`。候选仅来自 Codex 根目录的 `auth.json.bak*` / `auth.json.*.bak`，内容相同的副本算一个。要求同时有 access/refresh token；已过期或损坏的 JWT 不会自动恢复。不会打印 token，也不会刷新 token、登录或改 provider。
3. 已有 `auth.json`（包括 API key 模式或损坏文件）一律保留。找不到备份、备份不唯一、已过期时，明确报告需选择备份或手动登录；不能声称所有 401 都可修复。显式选择备份必须在 `CODEX_ROOT` 内。
4. 关闭 Codex 后执行恢复；原备份仍保留：

   ```powershell
   node .\scripts\local-repair.cjs --apply --auth --runtime-stopped
   # 多个不同备份时，先使用相同参数 dry-run，再明确选择：
   node .\scripts\local-repair.cjs --apply --auth --auth-backup "<CODEX_ROOT>\auth.json.bak-日期" --runtime-stopped
   ```

5. 重开 Codex，使用浏览器工具做一次只读标签页列表检查。恢复文件只证明本地结构完整；服务器是否撤销凭据，仍需这一步验证。`plugin 401` 无可恢复的本地文件时仍走手动登录，不索要凭据。

## TOML 解析失败或项目路径乱码

1. 用真正的 TOML 解析器检查整个文件，不能用 `codex --help` 代替配置解析验证：

   ```powershell
   node .\scripts\local-repair.cjs --dry-run --config
   ```

2. 报告只显示错误位置，不回显配置正文。不能从乱码猜原目录。核对实际存在的路径后，指定报错行与正确路径；仅接受 `[projects."路径"]` 表头或 `model_instructions_file` 赋值行：

   ```powershell
   node .\scripts\local-repair.cjs --dry-run --config --config-line 165 --path "D:\实际项目"
   node .\scripts\local-repair.cjs --apply --config --config-line 165 --path "D:\实际项目" --runtime-stopped
   ```

3. 修改前备份整个配置，保留其他行、行尾和注释；修改结果必须能完整解析。其他语法错误、重复项目表或无法识别的行会阻止写入。合法但乱码的普通目录名不一定可识别，需要人工核对。原 `config-repair.cjs` 仍用于从 managed prompt 安装记录自动寻找模型指令文件。

## 截断 JSON、NUL 填充导致历史扫描中断

1. 检查所有未归档会话当前登记的历史文件；单个文件损坏不会中止其他文件扫描。未登记的旧 rollout 副本仍由原 `bulk-repair.cjs` 检查，不在这个新命令的自动修复范围内：

   ```powershell
   node .\scripts\local-repair.cjs --dry-run --all-unarchived
   node .\scripts\local-repair.cjs --dry-run --thread <THREAD_ID>
   ```

2. 报告包含问题行、字节位置、长度、种类和哈希。完整 JSON 外部的 NUL 填充替换成等长空格；纯 NUL 行用无消息、无 token 总数的 `token_count` 空事件占位。正常记录逐字节保留。文件大小、换行和其他记录位置保持不变。
3. 截断原文无法凭空补回。取得用户对隔离这些坏行的授权后才传 `--quarantine-invalid`：先完整备份，再将坏行替换为等长的空事件，占位保留可识别的顶层 ordinal。完整原文仍在备份，manifest 记录受影响位置。不能说被截断的内容已恢复。

   ```powershell
   # 只有 NUL 填充：
   node .\scripts\local-repair.cjs --apply --thread <THREAD_ID> --runtime-stopped
   # 包含无法解析的长行，且用户已授权隔离：
   node .\scripts\local-repair.cjs --apply --thread <THREAD_ID> --quarantine-invalid --runtime-stopped
   ```

4. 文件头不匹配、坏行过短放不下占位事件、归档会话、多个会话共用文件、路径在 `sessions` 外或文件在预检后变化，都会阻止写入。工具不删除分页缓存、不调整 provider、不清理普通消息。数据库不发生行更新。
5. 运行原有 `bulk-repair.cjs --dry-run --thread <THREAD_ID>`，必要时检查 `sync-projection.cjs`，然后重开 Codex 做一次真实续聊。`validated-static` 只代表静态恢复通过；需要能续聊才算会话修好。

## 回滚

1. 每次写入前生成 `CODEX_ROOT/backups/local-repair-*/manifest.json` 和原文件备份。使用该次报告里的 manifest：

   ```powershell
   node .\scripts\local-repair.cjs --rollback "<manifest.json>" --runtime-stopped
   ```

2. 回滚前检查目标与备份哈希、路径、会话归档状态。目标出现后续修改时拒绝覆盖。撤销登录恢复会删除本次创建的 `auth.json`，原 `.bak` 保留；配置与历史恢复为原始字节。备份可能包含凭据，必须留在本机，不能提交仓库或上传附件。

## 1210 与最新一轮诊断

1. `diagnose-runtime.cjs --thread <THREAD_ID>` 优先从原始 JSONL 读取最新一轮，避免分页缓存旧序号覆盖最新报错；新一轮已成功就不会继续把更早的失败当作当前错误。
2. `1210 / messages.content.type ... ['text']` 表示当前服务端内容格式不兼容，可能是非文本历史或中转格式映射。此版本提供识别和处理指引，不自动改中转站，也不删除图片/工具结果。应核对服务商支持的内容类型，选择兼容模型或修复服务商映射，再复测同一任务。不能把它当作 `call_id` 错误改写。
3. 单独的 `stream disconnected before completion` 只说明流断开，不足以断言服务商过载；仅含明确 overloaded 错误时才建议按过载重试。
