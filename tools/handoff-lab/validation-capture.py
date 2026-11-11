"""Default dry run; supervise resource health before/during an approved MATCHED gate.

This tool never installs/restarts Margin or changes its launch flag. Its caller
owns that restoration. --check samples read-only; --go additionally requires
prior approval for the fixed 50-switch protocol. A CLI marker is not approval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
APP = Path.home() / 'Applications/Margin.app'
LAB = HERE / 'build/handoff-lab'
SAMPLER_SECONDS = 600  # memory.py's supported bound; never launch with 1200


def gate_recorded(text):
    # The lab also exits 0 for not-run/partial outcomes. Only its final recorded
    # marker follows the complete fixed 50 protocol; exit status alone is not it.
    return re.search(r'^\s*[0-9]+\s+ms\s+== MATCHED: recorded\s*$', text, re.MULTILINE) is not None


def identity(row):
    if not isinstance(row, dict) or row.get('complete') is not True or row.get('helper_complete') is not True:
        raise ValueError('resource sample incomplete; no further switch allowed')
    pid = row.get('app_pid')
    app = [m for m in row.get('members', []) if m.get('kind') == 'app' and m.get('pid') == pid]
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1 or len(app) != 1:
        raise ValueError('no unique app resource identity')
    birth = app[0].get('started')
    if not isinstance(birth, int) or isinstance(birth, bool) or birth <= 0:
        raise ValueError('app birth identity unavailable')
    for key in ['sample_start_mono', 'sample_end_mono']:
        value = row.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ValueError('sample monotonic clock missing/invalid')
    if row['sample_end_mono'] < row['sample_start_mono']:
        raise ValueError('sample clock moved backward')
    return pid, birth


def stop_owned(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def capture(sampler_command, gate_command, output, startup_seconds=5, deadline_seconds=570):
    """Commands are fixed by main; injectable only for no-window refusal tests."""
    output.mkdir(parents=True, exist_ok=False)
    sampler = gate = None
    rows = 0
    root_identity = None
    last_end = None
    error = None
    gate_exit = None
    buffer = b''
    started = time.monotonic()
    try:
        with (output / 'memory.jsonl').open('wb') as resources, (output / 'memory.stdout.log').open('wb') as raw, \
                (output / 'memory.err').open('wb') as errors, \
                (output / 'gate.log').open('wb') as gate_log, selectors.DefaultSelector() as selector:
            sampler = subprocess.Popen(sampler_command, stdout=subprocess.PIPE, stderr=errors)
            os.set_blocking(sampler.stdout.fileno(), False)
            selector.register(sampler.stdout, selectors.EVENT_READ)
            last_sample = started
            while True:
                now = time.monotonic()
                if now - started > deadline_seconds:
                    raise RuntimeError('capture deadline; stop only owned gate/sampler')
                if sampler.poll() is not None:
                    raise RuntimeError('sampler exited before gate completion; no further switch allowed')
                if gate is None and now - started > startup_seconds:
                    raise RuntimeError('two healthy samples not received before any switch')
                if now - last_sample > startup_seconds:
                    raise RuntimeError('sampler stopped producing samples; no further switch allowed')
                for _, _ in selector.select(timeout=.05):
                    data = os.read(sampler.stdout.fileno(), 65536)
                    if not data:
                        raise RuntimeError('sampler stdout ended before gate completion')
                    raw.write(data); raw.flush()
                    buffer += data
                    if len(buffer) > 1024 * 1024:
                        raise ValueError('sampler stdout exceeds bounded frame')
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        row = json.loads(line, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
                        current = identity(row)
                        if last_end is not None and row['sample_start_mono'] < last_end:
                            raise ValueError('resource clock continuity lost')
                        last_end = row['sample_end_mono']
                        if root_identity is not None and current != root_identity:
                            raise ValueError('app PID/birth changed; same-process comparison lost')
                        root_identity = current
                        resources.write(line + b'\n'); resources.flush()
                        rows += 1
                        last_sample = time.monotonic()
                if gate is None and rows >= 2:
                    if sampler.poll() is not None:
                        raise RuntimeError('sampler died at startup; gate never launched')
                    if gate_command is None:
                        break  # read-only health check, never a browser request
                    gate = subprocess.Popen(gate_command, stdout=gate_log, stderr=subprocess.STDOUT)
                if gate is not None and gate.poll() is not None:
                    gate_exit = gate.returncode
                    if gate_exit != 0:
                        raise RuntimeError('gate failed; no retry or extra request')
                    break
    except (Exception, KeyboardInterrupt) as failure:
        error = type(failure).__name__ + ': ' + str(failure)
    finally:
        # The lab's SIGTERM handler restores its caps; the outer caller then
        # restores the launch flag/app. Never signal an app/browser here.
        stop_owned(gate)
        stop_owned(sampler)
        if sampler is not None and sampler.stdout:
            sampler.stdout.close()
        result = {'ok': error is None, 'error': error, 'healthy_samples': rows,
                  'app_identity': root_identity, 'gate_started': gate is not None,
                  'gate_exit': gate.returncode if gate else gate_exit,
                  'sampler_exit': sampler.returncode if sampler else None,
                  'sampler_seconds': SAMPLER_SECONDS, 'elapsed_seconds': time.monotonic() - started}
        (output / 'capture-result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--dry-run', action='store_true')
    modes.add_argument('--check', action='store_true', help='read-only sampler health; no switch/default change')
    modes.add_argument('--go', action='store_true')
    parser.add_argument('--approved-50', action='store_true', help='records prior approval; does not grant it')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not args.check and not args.go:
        print(json.dumps({'dryRun': True, 'samplerSeconds': SAMPLER_SECONDS,
                          'startupGate': 'two complete samples with one stable app PID/birth before lab launch',
                          'duringGate': 'sampler exit, invalid/incomplete data, identity change or5s silence stops owned lab',
                          'requests': 'MATCHED fixed50, only with prior approval; --check switches zero',
                          'installsOrRestartsApp': False, 'changesDefaults': False}, indent=2))
        return 0
    if args.go and not args.approved_50:
        parser.error('--go requires prior approval for the fixed50 protocol and --approved-50 marker')
    if args.output is None or args.output.exists():
        parser.error('choose a new --output directory; previous captures are never overwritten')
    if args.go:
        subprocess.run([str(LAB), 'matched', '--dry-run', '--app', str(APP)], check=True, timeout=10)
    args.output.mkdir(parents=True, exist_ok=False)
    paths = [Path(__file__).resolve(), HERE / 'memory.py', LAB, APP / 'Contents/MacOS/Margin']
    manifest = {'sourceHashes': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
                'samplerSeconds': SAMPLER_SECONDS, 'mode': 'matched' if args.go else 'read-only-check',
                'approvedMarker': args.approved_50, 'startedWall': time.time()}
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    sampler = [sys.executable, str(HERE / 'memory.py'), '--duration', str(SAMPLER_SECONDS)]
    gate = [str(LAB), 'matched', '--go', '--app', str(APP)] if args.go else None
    # Use a child directory so capture can refuse any pre-existing output.
    def interrupted(signum, frame):
        raise InterruptedError('signal ' + str(signum))
    previous = {sig: signal.signal(sig, interrupted) for sig in [signal.SIGTERM, signal.SIGHUP]}
    try:
        result = capture(sampler, gate, args.output / 'capture')
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    if args.go and result['ok'] and not gate_recorded((args.output / 'capture/gate.log').read_text()):
        result.update(ok=False, error='gate exited without recording the complete MATCHED protocol')
        (args.output / 'capture/capture-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
