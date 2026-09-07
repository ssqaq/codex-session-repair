---
name: codex-session-repair
description: Safely inspect and repair unarchived Codex session provider and missing call_id errors with dry-run, backups, rollback, and byte-preserving verification. Use for local Codex session maintenance; do not use for archived sessions or unrelated project code.
---

# Codex Session Repair

Use this skill when Codex history shows provider errors involving `codex_local_access`, missing `call_id` heartbeat or cross-session notifications, or when the user asks to repair all affected unarchived sessions.

## Scope and invariants

- Work only on the local Codex home (`CODEX_ROOT`, default `C:\\Users\\Administrator\\.codex`). Never touch project source code.
- The target set is re-read from `state_5.sqlite` at execution time: `archived=0 AND model_provider='codex_local_access'`.
- Keep model, title, directory, timestamps, archive state, ordinary messages, and all unmodified bytes unchanged.
- Change the database provider to `custom` only after the history preflight succeeds and only for the target rows.
- Rewrite only recognized missing-`call_id` heartbeat or cross-session notification records as ordinary user history messages. Preserve message IDs, notification text, and internal metadata; never invent a `call_id`.
- Require `[model_providers.custom]`, `model_provider="custom"`, and `wire_api="responses"` in `config.toml` before any apply.
- Do not modify `config.toml` during repair. Do not repair archived sessions.

## Procedure

1. Run a dry-run first:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --dry-run
   ```

   Use `--thread <thread-id>` for one session or `--name <text>` to match the visible session name/title literally:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --dry-run --name "关键词"
   ```

   The tool checks SQLite integrity and the required `threads` table schema before scanning. Review target count, files, provider headers, recognized notifications, JSON errors, and minimum padding slack. Stop if schema/integrity checks, unknown notifications, JSON parsing, missing files, or padding checks fail.

2. On explicit user authorization to mutate the local session store, run `--apply`. The tool creates a SQLite backup, compressed affected-line backups, a manifest, and reports. It checks hashes and file sizes before each write, writes replacements in place, validates all targets, and rolls back the affected session or the full run on failure.

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --apply
   ```

3. After apply, confirm the report shows zero database old-provider rows, zero old provider headers, zero missing `call_id` notifications, zero unknown notifications, zero JSON errors, zero size mismatches, zero unchanged-region hash mismatches, and zero row mismatches.
   JSON and HTML reports are written beside the manifest; the HTML file can be opened directly in a browser.

4. If validation fails or the user requests reversal, use the exact `manifest.json` emitted by that run:

   ```powershell
   node "$env:USERPROFILE\\.codex\\skills\\codex-session-repair\\scripts\\bulk-repair.cjs" --rollback "<manifest.json>"
   ```

5. Keep all reports and backups local. Never commit `state_5.sqlite`, rollout JSONL files, manifests containing history, `config.toml`, API keys, or backup directories to a repository.

## Boundaries

The featured-plugin 401 requires ChatGPT authentication and is independent of the local session repair. Treat it as a separately reported, user-skippable check; never request credentials or attempt login as part of this skill. Do not create automations unless the user separately asks for them.
