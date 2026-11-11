"""No windows/apps: exercise child-process failure supervision with tiny stand-ins."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

path = Path(__file__).resolve().parents[1] / 'validation-capture.py'
spec = importlib.util.spec_from_file_location('validation_capture', path)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def row():
    return {'complete': True, 'helper_complete': True, 'app_pid': 123,
            'members': [{'kind': 'app', 'pid': 123, 'started': 999}],
            'sample_start_mono': 1., 'sample_end_mono': 1.01}


def sampler(tail):
    return [sys.executable, '-c', 'import json,time\nr=' + repr(row()) + '''
for i in range(2):
 r['sample_start_mono']=float(i+1)
 r['sample_end_mono']=float(i+1)+.01
 print(json.dumps(r),flush=True)
 time.sleep(.05)
''' + tail]


class CaptureTests(unittest.TestCase):
    def test_not_run_or_partial_zero_exit_is_not_complete(self):
        self.assertTrue(tool.gate_recorded('  300000 ms  == MATCHED: recorded\n'))
        for text in ['  20 ms  == MATCHED: not run\n', '  20 ms  == MATCHED: partial\n',
                     '  20 ms  == MATCHED: fail\n', 'recorded', '']:
            self.assertFalse(tool.gate_recorded(text))

    def test_supported_sampler_bound(self):
        self.assertEqual(tool.SAMPLER_SECONDS, 600)
        # Actual CLI refuses the original mistake before native() can run.
        import subprocess
        result = subprocess.run([sys.executable, str(path.parent / 'memory.py'), '--duration', '1200'], capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b'duration 0', result.stderr)

    def test_identity_refuses_unknown_data(self):
        self.assertEqual(tool.identity(row()), (123, 999))
        for change in [{'complete': False}, {'helper_complete': False}, {'app_pid': True},
                       {'members': []}, {'sample_end_mono': 0}, {'sample_start_mono': float('nan')}]:
            bad = copy.deepcopy(row()); bad.update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                tool.identity(bad)

    def test_dead_sampler_cannot_start_gate(self):
        with tempfile.TemporaryDirectory() as root:
            marker = Path(root) / 'gate-started'
            gate = [sys.executable, '-c', 'from pathlib import Path; Path(' + repr(str(marker)) + ').touch()']
            result = tool.capture([sys.executable, '-c', 'raise SystemExit(2)'], gate, Path(root) / 'out', startup_seconds=.5, deadline_seconds=2)
            self.assertFalse(result['ok'])
            self.assertFalse(result['gate_started'])
            self.assertFalse(marker.exists())

    def test_read_only_health_check_stops_own_sampler(self):
        with tempfile.TemporaryDirectory() as root:
            result = tool.capture(sampler('time.sleep(30)'), None, Path(root) / 'out', startup_seconds=1, deadline_seconds=2)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['healthy_samples'], 2)
            self.assertFalse(result['gate_started'])
            self.assertIsNotNone(result['sampler_exit'])

    def test_late_sampler_exit_stops_owned_gate(self):
        with tempfile.TemporaryDirectory() as root:
            marker = Path(root) / 'gate-started'
            gate = [sys.executable, '-c', 'import time; from pathlib import Path; Path(' + repr(str(marker)) + ').touch(); time.sleep(30)']
            result = tool.capture(sampler('time.sleep(.2); raise SystemExit(3)'), gate, Path(root) / 'out', startup_seconds=1, deadline_seconds=2)
            self.assertFalse(result['ok'])
            self.assertTrue(result['gate_started'])
            self.assertTrue(marker.exists())
            self.assertIsNotNone(result['gate_exit'])
            self.assertIn('sampler', result['error'])

    def test_invalid_live_sample_stops_owned_gate(self):
        with tempfile.TemporaryDirectory() as root:
            gate = [sys.executable, '-c', 'import time; time.sleep(30)']
            result = tool.capture(sampler('time.sleep(.15); print("not-json",flush=True); time.sleep(30)'), gate,
                                  Path(root) / 'out', startup_seconds=1, deadline_seconds=2)
            self.assertFalse(result['ok'])
            self.assertTrue(result['gate_started'])
            self.assertIsNotNone(result['gate_exit'])
            self.assertIsNotNone(result['sampler_exit'])

    def test_successful_gate_stops_only_owned_sampler(self):
        with tempfile.TemporaryDirectory() as root:
            result = tool.capture(sampler('time.sleep(30)'), [sys.executable, '-c', 'pass'], Path(root) / 'out', startup_seconds=1, deadline_seconds=2)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['gate_exit'], 0)


if __name__ == '__main__':
    unittest.main()
