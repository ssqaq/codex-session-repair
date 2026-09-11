# Codex 修复会话报错

Version: `1.10.0`

这是一个用来修复和清理 Codex 会话的 Skill。它会先检查，再备份和处理，最后验证结果。

能处理：

- `codex_local_access` provider 报错
- 缺少 `call_id` 的心跳或跨会话通知
- 分页缓存里的旧 `functionCallOutput`
- `previous_response_id` 续聊状态污染
- 判断 `servers are currently overloaded` 是否只是中转站过载
- `model_instructions_file` 乱码、非法路径和 `os error 123`
- 浏览器登录文件 `auth.json` 被改名：从唯一可用的本地备份恢复
- `config.toml` 项目路径转义错误：检查整个 TOML，指定正确路径后只改目标行
- 截断 JSON / NUL 填充：逐文件报告，备份后原位处理，支持回滚
- `1210 / messages.content.type ... ['text']`：识别模型/服务商内容格式不兼容并给出处理指引
- 安全删除归档会话
- 每个会话只保留最新回滚备份，清理旧的重复坏备份
- 一条命令扫描全部未归档会话并输出中文短报告

不自动登录账号。只有确定 `auth.json` 丢失且存在可用本地备份时才恢复；已有登录文件、过期凭据、无备份的 `plugin 401` 仍需手动处理。

## 1.10.0 更新了什么

1. 以前浏览器提示“auth token 不可用”只能跳过；现在先查登录文件是不是被改名。有唯一可用备份就能恢复，原备份保留，已有登录文件不会被覆盖。
2. 以前只会修模型指令文件路径；现在也能查整个 `config.toml` 的语法。项目路径转义写坏时，指定真实路径和行号后，只改这一行，再完整解析验证。
3. 以前一个坏 JSON 行就会打断全量扫描；现在新增独立检查会列出各个损坏文件。NUL 填充可以原位处理；截断坏行经授权后隔离，完整原文保留在备份。正常记录、文件长度和字节位置保持不变。
4. 以前可能把分页缓存几天前的报错当成当前报错；现在优先读原始历史最新一轮，成功后的旧错误不会反复报。新增识别 `1210`，但不会删除图片或自动改中转站来“消除”错误。
5. 新功能需要 Python 3.11+，使用标准库，无额外 pip/npm 安装。Node.js、`sqlite3` CLI 仍是原有脚本的依赖。测试运行：`python -m unittest discover -s tests -p "test_*.py"` 和 `node --test tests/runtime.test.cjs`。

操作命令、适用范围、停机要求与回滚说明见 [本地恢复指南](references/local-recovery.md)。所有真实写入都要在授权范围内执行；安装/更新 Skill 不会自动修改会话。

## 一条命令检查全部会话

```powershell
node .\scripts\health-check.cjs
```

它会检查全部未归档会话、登录文件、TOML 语法、损坏历史、归档残留和重复备份。屏幕只显示关键数字，完整结果保存在 `scripts/reports/`。健康检查全程只读；OAuth 文件存在不代表在线登录已验证。

```powershell
node .\scripts\health-check.cjs --json
node .\scripts\health-check.cjs --summary "<health-report.json>"
```

退出码 `0` 表示正常，`2` 表示发现待处理项，`1` 表示检查本身失败。

## 修复创建聊天时报模型指令文件错误

如果看到 `failed to read model instructions file`、`feature override precedence` 或 `os error 123`，通常是 `config.toml` 里的模型指令文件路径被写成乱码，或者路径含有 Windows 禁止字符。先检查：

```powershell
node .\scripts\config-repair.cjs --dry-run
```

确认结果是 `repairable` 后执行：

```powershell
node .\scripts\config-repair.cjs --apply
```

工具会先备份 `config.toml`，只替换 `model_instructions_file` 这一行，并在写入后重新读取真实文件验证。撤销使用：

```powershell
node .\scripts\config-repair.cjs --rollback .\config-repair-...\manifest.json
```

修复后完全退出并重新打开 Codex，桌面端才会加载新路径。找不到唯一候选文件时工具会停止，不会随便猜一个 prompt。

## 最短操作

先只检查，不改数据：

```powershell
node .\scripts\bulk-repair.cjs --dry-run
```

扫描全部未归档会话，包括已经使用 `custom` 的会话：

```powershell
node .\scripts\bulk-repair.cjs --dry-run --all-unarchived
```

确认报告没有错误后，修复全部未归档的旧 provider 会话：

```powershell
node .\scripts\bulk-repair.cjs --apply
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

## 删除归档会话

先预览，不改数据：

```powershell
node .\scripts\delete-archived.cjs --dry-run
```

确认范围后执行。它只删 `archived=1`，会先备份 `state_5.sqlite`、`thread_history_1.sqlite`、索引和归档历史；删除后立即验证，失败会自动恢复：

```powershell
node .\scripts\delete-archived.cjs --apply
```

撤销删除：

```powershell
node .\scripts\delete-archived.cjs --rollback <archived-delete-manifest.json>
```

## 清理重复回滚备份

每个会话只保留最新一份完整回滚备份。先预览旧副本，再确认清理：

```powershell
node .\scripts\cleanup-backups.cjs --dry-run
node .\scripts\cleanup-backups.cjs --apply
```

清理工具只处理 `run-*`、`projection-run-*` 和 `archived-delete-*` 旧备份目录，保留每个会话的最新备份和清理 manifest，不碰 Codex 数据库和历史文件。

每次修复都会生成 SQLite 备份、受影响行的压缩备份、manifest 和验证报告。需要撤销时使用报告里的 manifest：

```powershell
node .\scripts\bulk-repair.cjs --rollback .\run-...\manifest.json
```

把 JSON 报告转成中文摘要：

```powershell
node .\scripts\bulk-repair.cjs --summary .\run-...\repair-report.json
```

每次 dry-run 和 apply 都会先检查 SQLite 完整性、表结构、关键索引、JSON 行和可原位写回的空间。检查不通过会立即停止。

分页会话还要同步 `thread_history_1.sqlite` 的投影缓存，否则 Codex 续聊仍可能读取旧的 `functionCallOutput`。只对明确指定的未归档会话执行：

```powershell
node .\scripts\sync-projection.cjs --dry-run --thread <thread-id>
node .\scripts\sync-projection.cjs --apply --thread <thread-id>
```

同步器会备份分页数据库，只更新已经在 JSONL 中修好的对应缓存行；需要撤销时使用：

```powershell
node .\scripts\sync-projection.cjs --rollback .\projection-run-...\manifest.json
```

修完后必须检查运行态：

```powershell
node .\\scripts\\diagnose-runtime.cjs --thread <thread-id>
```

如果静态检查通过但仍报 `function_call_output requires call_id` 或 `previous_response_id`，先切走会话再切回；还报错就重启 Codex，或从已完成历史 fork 新 task。若是 `servers are currently overloaded`，等中转站恢复后再试。只有静态检查和真实续聊都通过，才算修好。

不要把本地 Codex 数据库、JSONL 历史、配置、API key、含历史内容的 manifest 或备份目录提交到仓库。

工具读取 `CODEX_ROOT`（未设置时使用标准 Codex 目录），默认只处理未归档的 `codex_local_access`；明确指定会话时也可检查 `custom`。
