"""Pure wrapper guards; fake native readers/processes, no compiler or UI."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


probe = module('cover_memory_native', 'cover-memory-native.py')


def events(mode='isolated', rounds=2):
    rows = [dict(event='baseline', a=10, b=20)]
    for r in range(1, rounds + 1):
        rows += [dict(event='cover_begin', round=r),
                 dict(event='cover_ready', round=r, a=10, b=20, cover=10 if mode == 'related' else 30 + r,
                      device_pixel_ratio=1, backing_scale=1),
                 dict(event='native_clean', round=r,
                      audit=f'live cover audit: state idle, windows 0, views 0, spaces 0, presentation 0, timers 0, cleanup failures 0; created {r}, disposed {r}, last window 80; renderer detached'),
                 dict(event='cover_end', round=r)]
    rows += [dict(event='post_idle'), dict(event='complete')]
    return [dict(pid=42, mode=mode, at=1000 + i, mono=10 + i, **r) for i, r in enumerate(rows)]


def encoded(rows):
    return ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows).encode()


def stream(mode='isolated'):
    return probe.EventStream(42, mode, 2, io.StringIO(), io.BytesIO())


class WrapperTests(unittest.TestCase):
    def test_default_and_explicit_dry_run_never_read_stamps_build_or_load_native(self):
        for argv in [[], ['--dry-run'], ['--rounds', '8', '--idle', '30', '--order', 'related-isolated']]:
            with self.subTest(argv=argv), patch.object(probe, 'snapshot', side_effect=AssertionError), \
                    patch.object(probe, 'build', side_effect=AssertionError), \
                    patch.object(probe, 'load_module', side_effect=AssertionError), \
                    patch.object(probe.subprocess, 'Popen', side_effect=AssertionError), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(probe.main(argv), 0)
                result = json.loads(out.getvalue())
                self.assertTrue(result['dry_run'])
                self.assertFalse(result['builds'])
                self.assertFalse(result['samples_resources'])
                self.assertFalse(result['creates_application'])

    def test_arguments_are_bounded_and_cannot_combine_build_run(self):
        for argv in [['--rounds', '0'], ['--rounds', '31'], ['--idle', 'nan'], ['--idle', '61'],
                     ['--interval', 'inf'], ['--interval', '0.01'], ['--build', '--go'],
                     ['--order', 'isolated'], ['--go', '--dry-run']]:
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                probe.arguments(argv)
        args = probe.arguments(['--rounds', '30', '--idle', '60'])
        self.assertEqual(30 + 15 * args.rounds + args.idle, 540)
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            probe.arguments(['--output', directory])

    def test_compile_recipe_is_only_optimized_production_prepared_variant(self):
        command = probe.build_command(8, [Path('/source/a.swift'), Path('/source/b.swift')], '/owned/probe')
        self.assertEqual(command[:2], ['swiftc', '-j8'])
        for token in ['-O', 'MARGIN_THEMED_COVER_PROBE', 'MARGIN_NATIVE_PREPARED_MEMORY_PROBE', '/source/a.swift', '/source/b.swift']:
            self.assertIn(token, command)
        self.assertNotIn('native-cover-probe.swift', command)
        self.assertEqual(command[-2:], ['-o', '/owned/probe'])

    def test_full_source_manifest_inventory_is_checked_without_compiling(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            manifest = repo / 'app/platforms/macos/swift-sources.txt'
            manifest.parent.mkdir(parents=True)
            folder = repo / 'a'; folder.mkdir()
            (folder / 'one.swift').write_text('source')
            manifest.write_text('# comment\na\n')
            self.assertEqual(probe.swift_sources(repo), [(folder / 'one.swift').resolve()])
            manifest.write_text('a\na\n')
            with self.assertRaises(probe.Refused):
                probe.swift_sources(repo)
            manifest.write_text('../escape\n')
            with self.assertRaises(probe.Refused):
                probe.swift_sources(repo)

    def test_stale_assets_source_binary_fixture_or_flags_refuse(self):
        current = dict(sources={'a.swift': 'one'}, binary='binary', fixture='hello', flags=['-O'], assets={'a': 'one'})
        probe.verify_stamp({'snapshot': current}, current)
        for key in current:
            changed = copy.deepcopy(current); changed[key] = 'changed'
            with self.subTest(key=key), self.assertRaises(probe.Refused):
                probe.verify_stamp({'snapshot': current}, changed)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['overlay.html', 'overlay.js', 'handoff-cover.html', 'handoff-cover.js']:
                (root / name).write_text('first')
            before = probe.asset_hashes(root)
            (root / 'overlay.js').write_text('second')
            self.assertNotEqual(before, probe.asset_hashes(root))
            (root / 'new.js').write_text('new input')
            self.assertIn('new.js', probe.asset_hashes(root))
            (root / 'link').symlink_to(root / 'overlay.js')
            with self.assertRaises(probe.Refused):
                probe.asset_hashes(root)

    def test_go_refuses_stale_stamp_before_launch_and_stops_matrix_after_first_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            stamp = base / 'stamp.json'; stamp.write_text(json.dumps({'snapshot': {'version': 1}}))
            output = base / 'capture'
            with patch.object(probe, 'STAMP', stamp), \
                    patch.object(probe, 'snapshot', return_value={'version': 2}), \
                    patch.object(probe, 'owned_lock', contextlib.nullcontext), \
                    patch.object(probe, 'stop_on_signals', contextlib.nullcontext), \
                    patch.object(probe, 'run_mode', side_effect=AssertionError('never launch stale inputs')), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(probe.main(['--go', '--output', str(output)]), 2)
            self.assertFalse(output.exists())
            with patch.object(probe, 'STAMP', stamp), \
                    patch.object(probe, 'snapshot', return_value={'version': 1}), \
                    patch.object(probe, 'owned_lock', contextlib.nullcontext), \
                    patch.object(probe, 'stop_on_signals', contextlib.nullcontext), \
                    patch.object(probe, 'run_mode', return_value={'ok': False, 'error': 'native refusal'}) as run, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(probe.main(['--go', '--output', str(output)]), 1)
            self.assertEqual(run.call_count, 1)
            result = json.loads((output / 'matrix-result.json').read_text())
            self.assertFalse(result['ok'])
            self.assertFalse(result['complete'])
            self.assertEqual(len(result['results']), 1)

    def test_stream_drains_chunked_utf8_and_requires_full_matrix_sequence(self):
        for mode in ['isolated', 'related']:
            parser = stream(mode)
            rows = events(mode); rows[0]['synthetic_label'] = '→'
            data = encoded(rows)
            for byte in data:
                parser.feed(bytes([byte]))
            parser.finish()
            self.assertEqual(parser.rows, rows)
            self.assertEqual(parser.raw.getvalue(), data)

    def test_stream_rejects_invalid_json_partial_eof_and_nonfinite(self):
        for data in [b'not JSON\n', b'\n', b'[]\n', b'\xff\n', b'{"event":NaN}\n']:
            parser = stream()
            with self.subTest(data=data), self.assertRaises(probe.Refused):
                parser.feed(data)
            self.assertEqual(parser.raw.getvalue(), data)
        parser = stream(); parser.feed(b'{"partial":true}')
        with self.assertRaises(probe.Refused):
            parser.finish()
        parser = stream(); parser.feed(encoded(events()[:-1]))
        with self.assertRaises(probe.Refused):
            parser.finish()

    def test_stream_rejects_wrong_identity_group_dpr_and_cleanup(self):
        mutations = [lambda rows: rows[0].update(pid=99),
                     lambda rows: rows[0].update(mode='related'),
                     lambda rows: rows[2].update(cover=10),
                     lambda rows: rows[2].update(a=11),
                     lambda rows: rows[2].update(device_pixel_ratio=2),
                     lambda rows: rows[2].update(backing_scale=True),
                     lambda rows: rows[3].update(audit=rows[3]['audit'].replace('disposed 1', 'disposed 0')),
                     lambda rows: rows[3].update(audit=rows[3]['audit'].replace('windows 0', 'windows 1')),
                     lambda rows: rows[2].update(round=2),
                     lambda rows: rows.insert(1, rows[0])]
        for mutation in mutations:
            rows = events(); mutation(rows)
            with self.subTest(mutation=mutation), self.assertRaises(probe.Refused):
                stream().feed(encoded(rows))
        rows = events('related'); rows[2]['cover'] = 30
        with self.assertRaises(probe.Refused):
            stream('related').feed(encoded(rows))

    def test_native_failure_is_preserved_before_raising(self):
        parser = stream()
        failed = dict(event='failed', pid=42, mode='isolated', reason='synthetic refusal')
        with self.assertRaisesRegex(probe.Refused, 'synthetic refusal'):
            parser.feed(encoded([failed]))
        self.assertEqual(json.loads(parser.events.getvalue()), failed)

    def test_owned_sampling_uses_exact_root_pid_and_no_app_helper_usage(self):
        memory = module('owned_fake_memory', 'memory.py')
        usage_calls = []
        executable = Path('/owned/probe')
        class Native:
            timebase = {'numer': 125, 'denom': 3}
            def path(self, pid): return str(executable) if pid == 42 else '/other'
            def coal(self, pid): return (1, 2) if pid in [42, 50] else (3, 4)
            def monotonic(self): return 1
            def usage(self, pid):
                usage_calls.append(pid)
                return dict(started=100 if pid == 42 else 101, cpu_ns=1000, footprint=200, resident=100)
        inventory = '42 relative/argv0\n43 /owned/probe\n50 /x/com.apple.WebKit.WebContent\n51 /x/com.apple.WebKit.GPU\n60 /x/margin-helper\n'
        with patch.object(probe.subprocess, 'check_output', return_value=inventory):
            result = probe.sample_owned(memory, Native(), 42, 100, executable)
        self.assertTrue(result['complete'])
        self.assertEqual(usage_calls, [42, 50])
        self.assertEqual([m['pid'] for m in result['members']], [42, 50])
        self.assertEqual(result['metadata']['app_path'], '/owned/probe')
        self.assertIsNone(result['metadata']['helper_path'])
        self.assertIsNone(result['helper_complete'])

    def test_older_webkit_in_shared_launcher_coalition_invalidates_totals(self):
        for born in [99, 100, None]:
            memory = module('prior_webkit_memory', 'memory.py')
            calls = []
            def usage(pid):
                calls.append(pid)
                return dict(started=100 if pid == 42 else born, cpu_ns=1000, footprint=200, resident=100)
            n = SimpleNamespace(timebase={'numer': 1, 'denom': 1}, monotonic=lambda: 1,
                                coal=lambda pid: (1, 2), path=lambda pid: '/owned/probe', usage=usage)
            with patch.object(probe.subprocess, 'check_output', return_value='42 probe\n50 /x/com.apple.WebKit.WebContent\n'):
                result = probe.sample_owned(memory, n, 42, 100, Path('/owned/probe'))
            self.assertFalse(result['complete'])
            self.assertIsNone(result['total_footprint'])
            self.assertEqual(result['observed_footprint'], 200)
            self.assertTrue(result['members'][1]['unread'])
            self.assertIn('shared launcher', result['members'][1]['identity_error'])
            self.assertEqual(calls, [42, 50], 'birth validation reuses existing rusage')

    def test_source_census_requires_both_layout_pids_and_complete_sample_in_stable_phase(self):
        sample = {'complete': True, 'members': [{'pid': 10}, {'pid': 20}]}
        self.assertTrue(probe.source_census(sample, (10, 20)))
        self.assertFalse(probe.source_census(sample, None))
        self.assertFalse(probe.source_census(dict(sample, complete=False), (10, 20)))
        self.assertFalse(probe.source_census({'complete': True, 'members': [{'pid': 10}]}, (10, 20)))
        parser = stream()
        self.assertIsNone(parser.census_phase())
        rows = events()
        parser.feed(encoded(rows[:1])); self.assertEqual(parser.census_phase(), 'baseline')
        parser.feed(encoded(rows[1:2])); self.assertIsNone(parser.census_phase())
        parser.feed(encoded(rows[2:3])); self.assertEqual(parser.census_phase(), 'cover_ready:1')
        parser.feed(encoded(rows[3:-1])); self.assertEqual(parser.census_phase(), 'post_idle')
        parser.feed(encoded(rows[-1:])); self.assertIsNone(parser.census_phase())

    def test_unread_owned_path_or_reused_pid_never_becomes_a_successful_sample(self):
        memory = module('owned_identity_memory', 'memory.py')
        n = SimpleNamespace(timebase={'numer': 1, 'denom': 1}, monotonic=lambda: 1,
                            coal=lambda pid: (1, 2), path=lambda pid: '/wrong',
                            usage=lambda pid: dict(started=200, footprint=1, resident=1))
        result = probe.sample_owned(memory, n, 42, 100, Path('/owned/probe'))
        self.assertFalse(result['inventory_ok'])
        self.assertFalse(result['complete'])
        n.path = lambda pid: '/owned/probe'
        with patch.object(probe.subprocess, 'check_output', return_value='42 anything\n'), self.assertRaises(probe.Refused):
            probe.sample_owned(memory, n, 42, 100, Path('/owned/probe'))

    def test_supervisor_json_failure_terminates_only_owned_process_and_preserves_raw_tail(self):
        class Process:
            pid = 42
            returncode = None
            stdout = SimpleNamespace(fileno=lambda: 999, close=lambda: None)
            terminated = 0
            def poll(self): return self.returncode
            def terminate(self): self.terminated += 1; self.returncode = -15
            def wait(self, timeout): return self.returncode
        class Selector:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def register(self, *args): pass
            def unregister(self, *args): pass
            def select(self, timeout): return [(None, None)]
        p = Process()
        n = SimpleNamespace(usage=lambda pid: {'started': 100}, path=lambda pid: str(probe.BINARY.resolve()))
        modules = [SimpleNamespace(native=lambda: n), SimpleNamespace(owned_windows=lambda pid: [])]
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(probe, 'load_module', side_effect=modules), \
                patch.object(probe.subprocess, 'Popen', return_value=p), \
                patch.object(probe.selectors, 'DefaultSelector', Selector), \
                patch.object(probe.os, 'set_blocking'), \
                patch.object(probe.os, 'read', side_effect=[b'not JSON\n', b'raw tail\n', b'']), \
                patch.object(probe, 'sample_owned', side_effect=AssertionError('never sample after parse failure')):
            directory = Path(temporary) / 'isolated'
            result = probe.run_mode('isolated', SimpleNamespace(rounds=2, idle=4, interval=.25), directory, {})
            self.assertFalse(result['ok'])
            self.assertIn('not complete valid JSON', result['error'])
            self.assertEqual(p.terminated, 1)
            self.assertEqual((directory / 'stdout.log').read_bytes(), b'not JSON\nraw tail\n')
            self.assertTrue(result['stdout_eof'])
            self.assertEqual(json.loads((directory / 'result.json').read_text()), result)


if __name__ == '__main__':
    unittest.main()
