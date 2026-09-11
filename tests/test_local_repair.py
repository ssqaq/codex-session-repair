import base64
from contextlib import closing
import importlib.util
import json
import os
import shutil
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'local_repair.py'
spec = importlib.util.spec_from_file_location('local_repair', SCRIPT)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)
SECRET = 'synthetic-sensitive-value-do-not-log'


def auth(access=SECRET):
    return json.dumps({'tokens': {'access_token': access, 'refresh_token': SECRET + '-refresh'}}).encode()


class LocalRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='codex-repair-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'sessions').mkdir()
        (self.root / 'config.toml').write_text('model_provider = "custom"\n', encoding='utf-8')
        with closing(sqlite3.connect(self.root / 'state_5.sqlite')) as db, db:
            db.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER, rollout_path TEXT)')

    def run_cli(self, *args, code=0):
        result = subprocess.run([sys.executable, str(SCRIPT), *args],
                                env={**os.environ, 'CODEX_ROOT': str(self.root), 'PYTHONUTF8': '1'},
                                text=True, encoding='utf-8', capture_output=True)
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        return json.loads(result.stdout if code == 0 else result.stderr)

    def history(self, id_='one', middle=None, archived=0):
        file = self.root / 'sessions' / (id_ + '.jsonl')
        header = json.dumps({'type': 'session_meta', 'payload': {'id': id_}}).encode() + b'\r\n'
        good = b'{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"unchanged"}]}}\r\n'
        broken = b'{"timestamp":"2026-09-11T00:00:00Z","ordinal":88,"type":"response_item","payload":{"text":"' + b'x' * 400 + b'\r\n'
        file.write_bytes(header + (broken if middle is None else middle) + good)
        with closing(sqlite3.connect(self.root / 'state_5.sqlite')) as db, db:
            db.execute('INSERT INTO threads VALUES(?,?,?)', (id_, archived, str(file)))
        return file

    def test_auth_missing_unique_backup_restore_and_rollback(self):
        backup = self.root / 'auth.json.bak'
        backup.write_bytes(auth())
        self.assertEqual(self.run_cli('--auth')['checks']['auth']['status'], 'repairable')
        self.assertFalse((self.root / 'auth.json').exists())
        result = self.run_cli('--apply', '--auth', '--runtime-stopped')
        self.assertEqual((self.root / 'auth.json').read_bytes(), auth())
        self.assertEqual(backup.read_bytes(), auth())
        self.assertNotIn(SECRET, Path(result['manifestPath']).read_text())
        self.run_cli('--rollback', result['manifestPath'], '--runtime-stopped')
        self.assertFalse((self.root / 'auth.json').exists())

    def test_auth_existing_api_key_never_overwritten(self):
        original = json.dumps({'OPENAI_API_KEY': SECRET}).encode()
        (self.root / 'auth.json').write_bytes(original)
        (self.root / 'auth.json.bak').write_bytes(auth())
        self.run_cli('--apply', '--auth', '--runtime-stopped', code=1)
        self.assertEqual((self.root / 'auth.json').read_bytes(), original)

    def test_auth_ambiguous_requires_selected_backup(self):
        one, two = self.root / 'auth.json.bak', self.root / 'auth.json.bak-2'
        one.write_bytes(auth('first'))
        two.write_bytes(auth('second'))
        self.assertEqual(self.run_cli('--auth')['checks']['auth']['status'], 'ambiguous')
        self.run_cli('--apply', '--auth', '--runtime-stopped', code=1)
        self.run_cli('--apply', '--auth', '--auth-backup', str(two), '--runtime-stopped')
        self.assertEqual((self.root / 'auth.json').read_bytes(), two.read_bytes())

    def test_auth_identical_backups_deduplicate(self):
        for name in ['auth.json.bak', 'auth.json.bak-2']:
            (self.root / name).write_bytes(auth())
        self.assertEqual(self.run_cli('--auth')['checks']['auth']['status'], 'repairable')

    def test_expired_and_invalid_credentials_do_not_restore(self):
        claims = base64.urlsafe_b64encode(b'{"exp":1}').decode().rstrip('=')
        (self.root / 'auth.json.bak').write_bytes(auth('eyJhbGciOiJub25lIn0.' + claims + '.sig'))
        (self.root / 'auth.json.bak-invalid').write_text('{' + SECRET)
        self.assertEqual(self.run_cli('--auth')['checks']['auth']['status'], 'needs-login')
        self.run_cli('--apply', '--auth', '--runtime-stopped', code=1)

    def test_auth_restore_never_overwrites_racing_login(self):
        (self.root / 'auth.json.bak').write_bytes(auth())
        real_backup = repair.backup_manifest
        def race(*args, **kwargs):
            result = real_backup(*args, **kwargs)
            (self.root / 'auth.json').write_bytes(auth('new-login'))
            return result
        with patch.object(repair, 'backup_manifest', side_effect=race):
            with self.assertRaises(FileExistsError):
                repair.apply_auth(self.root, None)
        self.assertEqual((self.root / 'auth.json').read_bytes(), auth('new-login'))

    def test_mutations_require_offline_assertion(self):
        self.run_cli('--apply', '--auth', code=1)
        self.assertFalse((self.root / 'backups').exists())

    def test_toml_project_bad_escape_only_selected_line_changes(self):
        target = self.root / '中文项目'
        target.mkdir()
        before = ('model_provider = "custom"\r\n[projects."D:\\project\\folder"] # "keep comment"\r\ntrust_level = "trusted"\r\nsecret = "' + SECRET + '"\r\n').encode()
        config = self.root / 'config.toml'
        config.write_bytes(before)
        self.assertEqual(self.run_cli('--config')['checks']['configSyntax']['status'], 'invalid-toml')
        self.run_cli('--config', '--config-line', '2', '--path', str(target))
        self.assertEqual(config.read_bytes(), before)
        result = self.run_cli('--apply', '--config', '--config-line', '2', '--path', str(target), '--runtime-stopped')
        after = config.read_bytes()
        self.assertIn(b'# "keep comment"\r\n', after)
        self.assertEqual(before.splitlines(keepends=True)[2:], after.splitlines(keepends=True)[2:])
        self.assertIsNone(repair.parse_config(after)[1])
        self.run_cli('--rollback', result['manifestPath'], '--runtime-stopped')
        self.assertEqual(config.read_bytes(), before)

    def test_config_prompt_inline_comment_preserved(self):
        prompt = self.root / '提示.md'
        prompt.write_text('example', encoding='utf-8')
        config = self.root / 'config.toml'
        config.write_text('model_instructions_file = "D:\\bad\\path" # "keep"\n', encoding='utf-8')
        self.run_cli('--apply', '--config', '--config-line', '1', '--path', str(prompt), '--runtime-stopped')
        self.assertTrue(config.read_text(encoding='utf-8').endswith(' # "keep"\n'))

    def test_config_refuses_non_path_and_remaining_syntax_errors(self):
        self.run_cli('--apply', '--config', '--config-line', '1', '--path', str(self.root), '--runtime-stopped', code=1)
        config = self.root / 'config.toml'
        config.write_text('[projects."D:\\bad"]\nbroken = "\\q"\n', encoding='utf-8')
        before = config.read_bytes()
        self.run_cli('--apply', '--config', '--config-line', '1', '--path', str(self.root), '--runtime-stopped', code=1)
        self.assertEqual(config.read_bytes(), before)

    def test_valid_toml_invalid_project_component_is_detected(self):
        (self.root / 'config.toml').write_text('[projects."D:/broken?"]\ntrust_level="trusted"', encoding='utf-8')
        self.assertEqual(self.run_cli('--config')['checks']['configSyntax']['status'], 'needs-path')

    def test_scan_continues_past_corrupt_file(self):
        self.history('one')
        self.history('two', middle=b'\x00' * 4096 + b'\n')
        self.history('archived', archived=1)
        result = self.run_cli('--all-unarchived')
        self.assertEqual(result['summary'], {'checkedHistories': 2, 'damagedHistories': 2, 'invalidJsonLines': 1, 'nulPaddingLines': 1})

    def test_history_quarantine_preserves_bytes_offsets_ordinals_and_rollback(self):
        file = self.history()
        before = file.read_bytes()
        db_before = (self.root / 'state_5.sqlite').read_bytes()
        self.run_cli('--apply', '--thread', 'one', '--runtime-stopped', code=1)
        self.assertEqual(file.read_bytes(), before)
        result = self.run_cli('--apply', '--thread', 'one', '--quarantine-invalid', '--runtime-stopped')
        after = file.read_bytes()
        self.assertEqual(len(after), len(before))
        self.assertEqual(after.splitlines(keepends=True)[0], before.splitlines(keepends=True)[0])
        self.assertEqual(after.splitlines(keepends=True)[2], before.splitlines(keepends=True)[2])
        self.assertEqual(json.loads(after.splitlines()[1])['ordinal'], 88)
        for line in after.splitlines():
            json.loads(line)
        self.assertEqual(self.run_cli('--thread', 'one')['summary']['damagedHistories'], 0)
        self.assertEqual((self.root / 'state_5.sqlite').read_bytes(), db_before)
        self.run_cli('--rollback', result['manifestPath'], '--runtime-stopped')
        self.assertEqual(file.read_bytes(), before)

    def test_nul_padding_only_can_repair_without_quarantine(self):
        file = self.history(middle=b'\x00' * (1024 * 1024) + b'\r\n')
        before_size = file.stat().st_size
        self.run_cli('--apply', '--thread', 'one', '--runtime-stopped')
        self.assertEqual(file.stat().st_size, before_size)
        self.assertNotIn(b'\x00', file.read_bytes())

    def test_nul_trailing_record_preserves_content(self):
        good = b'{"type":"response_item","payload":{"text":"keep"}}'
        file = self.history(middle=good + b'\x00' * 100 + b'\n')
        self.run_cli('--apply', '--thread', 'one', '--runtime-stopped')
        self.assertEqual(file.read_bytes().splitlines()[1], good + b' ' * 100)

    def test_nul_inside_string_requires_quarantine(self):
        middle = b'{"type":"response_item","payload":{"text":"' + b'x' * 200 + b'\x00inside"}}\n'
        file = self.history(middle=middle)
        before = file.read_bytes()
        self.run_cli('--apply', '--thread', 'one', '--runtime-stopped', code=1)
        self.assertEqual(file.read_bytes(), before)

    def test_short_bad_line_and_wrong_header_block(self):
        file = self.history(middle=b'{oops\n')
        before = file.read_bytes()
        self.run_cli('--apply', '--thread', 'one', '--quarantine-invalid', '--runtime-stopped', code=1)
        self.assertEqual(file.read_bytes(), before)
        file.write_bytes(before.replace(b'"one"', b'"wrong"'))
        self.assertEqual(self.run_cli('--thread', 'one')['checks']['histories'][0]['status'], 'blocked')

    def test_archived_and_shared_history_are_blocked(self):
        file = self.history(archived=1)
        self.run_cli('--apply', '--thread', 'one', '--quarantine-invalid', '--runtime-stopped', code=1)
        with closing(sqlite3.connect(self.root / 'state_5.sqlite')) as db, db:
            db.execute('UPDATE threads SET archived=0')
            db.execute('INSERT INTO threads VALUES(?,?,?)', ('alias', 0, str(file)))
        self.run_cli('--apply', '--thread', 'one', '--quarantine-invalid', '--runtime-stopped', code=1)

    def test_later_changes_and_tampered_backup_prevent_rollback(self):
        file = self.history()
        result = self.run_cli('--apply', '--thread', 'one', '--quarantine-invalid', '--runtime-stopped')
        repaired = file.read_bytes()
        file.write_bytes(repaired + b'new-data')
        self.run_cli('--rollback', result['manifestPath'], '--runtime-stopped', code=1)
        self.assertTrue(file.read_bytes().endswith(b'new-data'))
        file.write_bytes(repaired)
        manifest = json.loads(Path(result['manifestPath']).read_bytes())
        Path(manifest['backup']).write_bytes(b'tampered')
        self.run_cli('--rollback', result['manifestPath'], '--runtime-stopped', code=1)
        self.assertEqual(file.read_bytes(), repaired)

    def test_history_drift_during_backup_prevents_write(self):
        file = self.history()
        before = file.read_bytes()
        real_backup = repair.backup_manifest
        def race(*args, **kwargs):
            result = real_backup(*args, **kwargs)
            with file.open('ab') as stream:
                stream.write(b'new-tail')
            return result
        with patch.object(repair, 'backup_manifest', side_effect=race):
            with self.assertRaisesRegex(ValueError, 'changed after preflight'):
                repair.apply_history(self.root, 'one', True)
        self.assertEqual(file.read_bytes(), before + b'new-tail')

    def test_mid_write_drift_does_not_overwrite_unattempted_line(self):
        bad = b'{"broken":"' + b'x' * 300 + b'\n'
        file = self.history(middle=bad + bad)
        before = file.read_bytes()
        parts = before.splitlines(keepends=True)
        other = b'other-writer' + b' ' * (len(parts[2]) - 12) + b'\n'
        real_hash = repair.file_hash
        changed = False
        def race(target):
            nonlocal changed
            result = real_hash(target)
            if Path(target) == file and not changed:
                changed = True
                file.write_bytes(parts[0] + parts[1] + other + parts[3])
            return result
        with patch.object(repair, 'file_hash', side_effect=race):
            with self.assertRaisesRegex(ValueError, 'line changed before write'):
                repair.apply_history(self.root, 'one', True)
        self.assertEqual(file.read_bytes(), parts[0] + parts[1] + other + parts[3])

    def test_verification_failure_restores_history(self):
        file = self.history()
        before = file.read_bytes()
        scan = repair.scan_history
        count = 0
        def faulty(*args):
            nonlocal count
            count += 1
            result = scan(*args)
            if count == 2:
                result['status'] = 'blocked'
            return result
        with patch.object(repair, 'scan_history', side_effect=faulty):
            with self.assertRaisesRegex(ValueError, 'verification failed'):
                repair.apply_history(self.root, 'one', True)
        self.assertEqual(file.read_bytes(), before)

    def test_config_verification_failure_automatically_restores(self):
        file = self.root / 'config.toml'
        file.write_bytes(b'[projects."D:/bad?"]\ntrust_level="trusted"\n')
        before = file.read_bytes()
        real_parse = repair.parse_config
        calls = 0
        def faulty(data):
            nonlocal calls
            calls += 1
            return (None, 'synthetic parse failure') if calls == 2 else real_parse(data)
        with patch.object(repair, 'parse_config', side_effect=faulty):
            with self.assertRaisesRegex(ValueError, 'verification failed'):
                repair.apply_config(self.root, 1, str(self.root), True)
        self.assertEqual(file.read_bytes(), before)

    def test_auth_write_failure_removes_only_created_file(self):
        (self.root / 'auth.json.bak').write_bytes(auth())
        with patch.object(repair.os, 'fsync', side_effect=[None, OSError('simulated disk error'), None]):
            with self.assertRaises(OSError):
                repair.apply_auth(self.root, None)
        self.assertFalse((self.root / 'auth.json').exists())
        self.assertEqual((self.root / 'auth.json.bak').read_bytes(), auth())

    def test_javascript_incompatible_json_constant_is_not_healthy(self):
        self.history(middle=b'{"type":"response_item","payload":{"value":NaN,"text":"' + b'x' * 200 + b'"}}\n')
        self.assertEqual(self.run_cli('--thread', 'one')['summary']['invalidJsonLines'], 1)

    @unittest.skipUnless(shutil.which('node') and shutil.which('sqlite3'), 'Node and sqlite3 CLI required for legacy integration')
    def test_recovered_history_passes_legacy_bulk_preflight(self):
        file = self.history()
        with closing(sqlite3.connect(self.root / 'state_5.sqlite')) as db, db:
            db.execute('ALTER TABLE threads ADD COLUMN model_provider TEXT DEFAULT "custom"')
            db.execute('ALTER TABLE threads ADD COLUMN title TEXT DEFAULT "fixture"')
            db.execute('CREATE INDEX archived_idx ON threads(archived)')
            db.execute('CREATE INDEX provider_idx ON threads(model_provider)')
        file.write_bytes(file.read_bytes().replace(b'"id": "one"', b'"id": "one", "model_provider": "custom"'))
        (self.root / 'config.toml').write_bytes(b'model_provider="custom"\n[model_providers.custom]\nwire_api="responses"\n')
        self.run_cli('--apply', '--thread', 'one', '--quarantine-invalid', '--runtime-stopped')
        # Copy the unchanged legacy script so its reports remain inside the fixture.
        legacy = self.root / 'bulk-repair.cjs'
        shutil.copy2(SCRIPT.parent / legacy.name, legacy)
        result = subprocess.run(['node', str(legacy), '--dry-run', '--thread', 'one'],
                                env={**os.environ, 'CODEX_ROOT': str(self.root)},
                                capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['preflight']['jsonErrors'], 0)

    @unittest.skipUnless(shutil.which('node'), 'Node required for wrapper integration')
    def test_node_wrapper_runs_read_only_check(self):
        (self.root / 'auth.json.bak').write_bytes(auth())
        result = subprocess.run(['node', str(SCRIPT.parent / 'local-repair.cjs'), '--auth'],
                                env={**os.environ, 'CODEX_ROOT': str(self.root), 'CODEX_REPAIR_PYTHON': sys.executable},
                                text=True, capture_output=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['checks']['auth']['status'], 'repairable')
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertFalse((self.root / 'auth.json').exists())


if __name__ == '__main__':
    unittest.main()
