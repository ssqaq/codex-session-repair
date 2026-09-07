# Codex Session Repair

Codex Skill for safely repairing unarchived local sessions affected by the legacy `codex_local_access` provider or recognized missing-`call_id` heartbeat and cross-session notifications.

## Usage

Run a read-only preflight first:

```powershell
node .\scripts\bulk-repair.cjs --dry-run
```

After reviewing the preflight and explicitly authorizing the local mutation:

```powershell
node .\scripts\bulk-repair.cjs --apply
```

Each apply run creates a SQLite backup, compressed affected-line backups, a manifest, and validation reports. Roll back with the manifest emitted by that run:

```powershell
node .\scripts\bulk-repair.cjs --rollback .\run-...\manifest.json
```

The tool reads `CODEX_ROOT` when set and otherwise uses the standard Windows Codex home. It only targets `archived=0` rows whose provider is `codex_local_access`.

Do not commit local Codex databases, rollout JSONL files, configuration files, API keys, manifests containing history, or backup directories.
