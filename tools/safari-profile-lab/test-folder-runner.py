"""Regression: a default invocation must not launch a picker or mutate its run."""
import contextlib
import io
import json
import pathlib
import runpy
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name('run-folder-probe.py')


class DryRunSafety(unittest.TestCase):
    def test_default_has_no_subprocess_or_output_files(self):
        with tempfile.TemporaryDirectory(prefix='margin-folder-runner-') as temporary:
            root = pathlib.Path(temporary)
            (root / 'build.json').write_text(json.dumps({'bundle': '/nonexistent/unlaunched.app'}))
            output = io.StringIO()
            with mock.patch.object(sys, 'argv', [str(SCRIPT), str(root)]), \
                    mock.patch('subprocess.run', side_effect=AssertionError('dry run launched a subprocess')), \
                    contextlib.redirect_stdout(output):
                with self.assertRaises(SystemExit) as exit_result:
                    runpy.run_path(str(SCRIPT), run_name='__main__')
            self.assertEqual(exit_result.exception.code, 0)
            self.assertEqual(set(json.loads(output.getvalue())), {'plan'})
            self.assertEqual(sorted(path.name for path in root.iterdir()), ['build.json'])


if __name__ == '__main__':
    unittest.main()
