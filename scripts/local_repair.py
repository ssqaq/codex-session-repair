#!/usr/bin/env python3
"""Offline repairs. Reports contain metadata only; credentials and history stay in backups."""
import argparse
from contextlib import contextmanager
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import tomllib
from datetime import datetime, timezone


def digest(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def invalid_constant(value):
        raise ValueError('Invalid JSON constant')
    return json.loads(data, parse_constant=invalid_constant)


def file_hash(file):
    with open(file, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inside(file, root):
    return file.resolve().is_relative_to(root.resolve())


def regular(file):
    return file.is_file() and not file.is_symlink()


def atomic(file, data):
    fd, tmp = tempfile.mkstemp(prefix='.local-repair-', dir=file.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, file)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_manifest(file, value):
    atomic(file, json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8'))


def oauth_info(file):
    try:
        if not regular(file):
            return 'unreadable'
        value = strict_json(file.read_bytes())
        if not isinstance(value, dict):
            return 'invalid-json'
        tokens = value.get('tokens')
        if not isinstance(tokens, dict) or not all(isinstance(tokens.get(k), str) and tokens[k].strip()
                                                for k in ('access_token', 'refresh_token')):
            return 'no-oauth-tokens'
        access = tokens['access_token']
        if len(access.split('.')) == 3:
            try:
                part = access.split('.')[1]
                claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
                if isinstance(claims.get('exp'), (int, float)) and claims['exp'] <= time.time():
                    return 'expired-access-token'
            except (ValueError, TypeError, AttributeError):
                return 'invalid-access-token'
        return 'oauth-present-unverified'
    except (OSError, ValueError):
        return 'invalid-json'


def inspect_auth(root, explicit=None):
    active = root / 'auth.json'
    if active.exists() or active.is_symlink():
        state = oauth_info(active)
        return {'status': 'healthy' if state == 'oauth-present-unverified' else 'needs-login',
                'activeState': state, 'action': 'keep-existing-auth', 'candidates': []}
    if explicit:
        candidates = [Path(explicit).resolve()]
        if not inside(candidates[0], root):
            raise ValueError('Auth backup must be inside CODEX_ROOT.')
    else:
        candidates = sorted(set(root.glob('auth.json.bak*')) | set(root.glob('auth.json.*.bak')))
    details = [{'path': str(p), 'state': oauth_info(p)} for p in candidates]
    usable = [p for p in candidates if oauth_info(p) == 'oauth-present-unverified']
    unique = {file_hash(p): p for p in usable}
    proposed = next(iter(unique.values())) if len(unique) == 1 else None
    return {'status': 'repairable' if proposed else 'ambiguous' if unique else 'needs-login',
            'activeState': 'missing', 'candidates': details, 'proposedBackup': str(proposed) if proposed else None,
            'action': 'restore-local-backup' if proposed else 'select-backup-or-login-manually'}


def parse_config(data):
    try:
        return tomllib.loads(data.decode('utf-8')), None
    except (tomllib.TOMLDecodeError, UnicodeDecodeError) as error:
        # Parser errors can include a secret key's value. Return only location, never source text.
        location = re.search(r'\(at line \d+, column \d+\)|\(at end of document\)', str(error))
        return None, 'Invalid TOML/UTF-8' + (' ' + location.group(0) if location else '')


def invalid_windows_path(value):
    parts = re.split(r'[/\\]', value)
    return any(re.search(r'[<>:"|?*\x00-\x1f]|[ .]$', p)
               for p in parts if p and not re.fullmatch('[A-Za-z]:', p))


def inspect_config(root):
    file = root / 'config.toml'
    if not regular(file):
        return {'status': 'missing', 'issues': [], 'error': 'config.toml is missing or not a regular file'}
    data = file.read_bytes()
    parsed, error = parse_config(data)
    if error:
        return {'status': 'invalid-toml', 'error': error, 'issues': [], 'sha256': digest(data)}
    issues = []
    for project in parsed.get('projects', {}):
        if invalid_windows_path(project):
            issues.append({'kind': 'invalid-project-path', 'path': project})
    return {'status': 'needs-path' if issues else 'healthy', 'issues': issues, 'sha256': digest(data)}


def plan_config(root, line_number, new_path):
    file = root / 'config.toml'
    if not regular(file):
        raise ValueError('config.toml must be a regular file.')
    data = file.read_bytes()
    lines = data.decode('utf-8').splitlines(keepends=True)
    if not 1 <= line_number <= len(lines):
        raise ValueError('Config line is outside the file.')
    target = Path(new_path).resolve()
    if not target.exists() or invalid_windows_path(str(target)):
        raise ValueError('Replacement path must exist and contain no invalid Windows components.')
    old = lines[line_number - 1]
    # Limit edits to a complete project header or model-instruction assignment, preserving comments/EOL.
    string = r'''("(?:\\.|[^"\\])*"|'[^']*')'''
    project = re.fullmatch(r'([ \t]*\[projects\.)' + string + r'(\][ \t]*(?:#[^\r\n]*)?)(\r?\n)?', old)
    prompt = re.fullmatch(r'([ \t]*model_instructions_file[ \t]*=[ \t]*)' + string + r'([ \t]*(?:#[^\r\n]*)?)(\r?\n)?', old)
    match = project or prompt
    if not match or (project and not target.is_dir()) or (prompt and not target.is_file()):
        raise ValueError('Selected line must be a project header (directory) or model instructions path (file).')
    quoted = json.dumps(target.as_posix(), ensure_ascii=False)
    lines[line_number - 1] = match[1] + quoted + match[3] + (match[4] or '')
    result = ''.join(lines).encode('utf-8')
    _, error = parse_config(result)
    if error:
        raise ValueError('Proposed replacement does not produce valid TOML: ' + error)
    return file, data, result


@contextmanager
def connect_state(root, writable=False):
    file = root / 'state_5.sqlite'
    db = sqlite3.connect(file.as_uri() + ('?mode=rw' if writable else '?mode=ro'), uri=True, timeout=15)
    db.row_factory = sqlite3.Row
    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        db.close()
        raise ValueError('State database integrity check failed.')
    try:
        with db:
            yield db
    finally:
        db.close()


def thread_rows(root, ids):
    with connect_state(root) as db:
        rows = [dict(r) for r in db.execute('SELECT id, archived, rollout_path FROM threads')]
    by_id = {r['id']: r for r in rows}
    for id_ in ids:
        if id_ not in by_id or by_id[id_]['archived'] != 0:
            raise ValueError('Thread is missing or archived: ' + id_)
    return [r for r in rows if r['archived'] == 0 and (not ids or r['id'] in ids)]


def marker_bytes(length, eol, original=b''):
    # A real Codex event variant with no message or token totals. Keep offsets and ordinals stable.
    ordinal = re.match(rb'\s*\{\s*"timestamp"\s*:\s*"[^"\r\n]+"\s*,\s*"ordinal"\s*:\s*(\d+)\s*,', original[:512])
    marker = (b'{"timestamp":"1970-01-01T00:00:00Z",' +
              (b'"ordinal":' + ordinal[1] + b',' if ordinal else b'') +
              b'"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}')
    available = length - len(eol)
    if available < len(marker):
        return None
    return marker + b' ' * (available - len(marker)) + eol


def scan_history(file, thread_id):
    issues, valid, offset, header = [], 0, 0, False
    before = hashlib.sha256()
    after = hashlib.sha256()
    with open(file, 'rb') as stream:
        for line_no, raw in enumerate(stream, 1):
            before.update(raw)
            replacement = None
            kind = None
            eol = b'\r\n' if raw.endswith(b'\r\n') else b'\n' if raw.endswith(b'\n') else b''
            candidate = raw.replace(b'\x00', b' ')
            try:
                if b'\x00' in raw.strip(b'\x00 \t\r\n'):
                    raise ValueError('NUL within record')
                record = strict_json(candidate)
                if line_no == 1:
                    header = isinstance(record, dict) and record.get('type') == 'session_meta' and isinstance(record.get('payload'), dict) and record['payload'].get('id') == thread_id
                if candidate != raw:
                    kind, replacement = 'nul-padding', candidate
                valid += 1
            except (ValueError, UnicodeDecodeError):
                kind = 'nul-padding' if b'\x00' in raw and not candidate.strip() else 'invalid-json'
                replacement = marker_bytes(len(raw), eol, raw)
            if kind:
                issues.append({'line': line_no, 'offset': offset, 'length': len(raw), 'kind': kind,
                               'repairable': replacement is not None,
                               'beforeSha256': digest(raw), 'afterSha256': digest(replacement) if replacement else None})
            after.update(replacement if replacement is not None else raw)
            offset += len(raw)
    return {'threadId': thread_id, 'path': str(file), 'bytes': offset, 'validRecords': valid,
            'headerValid': header, 'issues': issues, 'beforeSha256': before.hexdigest(),
            'afterSha256': after.hexdigest(),
            'status': 'blocked' if not header or any(not i['repairable'] for i in issues) else 'repairable' if issues else 'healthy'}


def histories(root, ids):
    reports = []
    for row in thread_rows(root, ids):
        file = Path(row['rollout_path'])
        if not regular(file) or not inside(file, root / 'sessions'):
            reports.append({'threadId': row['id'], 'path': str(file), 'status': 'blocked',
                            'issues': [], 'error': 'History missing, linked, or outside sessions directory'})
            continue
        try:
            reports.append(scan_history(file, row['id']))
        except OSError:
            reports.append({'threadId': row['id'], 'path': str(file), 'status': 'blocked',
                            'issues': [], 'error': 'History could not be read'})
    return reports


def backup_manifest(root, file, kind, before, after_hash, **extra):
    folder = Path(tempfile.mkdtemp(prefix='local-repair-', dir=ensure_backups(root)))
    backup = folder / 'before.bin'
    if before is not None:
        if isinstance(before, bytes):
            backup.write_bytes(before)
        else:
            shutil.copy2(file, backup)
        os.chmod(backup, 0o600)
    manifest = {'schemaVersion': 1, 'kind': kind, 'status': 'prepared', 'codexRoot': str(root),
                'target': str(file), 'backup': str(backup) if before is not None else None,
                'beforeSha256': file_hash(backup) if before is not None else None,
                'afterSha256': after_hash, **extra}
    location = folder / 'manifest.json'
    write_manifest(location, manifest)
    return location, manifest


def ensure_backups(root):
    folder = root / 'backups'
    folder.mkdir(exist_ok=True)
    if not inside(folder, root):
        raise ValueError('Backup directory resolves outside CODEX_ROOT.')
    return folder


def finish(location, manifest):
    manifest['status'] = 'validated-static'
    write_manifest(location, manifest)
    return {'status': manifest['status'], 'kind': manifest['kind'], 'manifestPath': str(location),
            'liveVerification': 'pending'}


def apply_auth(root, explicit):
    report = inspect_auth(root, explicit)
    if report['status'] != 'repairable':
        raise ValueError('Auth is not repairable from a unique local OAuth backup; existing auth is never overwritten.')
    source = Path(report['proposedBackup'])
    data = source.read_bytes()
    target = root / 'auth.json'
    location, manifest = backup_manifest(root, target, 'auth', None, digest(data))
    # Exclusive create: a login that appeared after inspection must never be overwritten.
    created = False
    identity = None
    try:
        with open(target, 'xb') as stream:
            created = True
            identity = os.fstat(stream.fileno()).st_ino
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if file_hash(target) != manifest['afterSha256'] or oauth_info(target) != 'oauth-present-unverified':
            raise ValueError('Auth validation failed.')
    except Exception:
        if created and regular(target) and target.stat().st_ino == identity:
            target.unlink()
            manifest['status'] = 'rolled-back-on-error'
        else:
            manifest['status'] = 'recovery-required'
        write_manifest(location, manifest)
        raise
    return finish(location, manifest)


def apply_config(root, line, new_path, apply):
    target, before, after = plan_config(root, line, new_path)
    if not apply:
        return {'status': 'repairable' if before != after else 'healthy', 'line': line,
                'beforeSha256': digest(before), 'afterSha256': digest(after)}
    location, manifest = backup_manifest(root, target, 'config', before, digest(after))
    if file_hash(target) != digest(before):
        raise ValueError('Config changed after preflight; refusing write.')
    try:
        atomic(target, after)
        if file_hash(target) != digest(after) or parse_config(target.read_bytes())[1]:
            raise ValueError('Config verification failed.')
    except Exception:
        if regular(target) and file_hash(target) == digest(after):
            atomic(target, before)
            manifest['status'] = 'rolled-back-on-error'
        else:
            manifest['status'] = 'recovery-required'
        write_manifest(location, manifest)
        raise
    return finish(location, manifest)


def apply_history(root, id_, quarantine):
    rows = thread_rows(root, [id_])
    file = Path(rows[0]['rollout_path'])
    if not regular(file) or not inside(file, root / 'sessions'):
        raise ValueError('History must be a regular file inside CODEX_ROOT/sessions.')
    plan = scan_history(file, id_)
    if plan['status'] == 'healthy':
        return {'status': 'nothing-to-do', 'threadId': id_}
    if plan['status'] != 'repairable':
        raise ValueError('History header or short damaged line cannot be safely repaired in place.')
    if any(i['kind'] == 'invalid-json' for i in plan['issues']) and not quarantine:
        raise ValueError('Truncated JSON cannot be reconstructed; use --quarantine-invalid only after reviewing the loss.')
    with connect_state(root, writable=True) as db:
        db.execute('BEGIN IMMEDIATE')
        current = db.execute('SELECT archived, rollout_path FROM threads WHERE id=?', (id_,)).fetchone()
        if not current or current['archived'] != 0 or current['rollout_path'] != str(file):
            raise ValueError('Thread changed after preflight.')
        references = db.execute('SELECT id, rollout_path FROM threads WHERE id<>?', (id_,)).fetchall()
        if any(Path(r['rollout_path']).resolve() == file.resolve() for r in references):
            raise ValueError('History file is shared by another thread; refusing mutation.')
        location, manifest = backup_manifest(root, file, 'history', True, plan['afterSha256'],
                                             threadId=id_, issues=plan['issues'])
        if manifest['beforeSha256'] != plan['beforeSha256'] or file_hash(file) != plan['beforeSha256']:
            raise ValueError('History changed after preflight; refusing write.')
        with open(file, 'r+b') as stream:
            attempted = []
            try:
                for issue in plan['issues']:
                    stream.seek(issue['offset'])
                    raw = stream.read(issue['length'])
                    if digest(raw) != issue['beforeSha256']:
                        raise ValueError('History line changed before write.')
                    replacement = raw.replace(b'\x00', b' ')
                    if digest(replacement) != issue['afterSha256']:
                        eol = b'\r\n' if raw.endswith(b'\r\n') else b'\n' if raw.endswith(b'\n') else b''
                        replacement = marker_bytes(len(raw), eol, raw)
                    if digest(replacement) != issue['afterSha256']:
                        raise ValueError('History replacement differs from preflight.')
                    stream.seek(issue['offset'])
                    attempted.append(issue)
                    stream.write(replacement)
                stream.flush()
                os.fsync(stream.fileno())
                if file_hash(file) != plan['afterSha256'] or scan_history(file, id_)['status'] != 'healthy':
                    raise ValueError('History verification failed.')
            except Exception:
                # Runtime must be stopped; restore only the byte ranges this operation owns.
                with open(manifest['backup'], 'rb') as backup:
                    for issue in attempted:
                        backup.seek(issue['offset'])
                        stream.seek(issue['offset'])
                        stream.write(backup.read(issue['length']))
                stream.flush()
                os.fsync(stream.fileno())
                manifest['status'] = 'rolled-back-on-error' if file_hash(file) == plan['beforeSha256'] else 'recovery-required'
                write_manifest(location, manifest)
                raise
    return finish(location, manifest)


def rollback(root, location):
    location = Path(location).resolve()
    if not inside(location, root / 'backups'):
        raise ValueError('Manifest must be inside CODEX_ROOT/backups.')
    manifest = json.loads(location.read_bytes())
    if manifest.get('schemaVersion') != 1 or manifest.get('kind') not in ('auth', 'config', 'history'):
        raise ValueError('Unrecognized local repair manifest.')
    if Path(manifest['codexRoot']).resolve() != root:
        raise ValueError('Manifest belongs to another CODEX_ROOT.')
    target = Path(manifest['target'])
    allowed = root / ('auth.json' if manifest['kind'] == 'auth' else 'config.toml')
    if not inside(target, root) or (manifest['kind'] != 'history' and target.resolve() != allowed):
        raise ValueError('Manifest target is outside the repair scope.')
    if manifest['kind'] == 'history':
        rows = thread_rows(root, [manifest['threadId']])
        if Path(rows[0]['rollout_path']).resolve() != target.resolve() or not inside(target, root / 'sessions'):
            raise ValueError('Thread history location changed.')
    if not regular(target) or file_hash(target) != manifest['afterSha256']:
        raise ValueError('Target changed after repair; refusing to overwrite newer data.')
    if manifest['backup']:
        backup = Path(manifest['backup'])
        if not regular(backup) or not inside(backup, location.parent) or file_hash(backup) != manifest['beforeSha256']:
            raise ValueError('Backup hash or location does not match manifest.')
        atomic(target, backup.read_bytes())
        if file_hash(target) != manifest['beforeSha256']:
            raise ValueError('Rollback verification failed.')
    elif manifest['kind'] == 'auth' and manifest['beforeSha256'] is None:
        target.unlink()
    else:
        raise ValueError('Manifest has no valid backup.')
    manifest['status'] = 'rolled-back'
    write_manifest(location, manifest)
    return {'status': 'rolled-back', 'kind': manifest['kind'], 'manifestPath': str(location)}


def main():
    parser = argparse.ArgumentParser(description='Local auth, TOML and damaged JSONL recovery (Python 3.11+).')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback')
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument('--auth', action='store_true')
    scope.add_argument('--config', action='store_true')
    scope.add_argument('--thread', action='append', default=[])
    scope.add_argument('--all-unarchived', action='store_true')
    parser.add_argument('--auth-backup')
    parser.add_argument('--config-line', type=int)
    parser.add_argument('--path')
    parser.add_argument('--quarantine-invalid', action='store_true')
    parser.add_argument('--runtime-stopped', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    root = Path(os.environ.get('CODEX_ROOT', str(Path.home() / '.codex'))).resolve()
    if args.auth_backup and not args.auth:
        raise ValueError('--auth-backup requires --auth.')
    if args.config_line is not None or args.path is not None:
        if not args.config or not args.config_line or not args.path:
            raise ValueError('Config replacement requires --config --config-line N --path EXISTING_PATH.')
    if args.quarantine_invalid and not args.thread:
        raise ValueError('--quarantine-invalid requires an explicit --thread.')
    if (args.apply or args.rollback) and not args.runtime_stopped:
        raise ValueError('Close the Codex runtime first, then pass --runtime-stopped from an external terminal.')
    if args.rollback:
        if args.auth or args.config or args.thread or args.all_unarchived:
            raise ValueError('--rollback cannot be combined with selectors.')
        return rollback(root, args.rollback)
    if args.apply:
        if args.auth:
            return apply_auth(root, args.auth_backup)
        if args.config and args.config_line:
            return apply_config(root, args.config_line, args.path, True)
        if len(args.thread) == 1:
            return apply_history(root, args.thread[0], args.quarantine_invalid)
        raise ValueError('Apply requires --auth, one --thread, or an explicit config-line/path pair.')
    checks = {}
    all_checks = not (args.auth or args.config or args.thread)
    if args.auth or all_checks:
        checks['auth'] = inspect_auth(root, args.auth_backup)
    if args.config or all_checks:
        checks['configSyntax'] = (apply_config(root, args.config_line, args.path, False)
                                  if args.config_line else inspect_config(root))
    if args.thread or all_checks:
        checks['histories'] = histories(root, args.thread)
    problematic = [h for h in checks.get('histories', []) if h['status'] != 'healthy']
    summary = {'checkedHistories': len(checks.get('histories', [])), 'damagedHistories': len(problematic),
               'invalidJsonLines': sum(i['kind'] == 'invalid-json' for h in problematic for i in h['issues']),
               'nulPaddingLines': sum(i['kind'] == 'nul-padding' for h in problematic for i in h['issues'])}
    checks['histories'] = problematic  # all files are checked; keep reports compact.
    return {'schemaVersion': 1, 'mode': 'dry-run', 'checkedAt': datetime.now(timezone.utc).isoformat(),
            'codexRoot': str(root), 'checks': checks, 'summary': summary}


if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False, indent=2))
    except Exception as error:
        # No traceback: it could contain credentials or corrupt history fragments.
        safe = str(error) if isinstance(error, ValueError) and not isinstance(error, (json.JSONDecodeError, UnicodeError)) else type(error).__name__
        print(json.dumps({'status': 'failed', 'error': safe}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
