"""Pure guard refusal checks. No native process inventory or signal."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "shared-renderer-crash.py"
spec = importlib.util.spec_from_file_location("shared_crash", path)
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.expected = "/owned/build/shared-renderer-crash"
        self.row = {"owner": 100, "target": 200, "ownerPath": self.expected,
                    "targetPath": "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices" + tool.WEB_CONTENT_SUFFIX,
                    "ownerResourceCoalition": 77, "targetResourceCoalition": 77,
                    "ownerStarted": 1000, "targetStarted": 2000}

    def test_exact_owned_identity_permitted(self):
        tool.validate_identity(self.row, self.expected, 100)

    def test_foreign_process_classes_refused(self):
        for change in [{"ownerPath": "/Users/a/Applications/Margin.app/Contents/MacOS/Margin"},
                       {"targetPath": "/System/Library/WebKit/com.apple.WebKit.GPU"},
                       {"targetPath": "/tmp" + tool.WEB_CONTENT_SUFFIX},
                       {"targetResourceCoalition": 88}, {"targetResourceCoalition": None},
                       {"ownerResourceCoalition": 0}, {"targetStarted": None}, {"ownerStarted": 0},
                       {"target": 100}, {"target": 1}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                tool.validate_identity(self.row | change, self.expected, 100)

    def test_indirect_child_refused(self):
        with self.assertRaises(ValueError):
            tool.validate_identity(self.row, self.expected, 999)


if __name__ == "__main__":
    unittest.main()
