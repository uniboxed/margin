"""Owned off-screen NativeHandoffCover prepared-allocation matrix, dry-run first.

No installed app, browser, launch default or source edits. --build compiles only;
--go runs only an already stamped binary/assets/fixture. Component/DPR1 evidence
does not establish full-app performance, physical coverage or high-DPI behavior.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
BUILD = HERE / 'build/cover-memory-native'
BINARY = BUILD / 'cover-memory-native-probe'
FIXTURE = BUILD / 'hello.json'
STAMP = BUILD / 'stamp.json'
ASSETS = REPO / 'dist/app'
THEME = 'arcadia'
FLAGS = ['-swift-version', '5', '-default-isolation', 'MainActor',
         '-enable-upcoming-feature', 'InferIsolatedConformances',
         '-enable-upcoming-feature', 'NonisolatedNonsendingByDefault',
         '-parse-as-library', '-O', '-D', 'MARGIN_THEMED_COVER_PROBE',
         '-D', 'MARGIN_NATIVE_PREPARED_MEMORY_PROBE']
SCOPE = 'owned off-screen production NativeHandoffCover prepare/end, synthetic Arcadia, DPR/backing1; not a full-app/physical measurement'


class Refused(RuntimeError):
    pass


def strict_json(text):
    def invalid(value):
        raise ValueError('non-finite JSON constant: ' + value)
    return json.loads(text, parse_constant=invalid)


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def sha(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise Refused('missing/nonregular/symlink input: ' + str(path))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_files(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise Refused('missing/symlink input directory: ' + str(root))
    paths = sorted(root.rglob('*'))
    if any(p.is_symlink() for p in paths):
        raise Refused('symlink input under: ' + str(root))
    return [p for p in paths if p.is_file() and p.name != '.DS_Store']


def swift_sources(repo=REPO):
    repo = Path(repo)
    sources = []
    for line in (repo / 'app/platforms/macos/swift-sources.txt').read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        folder = (repo / line).resolve()
        if not folder.is_relative_to(repo.resolve()):
            raise Refused('Swift source folder escaped repository')
        found = sorted(folder.glob('*.swift'))
        if not found:
            raise Refused('empty Swift source folder: ' + line)
        sources.extend(found)
    if not sources or len(sources) != len(set(sources)):
        raise Refused('empty/duplicate Swift source inventory')
    return sources


def inputs():
    paths = [Path(__file__).resolve(), HERE / 'cover-memory-native.sh', HERE / 'cover-memory-probe.swift',
             HERE / 'native-cover-fixture.mts', HERE / 'native-cover-run.py', HERE / 'memory.py',
             REPO / 'app/platforms/macos/swift-sources.txt', REPO / 'package.json', REPO / 'package-lock.json']
    paths += swift_sources()
    # Includes fixture imports, packaged fonts/images, and renderer source inputs.
    for name in ['app/shared/host', 'extension/ui', 'extension/shared', 'extension/state',
                 'extension/themes', 'tests/theme', 'tests/ui', 'types']:
        paths += tree_files(REPO / name)
    return {str(p.relative_to(REPO)): sha(p) for p in sorted(set(paths))}


def asset_hashes(root=ASSETS):
    root = Path(root)
    files = tree_files(root)
    required = {'overlay.html', 'overlay.js', 'handoff-cover.html', 'handoff-cover.js'}
    hashes = {str(p.relative_to(root)): sha(p) for p in files}
    if not required.issubset(hashes):
        raise Refused('built overlay/cover assets missing; wrapper never runs a dist build')
    return hashes


def snapshot():
    return {'schema': 1, 'variant': 'production-native-prepared', 'theme': THEME,
            'flags': FLAGS, 'sources': inputs(), 'assets': asset_hashes(),
            'binary': sha(BINARY), 'fixture': sha(FIXTURE)}


def verify_stamp(recorded, current):
    if not isinstance(recorded, dict) or recorded.get('snapshot') != current:
        raise Refused('stale/missing source, binary, fixture or asset stamp; serialize a fresh --build')


def build_command(jobs, sources, output):
    return ['swiftc', '-j' + str(jobs), *FLAGS, str(HERE / 'cover-memory-probe.swift'),
            *map(str, sources), '-framework', 'AppKit', '-framework', 'WebKit', '-o', str(output)]


@contextmanager
def owned_lock():
    BUILD.mkdir(parents=True, exist_ok=True)
    with (BUILD / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refused('another cover-memory-native build/run owns the lock') from error
        yield


def build():
    # The wrapper lock serializes this wrapper only. The coordinator must also
    # keep unrelated Swift builds/timing captures idle before invoking --build.
    sources_before, assets_before = inputs(), asset_hashes()
    try:
        cpus = int(subprocess.check_output(['/usr/sbin/sysctl', '-n', 'hw.ncpu'], text=True, timeout=2))
        jobs = cpus if 1 <= cpus <= 256 else 4
    except (OSError, ValueError, subprocess.SubprocessError):
        jobs = 4
    STAMP.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix='compile-', dir=BUILD) as temporary:
        directory = Path(temporary)
        fixture = directory / 'hello.json'
        binary = directory / BINARY.name
        with fixture.open('w') as out:
            subprocess.run(['node', str(HERE / 'native-cover-fixture.mts'), THEME],
                           cwd=REPO, stdout=out, check=True, timeout=60)
        hello = strict_json(fixture.read_text())
        if not isinstance(hello, dict) or hello.get('theme', {}).get('id') != THEME:
            raise Refused('synthetic fixture did not produce the requested theme')
        command = build_command(jobs, swift_sources(), binary)
        subprocess.run(command, cwd=REPO, check=True, timeout=600)
        subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime', str(binary)], check=True, timeout=30)
        subprocess.run(['codesign', '--verify', '--strict', str(binary)], check=True, timeout=30)
        if inputs() != sources_before or asset_hashes() != assets_before:
            raise Refused('inputs changed during build; no executable stamp published')
        os.replace(fixture, FIXTURE)
        os.replace(binary, BINARY)
    write_json(STAMP, {'snapshot': snapshot(), 'build_command': command,
                       'built_at': time.time(), 'jobs': jobs, 'scope': SCOPE})
    print('Built/stamped only; no probe, window, sampler or installed app ran.')


def positive_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


class EventStream:
    """Strict complete stdout framing/sequence. Errors stay in the main thread."""
    def __init__(self, pid, mode, rounds, events, raw):
        self.pid, self.mode, self.rounds = pid, mode, rounds
        self.events, self.raw = events, raw
        self.buffer = b''
        self.rows = []
        self.expected = [('baseline', None)]
        for r in range(1, rounds + 1):
            self.expected += [(name, r) for name in ['cover_begin', 'cover_ready', 'native_clean', 'cover_end']]
        self.expected += [('post_idle', None), ('complete', None)]
        self.layout = None

    def feed(self, data):
        self.raw.write(data); self.raw.flush()
        self.buffer += data
        while b'\n' in self.buffer:
            line, self.buffer = self.buffer.split(b'\n', 1)
            if len(line) > 1024 * 1024:
                raise Refused('stdout event exceeds 1 MiB')
            try:
                row = strict_json(line.decode('utf-8'))
            except (ValueError, UnicodeError) as error:
                raise Refused('probe stdout is not complete valid JSON: ' + str(error)) from error
            if not isinstance(row, dict):
                raise Refused('probe stdout JSON is not an object')
            self.events.write(json.dumps(row, allow_nan=False) + '\n'); self.events.flush()
            self.accept(row)
        if len(self.buffer) > 1024 * 1024:
            raise Refused('unterminated stdout event exceeds 1 MiB')

    def accept(self, row):
        if row.get('pid') != self.pid or row.get('mode') != self.mode:
            raise Refused('event from unexpected PID/mode')
        if row.get('event') == 'failed':
            raise Refused('native probe failed: ' + str(row.get('reason')))
        position = len(self.rows)
        if position >= len(self.expected) or (row.get('event'), row.get('round')) != self.expected[position]:
            raise Refused('missing/duplicate/out-of-order probe event')
        if any(not isinstance(row.get(k), (int, float)) or isinstance(row.get(k), bool)
               or not math.isfinite(row[k]) for k in ['at', 'mono']):
            raise Refused('event clock missing/invalid')
        if self.rows and any(row[k] < self.rows[-1][k] for k in ['at', 'mono']):
            raise Refused('probe event clock moved backward')
        if row['event'] == 'baseline':
            a, b = row.get('a'), row.get('b')
            if not positive_int(a) or not positive_int(b) or a == b:
                raise Refused('baseline layout process grouping invalid')
            self.layout = (a, b)
        if row['event'] == 'cover_ready':
            a, b, cover = row.get('a'), row.get('b'), row.get('cover')
            if (a, b) != self.layout or not positive_int(cover):
                raise Refused('layout process changed or cover PID invalid')
            if (self.mode == 'related' and cover != a) or (self.mode == 'isolated' and cover in [a, b]):
                raise Refused('actual WebKit process grouping differs from requested mode')
            if any(isinstance(row.get(k), bool) or row.get(k) != 1 for k in ['device_pixel_ratio', 'backing_scale']):
                raise Refused('this component protocol is DPR/backing1 only')
        if row['event'] == 'native_clean':
            import re
            audit = row.get('audit', '')
            match = re.fullmatch(r'live cover audit: state idle, windows 0, views 0, spaces 0, presentation 0, timers 0, cleanup failures 0; created ([0-9]+), disposed ([0-9]+), last window [0-9]+; renderer .+', audit)
            if not match or int(match[1]) != row['round'] or int(match[2]) != row['round']:
                raise Refused('native cleanup audit is unverified/unbalanced')
        self.rows.append(row)

    def finish(self):
        if self.buffer:
            raise Refused('stdout ended with a partial/unframed JSON event')
        if len(self.rows) != len(self.expected):
            raise Refused('stdout ended before the complete event sequence')

    def census_phase(self):
        if not self.rows:
            return None
        last = self.rows[-1]
        if last['event'] in ['baseline', 'post_idle']:
            return last['event']
        if last['event'] == 'cover_ready':
            return 'cover_ready:' + str(last['round'])
        return None


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def sample_owned(memory, n, pid, started, executable):
    """Use memory.py's coalition/rusage accounting with an exact owned root PID.

    No helper or installed-app rusage is sampled. Other WebKit candidates are
    queried only for coalition identity; rusage requires the owned coalition.
    """
    def processes():
        actual = n.path(pid)
        if not actual or Path(actual).resolve() != executable:
            raise Refused('owned executable identity changed/unread')
        output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True, timeout=2)
        rows = [(int(parts[0]), parts[1]) for line in output.splitlines()
                if len(parts := line.strip().split(None, 1)) == 2]
        if not any(p == pid for p, _ in rows):
            raise Refused('owned PID absent from inventory')
        return [(pid, str(executable))] + [(p, name) for p, name in rows if p != pid and 'com.apple.WebKit.' in name]

    def usage(p):
        result = n.usage(p)
        if p == pid and (not result or result.get('started') != started or n.path(p) != str(executable)):
            raise Refused('owned PID/start/executable changed or unread')
        if p != pid and result and (not positive_int(result.get('started')) or result['started'] <= started):
            # CLI processes may share a launcher's resource coalition. An older
            # WebKit member cannot belong to this newly launched probe. Reuse
            # the already-read birth counter; retain evidence, withhold totals.
            return dict(result, unread=True, identity_error='WebKit birth invalid or not newer than owned root; shared launcher coalition contamination')
        return result

    memory.APP = str(executable)  # isolated module instance, never the installed app
    meta = memory.metadata(n.timebase)
    meta.update(helper_path=None, helper_scope='not sampled; outside owned component', scope=SCOPE)
    result = memory.collect(processes, n.coal, usage,
                            clock=lambda: {'at': time.time(), 'mono': n.monotonic()}, meta=meta)
    result.update(coverage='exact owned PID/start/executable and resource-coalition-attributed WebKit',
                  owned_identity={'pid': pid, 'started': started, 'executable': str(executable)},
                  helper_complete=None)
    return result


def source_census(sample, layout):
    return bool(layout) and sample.get('complete') is True and set(layout).issubset(
        {m.get('pid') for m in sample.get('members', []) if not m.get('unread')})


def stop_owned(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def drain_raw(process, output):
    """Preserve remaining bytes even after a JSON/sequence failure, bounded 2 s."""
    deadline = time.monotonic() + 2
    with output.open('ab') as raw, selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        while time.monotonic() < deadline:
            for _, _ in selector.select(timeout=.1):
                data = os.read(process.stdout.fileno(), 65536)
                if not data:
                    return True
                raw.write(data)
    return False


@contextmanager
def stop_on_signals():
    def interrupted(signum, _frame):
        raise InterruptedError('signal ' + str(signum) + '; stop only owned subprocess')
    previous = {sig: signal.signal(sig, interrupted) for sig in [signal.SIGTERM, signal.SIGHUP]}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def run_mode(mode, args, directory, recorded):
    directory.mkdir()
    command = [str(BINARY), '--go', mode]
    env = os.environ.copy()
    env.update(MARGIN_MEMORY_ROUNDS=str(args.rounds), MARGIN_MEMORY_IDLE_SECONDS=str(args.idle),
               MARGIN_MEMORY_HELLO=str(FIXTURE), MARGIN_MEMORY_ROOT=str(ASSETS))
    timeout = 30 + 15 * args.rounds + args.idle
    manifest = {'scope': SCOPE, 'command': command, 'mode': mode, 'rounds': args.rounds,
                'idle_seconds': args.idle, 'interval_seconds': args.interval,
                'outer_timeout_seconds': timeout, 'started_at': time.time(), 'stamp': recorded}
    write_json(directory / 'manifest.json', manifest)
    process = None
    error = None
    stream = None
    samples = 0
    incomplete = 0
    remaining = None
    stdout_complete = False
    census_phases = set()
    required_phases = {'baseline', 'post_idle'} | {'cover_ready:' + str(r) for r in range(1, args.rounds + 1)}
    try:
        memory = load_module('owned_cover_memory', HERE / 'memory.py')
        n = memory.native()  # only --go reaches native resources
        with (directory / 'events.jsonl').open('w') as events, (directory / 'samples.jsonl').open('w') as resources, \
                (directory / 'stdout.log').open('wb') as raw, (directory / 'stderr.log').open('wb') as stderr:
            process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
            identity = n.usage(process.pid)
            if (not identity or not positive_int(identity.get('started')) or n.path(process.pid) != str(BINARY.resolve())):
                raise Refused('launched process executable/start identity unverified')
            manifest['owned_identity'] = {'pid': process.pid, 'started': identity['started'], 'executable': str(BINARY.resolve())}
            write_json(directory / 'manifest.json', manifest)
            stream = EventStream(process.pid, mode, args.rounds, events, raw)
            os.set_blocking(process.stdout.fileno(), False)
            started = time.monotonic()
            deadline, next_sample = started + timeout, started
            eof = False
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while not (eof and process.poll() is not None):
                    now = time.monotonic()
                    if now >= deadline:
                        raise Refused('owned probe exceeded outer deadline; remaining matrix stopped')
                    # Read all available JSON before the next (sequential) resource sample.
                    wait = .1 if stream.rows and stream.rows[-1]['event'] == 'complete' else max(0, min(.1, next_sample - now))
                    for _, _ in selector.select(timeout=wait):
                        data = os.read(process.stdout.fileno(), 65536)
                        if data:
                            stream.feed(data)
                        else:
                            eof = True
                            selector.unregister(process.stdout)
                    if process.poll() is None and (not stream.rows or stream.rows[-1]['event'] != 'complete') and time.monotonic() >= next_sample:
                        sample = sample_owned(memory, n, process.pid, identity['started'], BINARY.resolve())
                        phase = stream.census_phase()
                        seen = source_census(sample, stream.layout)
                        sample.update(source_census_phase=phase, source_census_expected=list(stream.layout or []), source_census_verified=seen)
                        if phase and seen:
                            census_phases.add(phase)
                        resources.write(json.dumps(sample, allow_nan=False) + '\n'); resources.flush()
                        samples += 1
                        incomplete += sample.get('complete') is not True
                        if sample.get('app_pid') != process.pid or not sample.get('inventory_ok'):
                            raise Refused('owned inventory/identity sample failed; remaining matrix stopped')
                        next_sample = time.monotonic() + args.interval
            stream.finish()
            stdout_complete = True
            if process.wait(timeout=2) != 0:
                raise Refused('owned probe exited nonzero; remaining matrix stopped')
            if not samples or incomplete:
                raise Refused('resource capture incomplete; retained without comparison; remaining matrix stopped')
            if census_phases != required_phases:
                raise Refused('no complete A/B-attributed census in stable phases: ' + ', '.join(sorted(required_phases - census_phases)))
    except (Exception, KeyboardInterrupt) as failure:
        error = type(failure).__name__ + ': ' + str(failure)
    finally:
        if process is not None:
            try:
                stop_owned(process)
                if not stdout_complete:
                    stdout_complete = drain_raw(process, directory / 'stdout.log')
                observer = load_module('owned_cover_windows', HERE / 'native-cover-run.py')
                remaining = observer.owned_windows(process.pid)
                deadline = time.monotonic() + 2
                while remaining and time.monotonic() < deadline:
                    time.sleep(.05)
                    remaining = observer.owned_windows(process.pid)
                if remaining != []:
                    error = (error + '; ' if error else '') + 'owned window cleanup unknown/remaining after exit'
                if not stdout_complete:
                    error = (error + '; ' if error else '') + 'stdout EOF not verified after owned termination'
            except (Exception, KeyboardInterrupt) as cleanup_error:
                error = (error + '; ' if error else '') + 'cleanup: ' + str(cleanup_error)
            finally:
                if process.stdout:
                    process.stdout.close()
        result = {'ok': error is None, 'error': error, 'mode': mode, 'owned_pid': process.pid if process else None,
                  'exit': process.returncode if process else None, 'samples': samples, 'incomplete_samples': incomplete,
                  'complete_events': len(stream.rows) if stream else 0, 'stdout_eof': stdout_complete,
                  'source_census_verified_phases': sorted(census_phases),
                  'source_census_missing_phases': sorted(required_phases - census_phases),
                  'owned_windows_after_exit': remaining,
                  'ended_at': time.time(), 'scope': SCOPE}
        write_json(directory / 'result.json', result)
    return result


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--dry-run', action='store_true')
    action.add_argument('--build', action='store_true', help='compile/sign/stamp only; coordinate all native builds/captures first')
    action.add_argument('--go', action='store_true', help='explicitly run the owned off-screen matrix; never builds')
    parser.add_argument('--rounds', type=int, default=4)
    parser.add_argument('--idle', type=float, default=4)
    parser.add_argument('--interval', type=float, default=.25)
    parser.add_argument('--order', choices=['isolated-related', 'related-isolated'], default='isolated-related')
    parser.add_argument('--output', type=Path, help='new directory only; existing results are never overwritten')
    args = parser.parse_args(argv)
    if not 1 <= args.rounds <= 30 or not math.isfinite(args.idle) or not 4 <= args.idle <= 60:
        parser.error('rounds 1–30 and idle 4–60 seconds')
    if not math.isfinite(args.interval) or not .1 <= args.interval <= 2:
        parser.error('sample interval 0.1–2 seconds')
    if args.output and args.output.exists():
        parser.error('--output must be a new directory')
    return args


def main(argv=None):
    args = arguments(argv)
    if not args.build and not args.go:
        print(json.dumps({'dry_run': True, 'builds': False, 'creates_application': False,
                          'samples_resources': False, 'private_calls': False, 'scope': SCOPE,
                          'variant': 'production-native-prepared only', 'modes': args.order.split('-'),
                          'rounds_per_mode': args.rounds, 'post_idle_seconds_per_mode': args.idle,
                          'outer_seconds_per_mode': 30 + 15 * args.rounds + args.idle,
                          'requires': 'coordinator-serialized --build, then separate explicit --go; no automatic build',
                          'binary': str(BINARY), 'installed_app_or_browser_controlled': False}, indent=2))
        return 0
    directory = None
    results = []
    try:
        with owned_lock(), stop_on_signals():
            if args.build:
                build()
                return 0
            if os.environ.get('MARGIN_APP_TESTS') is not None:
                raise Refused('refused under MARGIN_APP_TESTS')
            recorded = strict_json(STAMP.read_text())
            verify_stamp(recorded, snapshot())
            directory = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix='margin-cover-memory-native-'))
            if args.output:
                directory.mkdir(parents=True, exist_ok=False)
            write_json(directory / 'matrix.json', {'scope': SCOPE, 'order': args.order.split('-'), 'stamp': recorded})
            print('Owned component output: ' + str(directory), flush=True)
            write_json(directory / 'matrix-result.json', {'scope': SCOPE, 'results': [], 'complete': False, 'ok': False})
            for mode in args.order.split('-'):
                verify_stamp(recorded, snapshot())
                result = run_mode(mode, args, directory / mode, recorded)
                results.append(result)
                write_json(directory / 'matrix-result.json', {'scope': SCOPE, 'results': results,
                           'complete': len(results) == 2, 'ok': len(results) == 2 and all(r['ok'] for r in results)})
                print(json.dumps(result), flush=True)
                if not result['ok']:
                    return 1
            return 0
    except (OSError, ValueError, Refused, subprocess.SubprocessError, KeyboardInterrupt) as error:
        if directory is not None:
            write_json(directory / 'matrix-result.json', {'scope': SCOPE, 'results': results,
                       'complete': False, 'ok': False, 'error': type(error).__name__ + ': ' + str(error)})
        print('STOP: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
