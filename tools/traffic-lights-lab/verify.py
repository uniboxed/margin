"""Validate observed state and restoration, rather than accepting API return codes."""
import json
from pathlib import Path

root = Path(__file__).parent / "results"
owned = [json.loads(line) for line in (root / "owned-25G342.jsonl").read_text().splitlines()]
browser = [json.loads(line) for line in (root / "chromium-25G342.jsonl").read_text().splitlines()]


def validate_owned(rows):
    assert not any(row["kind"] in ("refused", "fixture-timeout", "bad-fixture") for row in rows)
    phases = {row["phase"]: row for row in rows if row["kind"] == "fixture"}
    baseline = phases["ready"]["buttons"]
    assert len(baseline) == 3 and all(button["nativeHit"] for button in baseline)
    identity = (phases["ready"]["window"], phases["ready"]["pid"])
    for phase in phases.values():
        assert phase["windowed"] and (phase["window"], phase["pid"]) == identity
        assert len(phase["buttons"]) == 3
    external = [row for row in rows if row.get("phase", "").startswith("external-")]
    assert len(external) == 6
    for row in external:
        assert row["buttons"] == baseline, "an AX write changed native state; reassess conclusion"
    for name in ("private-reveal-zero", "private-reveal-zero-resized"):
        assert all(button["alpha"] == 0 and not button["enabled"] and not button["nativeHit"]
                   for button in phases[name]["buttons"])
    for name in ("private-buttons-hidden", "private-buttons-hidden-resized"):
        assert all(button["hidden"] and not button["nativeHit"] for button in phases[name]["buttons"])
    for name in ("private-reveal-restored", "private-buttons-restored"):
        assert phases[name]["buttons"] == baseline
    foreign = next(row for row in rows if row["kind"] == "foreign-clip")
    assert foreign["result"] == 0 and foreign["before"] == foreign["after"]
    assert foreign["before"]["result"] == 0
    before = phases["private-buttons-restored"]["clip"]
    assert phases["owner-clip-set"]["clip"] != before
    assert phases["owner-clip-restored"]["clip"] == before
    assert next(row for row in rows if row["kind"] == "fixture-cleanup")["windowClosed"]
    assert rows[-1] == {"kind": "cleanup", "childExit": 0, "childRunning": False}


def validate_browser(rows):
    assert not any(row["kind"] == "refused" for row in rows)
    first = next(row for row in rows if row["kind"] == "browser")
    assert first["windowCount"] == 1 and not first["fullscreen"]
    writes = [row for row in rows if row["kind"] == "attribute" and "writeResult" in row]
    assert len(writes) == 8
    for row in writes:
        assert not row["settable"] and row["settableResult"] == 0
        assert row["writeResult"] == 0 and row["restoreResult"] == 0
        if row["attribute"] == "AXEnabled":
            assert row["afterBool"] is True
        else:
            assert row["afterReadResult"] == -25205
    after = next(row for row in rows if row["kind"] == "after")
    assert after["windowCount"] == 1 and not after["fullscreen"]
    assert next(row for row in rows if row["kind"] == "close-owned-window")["result"] == 0
    assert next(row for row in rows if row["kind"] == "focus-restore")["result"] == 0
    assert not rows[-1]["browserRunning"] and rows[-1]["profileRemoved"] and rows[-1]["status"] == 0


validate_owned(owned)
validate_browser(browser)
# Ensure that a plausible false-success record cannot pass the native-state gate.
changed = json.loads(json.dumps(owned))
next(row for row in changed if row.get("phase") == "external-AXCloseButton-AXHidden")["buttons"][0]["hidden"] = True
try:
    validate_owned(changed)
except AssertionError:
    pass
else:
    raise AssertionError("validator accepted changed native state")
print("PASS: owned and Chromium evidence, restoration, cleanup, and false-success rejection")
