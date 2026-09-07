# Codex 修复会话报错

Version: `1.6.1`

这是一个用来修复 Codex 左侧未归档会话报错的 Skill。它会先检查，再备份和修复，最后真实续聊验证是否真的恢复。

能处理：

- `codex_local_access` provider 报错
- 缺少 `call_id` 的心跳或跨会话通知
- 分页缓存里的旧 `functionCallOutput`
- `previous_response_id` 续聊状态污染
- 判断 `servers are currently overloaded` 是否只是中转站过载

不处理 `plugin 401`。这个错误需要登录账号，按用户要求直接跳过。

## 最短操作

先只检查，不改数据：

```powershell
node .\scripts\bulk-repair.cjs --dry-run
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
