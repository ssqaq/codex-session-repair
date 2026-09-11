# 首页图片来源

## 中文功能图和流程图

1. `overview.svg` / `overview.png`：功能总览，依据 `SKILL.md`、`scripts/` 和 `references/local-recovery.md` 整理。
2. `repair-flow.svg` / `repair-flow.png`：检查、确认范围、备份处理、静态验证、真实续聊的流程。
3. `setup-flow.svg` / `setup-flow.png`：Windows 下载、安装到用户级技能目录、重开 Codex、点名调用。

以上是说明用的示意图，不是软件截图。使用 diagram-generator 的 SVG 工作流制作，SVG 为可编辑源文件，PNG 为首页显示版本；配色和图文顺序参考 `ssqaq/codex-with-chatgpt-skill`。已检查中文显示和文字边界。

## 报告截图

1. `report-check.png`：真实 `bulk-repair.cjs --dry-run` HTML 报告顶部。
2. `report-result.png`：真实 `bulk-repair.cjs --apply` HTML 报告底部的验证结果。

截图日期：2026-09-12（北京时间）。脚本版本：`1.10.0`，基于提交 `8a97bd4`。报告内 UTC 时间为 2026-09-11，两者是同一次运行。

这些截图由浏览器打开原脚本生成的报告页面后直接截取，未修改页面样式或报告数值。采用临时目录里的两条合成示例会话，未读取或修复使用者的真实 Codex 会话。截图内路径均属于该示例临时目录；示例没有登录凭据或真实聊天。

| 序号 | 检查项 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| 1 | 旧 provider 数据库会话 | 2 | 0 |
| 2 | 缺少 call_id 的已识别通知 | 2 | 0 |
| 3 | JSON 错误 | 0 | 0 |
| 4 | 文件大小异常 | 不适用 | 0 |
| 5 | 未修改区域哈希异常 | 不适用 | 0 |

`complete` 表示这次脚本和静态验证完成。示例没有在 Codex 桌面端真实续聊，不把它当成在线修复成功证据。

## 怎样复现报告

准备 Python 3.11+、Node.js 和 sqlite3 CLI，在仓库根目录运行：

```powershell
python .\docs\examples\create-report-demo.py
```

1. 脚本自动创建新的临时目录，复制原修复脚本，写入两条示例会话。
2. 它仅对示例目录执行检查和修复；子进程的 `CODEX_ROOT` 固定为这个新目录。
3. 终端输出 `before.html`、`after.html` 路径及各自的 SHA-256。
4. 用浏览器打开 `before.html` 看顶部；打开 `after.html` 滚到页面底部，可看到截图中的报告结构和验证数值。时间和临时路径每次不同。

不要用真实账号的历史、登录文件或备份来重制公开截图。报告、数据库和备份留在本机；仓库仅保存图、说明及示例生成脚本。
