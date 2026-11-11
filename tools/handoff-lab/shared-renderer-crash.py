"""Default dry run; strictly guarded own-probe WebContent crash and supervision."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
BINARY = HERE / "build/shared-renderer-crash"
FIXTURE = HERE / "build/shared-renderer-crash-hello.json"
STAMP = HERE / "build/shared-renderer-crash.sources.json"
WEB_CONTENT_SUFFIX = "/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent"


def hashes() -> dict[str, str]:
    paths = [HERE / "shared-renderer-crash.swift", HERE / "shared-renderer-crash.py", HERE / "memory.py",
             HERE / "native-cover-run.py", HERE / "native-cover-fixture.mts", BINARY, FIXTURE]
    for folder in (REPO / "app/platforms/macos/swift-sources.txt").read_text().splitlines():
        if folder and not folder.startswith("#"):
            paths.extend(sorted((REPO / folder).glob("*.swift")))
    return {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def load_tool(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_identity(row: dict, expected: str, child_ppid: int) -> None:
    """Pure refusal rules. No signal or native calls belong in this function."""
    owner, target = row.get("owner"), row.get("target")
    if not isinstance(owner, int) or not isinstance(target, int) or min(owner, target) <= 1 or target == owner:
        raise ValueError("invalid/self target")
    if child_ppid != owner:
        raise ValueError("killer is not the direct child of the owned probe")
    if row.get("ownerPath") != expected:
        raise ValueError("parent is not the exact owned probe executable")
    path = row.get("targetPath")
    if not isinstance(path, str) or not path.startswith("/System/") or not path.endswith(WEB_CONTENT_SUFFIX):
        raise ValueError("target is not the exact system WebContent executable kind")
    own_coal, target_coal = row.get("ownerResourceCoalition"), row.get("targetResourceCoalition")
    if not isinstance(own_coal, int) or own_coal <= 0 or target_coal != own_coal:
        raise ValueError("target does not share the owned probe resource coalition")
    if any(not isinstance(row.get(key), int) or row[key] <= 0 for key in ["ownerStarted", "targetStarted"]):
        raise ValueError("process birth identity unavailable")


def snapshot(native, owner: int, target: int) -> dict:
    own_usage, target_usage = native.usage(owner), native.usage(target)
    own_coal, target_coal = native.coal(owner), native.coal(target)
    return {
        "owner": owner, "target": target, "ownerPath": native.path(owner), "targetPath": native.path(target),
        "ownerStarted": own_usage.get("started") if own_usage else None,
        "targetStarted": target_usage.get("started") if target_usage else None,
        "ownerResourceCoalition": own_coal[0] if own_coal else None,
        "targetResourceCoalition": target_coal[0] if target_coal else None,
    }


def kill_owned(owner: int, target: int, receipt: Path) -> int:
    result = {"signalSent": False, "owner": owner, "target": target, "startedWall": time.time()}
    try:
        if target == os.getpid():
            raise ValueError("target is the guard child")
        native = load_tool("shared_crash_memory", HERE / "memory.py").native()
        expected = str(BINARY.resolve(strict=True))
        first = snapshot(native, owner, target)
        validate_identity(first, expected, os.getppid())
        # Recheck path, resource coalition, parent relationship and both birth
        # identities immediately before the only signal. Never search for PIDs.
        second = snapshot(native, owner, target)
        validate_identity(second, expected, os.getppid())
        if first != second:
            raise ValueError("process identity changed between independent reads")
        result["verifiedIdentity"] = second
        result["signalAtBootTime"] = native.monotonic()
        os.kill(target, signal.SIGKILL)
        result["signalSent"] = True
        end = time.monotonic() + 1.5
        gone = False
        while time.monotonic() < end:
            usage = native.usage(target)
            if usage is None or usage.get("started") != first["targetStarted"]:
                gone = True
                break
            time.sleep(0.01)
        result["originalTargetExitObserved"] = gone
        return_code = 0 if gone else 1
    except (OSError, ValueError, RuntimeError, AssertionError) as error:
        result["refused"] = str(error)
        return_code = 2
    result["endedWall"] = time.time()
    receipt.write_text(json.dumps(result, indent=2) + "\n")
    return return_code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--stamp", action="store_true")
    parser.add_argument("--go", action="store_true")
    parser.add_argument("--kill-webcontent", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--owner", type=int)
    parser.add_argument("--target", type=int)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--root", type=Path, default=REPO / "dist/app")
    args = parser.parse_args()
    if args.stamp:
        STAMP.write_text(json.dumps(hashes(), indent=2) + "\n")
        return 0
    if not args.go:
        print(json.dumps({"dryRun": True, "createsApplication": False, "physicalDisplaySurface": False,
                          "sources": "two actual OverlayControllers; alpha0, verified outside AppKit and CG display bounds",
                          "cover": "actual Native.prepare only; never activate or install real Space mutation callbacks",
                          "crash": "direct child validates exact parent executable, WebContent path, coalition0 and repeated started identity before one SIGKILL",
                          "checks": "actual native delegates; A reload/newPID/newtimeOrigin; B unchanged; 2→3→2→0 bridge; restored per-view settings; weak cover gone; owned panels gone",
                          "outerTimeoutSeconds": 25, "installedMarginOrBrowserControlled": False}, indent=2))
        return 0
    if args.kill_webcontent:
        if args.owner is None or args.target is None or args.receipt is None:
            parser.error("guard child needs exact owner/target/receipt")
        return kill_owned(args.owner, args.target, args.receipt)
    try:
        if json.loads(STAMP.read_text()) != hashes():
            parser.error("source/binary changed; root must serialize a fresh --build")
    except (OSError, json.JSONDecodeError):
        parser.error("build/stamp missing; root must serialize --build")
    if not all((args.root / name).is_file() for name in ["overlay.html", "overlay.js", "handoff-cover.html", "handoff-cover.js"]):
        parser.error("built owned pages missing; no app/dist build runs automatically")
    output = Path(tempfile.mkdtemp(prefix="margin-owned-renderer-crash-"))
    receipt = output / "guarded-kill.json"
    command = [str(BINARY), "--go", "--root", str(args.root.resolve()), "--hello", str(FIXTURE),
               "--python", sys.executable, "--killer", str(Path(__file__).resolve()), "--receipt", str(receipt)]
    (output / "manifest.json").write_text(json.dumps({"command": command, "sources": hashes(), "startedWall": time.time(),
        "scope": "strictly own/offscreen actual shared-renderer crash; no production browser/Space/physical composition claim"}, indent=2) + "\n")
    print(f"Owned offscreen crash evidence: {output}", flush=True)
    status, timed_out = 1, False
    with (output / "native.jsonl").open("wb") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        try:
            status = process.wait(timeout=25)
        except subprocess.TimeoutExpired:
            timed_out = True
        except KeyboardInterrupt:
            pass
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            read = load_tool("shared_crash_cleanup", HERE / "native-cover-run.py").owned_windows
            windows = read(process.pid)
            until = time.monotonic() + 2
            while windows and time.monotonic() < until:
                time.sleep(0.05)
                windows = read(process.pid)
            result = {"exit": process.returncode, "timedOut": timed_out, "ownedPID": process.pid,
                      "ownedWindowsAfterExit": windows, "cleanupVerified": windows == []}
            (output / "outer-result.json").write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps(result), flush=True)
    return 0 if status == 0 and not timed_out and windows == [] else 1


if __name__ == "__main__":
    raise SystemExit(main())
