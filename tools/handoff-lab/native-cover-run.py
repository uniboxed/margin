"""Bounded supervisor for the explicitly approved owned corner-panel probe."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
BINARY = HERE / "build/native-cover-probe"
FIXTURE = HERE / "build/native-cover-hello.json"
STAMP = HERE / "build/native-cover-probe.sources.json"


def source_hashes() -> dict[str, str]:
    paths = [HERE / "native-cover-probe.swift", HERE / "native-cover-fixture.mts", FIXTURE, BINARY]
    for line in (REPO / "app/platforms/macos/swift-sources.txt").read_text().splitlines():
        if line and not line.startswith("#"):
            paths.extend(sorted((REPO / line).glob("*.swift")))
    return {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def owned_windows(pid: int) -> list[int] | None:
    """Read only. Return this probe PID's window numbers, never other metadata."""
    try:
        cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
        cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
        cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
        cf.CFArrayGetCount.restype = ctypes.c_long
        cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
        cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
        cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        cf.CFDictionaryGetValue.restype = ctypes.c_void_p
        cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.c_void_p]
        cf.CFNumberGetValue.restype = ctypes.c_bool
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        pid_key = ctypes.c_void_p.in_dll(cg, "kCGWindowOwnerPID").value
        number_key = ctypes.c_void_p.in_dll(cg, "kCGWindowNumber").value
        array = cg.CGWindowListCopyWindowInfo(0, 0)
        if not array:
            return None
        result = []
        try:
            for i in range(cf.CFArrayGetCount(array)):
                row = cf.CFArrayGetValueAtIndex(array, i)
                owner = ctypes.c_int64()
                raw = cf.CFDictionaryGetValue(row, pid_key)
                if not raw or not cf.CFNumberGetValue(raw, 4, ctypes.byref(owner)) or owner.value != pid:
                    continue
                number = ctypes.c_int64()
                raw = cf.CFDictionaryGetValue(row, number_key)
                if raw and cf.CFNumberGetValue(raw, 4, ctypes.byref(number)):
                    result.append(number.value)
            return result
        finally:
            cf.CFRelease(array)
    except (OSError, ValueError, AttributeError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--stamp", action="store_true")
    parser.add_argument("--go", action="store_true")
    parser.add_argument("--approved-corner", action="store_true", help="marker only; prior explicit approval is still required")
    parser.add_argument("--mode", choices=["watchdog", "cancel-reuse", "session"], default="watchdog")
    parser.add_argument("--event", choices=["screen locked", "will sleep", "displays changed"], default="screen locked")
    parser.add_argument("--root", type=Path, default=REPO / "dist/app")
    args = parser.parse_args()
    if args.stamp:
        STAMP.write_text(json.dumps(source_hashes(), indent=2) + "\n")
        return 0
    if not args.go:
        print(json.dumps({
            "dryRun": True, "createsApplication": False, "privateWrites": False,
            "mode": args.mode, "panel": "320×180, lower right of single display visible area, passive, synthetic context",
            "watchdog": "production20s; block only probe main22s; independent owned-window observer child",
            "cancel-reuse": "cancel before deadline; reuse same object; cross first cancelled deadline while second cover remains shown",
            "session": "user initiates requested event within15s READY window; probe never locks/sleeps/changes displays",
            "outerTimeoutSeconds": 50, "launchDefaultChanged": False, "browserControlled": False,
            "requires": "explicit approval before --go --approved-corner; root-serialized --build first",
            "limits": "metadata/native component coverage; no pixel proof or production Shell/browser recovery claim",
        }, indent=2))
        return 0
    if not args.approved_corner:
        parser.error("--go requires --approved-corner after explicit approval for this corner-panel run")
    try:
        recorded = json.loads(STAMP.read_text())
        if source_hashes() != recorded:
            parser.error("source/binary stamp changed; root must serialize a fresh --build before this run")
    except (OSError, json.JSONDecodeError):
        parser.error("build/stamp missing; root must serialize --build before this run")
    if not (args.root / "handoff-cover.html").is_file() or not (args.root / "handoff-cover.js").is_file():
        parser.error("built cover page missing; this supervisor never runs an app/dist build")
    directory = Path(tempfile.mkdtemp(prefix="margin-native-cover-"))
    output = directory / "events.jsonl"
    command = [str(BINARY), "--go", "--approved-corner", "--mode", args.mode, "--event", args.event,
               "--root", str(args.root.resolve()), "--hello", str(FIXTURE), "--output", str(output)]
    # A snapshot identifies the exact assets being rendered; no page data is captured.
    assets = {name: hashlib.sha256((args.root / name).read_bytes()).hexdigest()
              for name in ["handoff-cover.html", "handoff-cover.js"]}
    manifest = {"command": command, "assets": assets, "sourceStamp": recorded, "mode": args.mode,
                "startedWall": time.time(), "scope": "owned native probe, no browser/default/restart", "approvedMarker": True}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Probe output: {directory}", flush=True)
    process = subprocess.Popen(command)
    status = 1
    timed_out = False
    try:
        status = process.wait(timeout=50)
    except subprocess.TimeoutExpired:
        timed_out = True
        print("STOP: outer50s deadline. Terminating only the owned probe PID.", file=sys.stderr)
    except KeyboardInterrupt:
        print("STOP: interrupted. Terminating only the owned probe PID.", file=sys.stderr)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        remaining = owned_windows(process.pid)
        deadline = time.monotonic() + 2
        while remaining and time.monotonic() < deadline:
            time.sleep(0.05)
            remaining = owned_windows(process.pid)
        cleanup = remaining == []
        result = {"exit": process.returncode, "timedOut": timed_out, "ownPID": process.pid,
                  "ownedWindowsAfterExit": remaining, "cleanupVerified": cleanup, "endedWall": time.time()}
        (directory / "outer-result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result), flush=True)
    return 0 if status == 0 and not timed_out and cleanup else 1


if __name__ == "__main__":
    raise SystemExit(main())
