"""Generate genuine HTML reports using isolated, synthetic session data.

Run from anywhere with Python 3.11+, Node.js and sqlite3 on PATH.
All generated data stays in a new temporary folder; no real Codex data is read.
"""

from pathlib import Path
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile


def main():
    repo = Path(__file__).resolve().parents[2]
    demo = Path(tempfile.mkdtemp(prefix="codex-repair-docs-demo-"))
    root = demo / "sample-codex"
    root.mkdir()
    sessions = root / "sessions"
    sessions.mkdir()
    # Copy tools so their reports and backups also stay in the temporary folder.
    tool = demo / "tools" / "bulk-repair.cjs"
    tool.parent.mkdir()
    shutil.copyfile(repo / "scripts" / "bulk-repair.cjs", tool)
    (root / "config.toml").write_text(
        'model_provider = "custom"\n[model_providers.custom]\nwire_api = "responses"\n',
        encoding="utf-8",
    )
    db = sqlite3.connect(root / "state_5.sqlite")
    db.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, title TEXT, archived INTEGER)")
    db.execute("CREATE INDEX demo_scope ON threads (archived, model_provider)")
    for number in (1, 2):
        ident = f"00000000-0000-4000-8000-{number:012d}"
        history = sessions / f"demo-{ident}.jsonl"
        records = [
            {"type": "session_meta", "payload": {"id": ident, "model_provider": "codex_local_access"}},
            {"type": "response_item", "payload": {"type": "function_call_output", "id": f"demo-notice-{number}", "output": "<heartbeat>Documentation demo only.</heartbeat>"}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Synthetic example. No real conversation."}]}},
        ]
        history.write_text("".join(json.dumps(item) + " " * 256 + "\n" for item in records), encoding="utf-8")
        db.execute("INSERT INTO threads VALUES (?, ?, ?, ?, 0)", (ident, str(history), "codex_local_access", f"示例会话 {number}"))
    db.commit()
    db.close()
    env = {**os.environ, "CODEX_ROOT": str(root)}
    reports = {}
    for mode in ("--dry-run", "--apply"):
        result = subprocess.run(["node", str(tool), mode], env=env, capture_output=True, encoding="utf-8", check=True)
        report = json.loads(result.stdout)
        output = demo / ("before.html" if mode == "--dry-run" else "after.html")
        shutil.copyfile(report["htmlReportPath"], output)
        reports[mode] = {"status": report["status"], "html": str(output), "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}
    print(json.dumps({"demoDirectory": str(demo), "reports": reports}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
