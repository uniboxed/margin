"""Read-only Margin + attributed WebKit sampling; never opens or moves a window.

Legacy CLI and byte fields are retained. Schema 2 adds read-time boundaries,
identity and coverage metadata. CPU counters are Mach ticks, converted with the
host timebase; no process memory contents or browser data are read.
"""
import argparse
import ctypes as C
import json
import platform
import subprocess
import time
from pathlib import Path

SCHEMA_VERSION = 2
APP = str(Path.home() / 'Applications/Margin.app/Contents/MacOS/Margin')
HELPER = str(Path.home() / 'Applications/Margin.app/Contents/Helpers/margin-helper')
# Installed SDK: sys/proc_info.h PROC_PIDPATHINFO_MAXSIZE = 4*MAXPATHLEN;
# sys/param.h MAXPATHLEN = PATH_MAX; sys/syslimits.h PATH_MAX = 1024.
PIDPATH_BYTES = 4096


class Coal(C.Structure):
    _fields_ = [('ids', C.c_uint64 * 2), ('reserved', C.c_uint64 * 3)]


class Usage(C.Structure):
    _fields_ = [('uuid', C.c_uint8 * 16)] + [(n, C.c_uint64) for n in [
        'user', 'system', 'idle_wakeups', 'interrupt_wakeups', 'pageins',
        'wired', 'resident', 'footprint', 'started', 'exited']]


class Timebase(C.Structure):
    _fields_ = [('numer', C.c_uint32), ('denom', C.c_uint32)]


assert C.sizeof(Coal) == 40 and C.sizeof(Usage) == 96


class Native:
    """Lazy so synthetic tests/imports do not query any native process."""
    def __init__(self):
        self.lib = C.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        self.lib.proc_pidinfo.argtypes = [C.c_int, C.c_int, C.c_uint64, C.c_void_p, C.c_int]
        self.lib.proc_pid_rusage.argtypes = [C.c_int, C.c_int, C.c_void_p]
        self.lib.proc_pidpath.argtypes = [C.c_int, C.c_void_p, C.c_uint32]
        system = C.CDLL('/usr/lib/libSystem.B.dylib')
        system.mach_timebase_info.argtypes = [C.POINTER(Timebase)]
        tb = Timebase()
        known = system.mach_timebase_info(C.byref(tb)) == 0 and tb.denom > 0
        self.timebase = {'numer': tb.numer, 'denom': tb.denom} if known else None
        self.absolute_ticks = system.mach_absolute_time
        self.absolute_ticks.argtypes = []
        self.absolute_ticks.restype = C.c_uint64

    def monotonic(self):
        # Some installed Python runtimes offset time.monotonic() per process.
        # Raw Mach time shares ProcessInfo.systemUptime's boot origin.
        if not self.timebase:
            return time.monotonic()
        return self.absolute_ticks() * self.timebase['numer'] / self.timebase['denom'] / 1e9

    def coal(self, pid):
        c = Coal()
        return tuple(c.ids) if self.lib.proc_pidinfo(pid, 20, 0, C.byref(c), C.sizeof(c)) == C.sizeof(c) else None

    def usage(self, pid):
        u = Usage()
        if self.lib.proc_pid_rusage(pid, 0, C.byref(u)) != 0:
            return None
        result = {n: getattr(u, n) for n in ['resident', 'footprint', 'user', 'system', 'started']}
        if self.timebase:
            result['cpu_ns'] = (u.user + u.system) * self.timebase['numer'] // self.timebase['denom']
        return result

    def path(self, pid):
        buffer = C.create_string_buffer(PIDPATH_BYTES)
        count = self.lib.proc_pidpath(pid, buffer, C.sizeof(buffer))
        if not 0 < count < PIDPATH_BYTES:
            return None
        try:
            value = buffer.value.decode('utf-8')
        except UnicodeDecodeError:
            return None
        return value if value.startswith('/') else None


_native = None


def native():
    global _native
    if _native is None:
        _native = Native()
    return _native


def coal(pid):
    return native().coal(pid)


def usage(pid):
    return native().usage(pid)


def stamp():
    return {'at': time.time(), 'mono': native().monotonic()}


def metadata(timebase):
    return {
        'schema_version': SCHEMA_VERSION, 'sampler': 'handoff-lab/memory.py',
        'os': platform.system(), 'os_release': platform.release(),
        'macos_version': platform.mac_ver()[0], 'architecture': platform.machine(),
        'python_version': platform.python_version(), 'timebase': timebase,
        'cpu_raw_unit': 'Mach timebase ticks', 'cpu_ns_unit': 'nanoseconds',
        'wall_unit': 'epoch seconds', 'mono_unit': 'seconds',
        'monotonic_clock': 'raw mach_absolute_time()' if timebase else time.get_clock_info('monotonic').implementation,
        'monotonic_origin': 'boot' if timebase else 'python runtime (origin unverified)',
        'app_path': APP, 'helper_path': HELPER,
        'coalition_bytes': C.sizeof(Coal), 'rusage_v0_bytes': C.sizeof(Usage),
    }


def collect(processes, coalition_read, usage_read, clock=stamp, meta=None, path_read=None):
    """One bounded inventory. Unknown WebKit candidates invalidate census totals.

    `complete` does not cover processes born after ps, exited between reads, or
    non-WebKit coalition members: those limits remain even on a successful read.
    """
    begin = clock()
    result = {
        'schema_version': SCHEMA_VERSION, 'metadata': meta or {},
        'sample_start_at': begin['at'], 'sample_start_mono': begin['mono'],
        'coverage': 'Margin and attributed WebKit; exact installed helper separate',
        'members': [], 'helper': [], 'unknown_candidates': [], 'unknown_helper_candidates': [],
        'inventory_ok': False, 'census_complete': False, 'complete': False,
        'helper_complete': False, 'total_footprint': None, 'total_resident': None,
        'limitations': ['Sequential ps inventory and reads are not an atomic process census.',
                        'Only Margin and WebKit candidates are included; not every coalition member.',
                        'Exited-process final CPU and sub-sample memory peaks may be missed.'],
    }

    def finish():
        end = clock()
        result.update(at=end['at'], sample_end_at=end['at'], sample_end_mono=end['mono'],
                      sample_duration_ms=(end['mono'] - begin['mono']) * 1000)
        return result

    try:
        ps = list(processes())
        result['inventory_ok'] = True
    except Exception as error:
        result['error'] = 'process inventory failed: ' + type(error).__name__
        return finish()
    apps = [p for p, name in ps if name == APP]
    if len(apps) != 1:
        result['error'] = 'no unique Margin process'
        return finish()
    pid = apps[0]
    result['app_pid'] = pid
    group = coalition_read(pid)
    if not group or not group[0]:
        result['error'] = 'Margin coalition unread; no aggregate claimed'
        return finish()
    result['coalition'] = group
    candidates = [(p, name) for p, name in ps if p == pid or 'com.apple.WebKit.' in name]
    result['candidate_count'] = len(candidates)
    result['unrelated_webkit_count'] = 0
    for p, name in candidates:
        kind = 'app' if p == pid else name.rsplit('/', 1)[-1]
        c = coalition_read(p)
        if not c:
            result['unknown_candidates'].append({'pid': p, 'kind': kind, 'reason': 'coalition unread or process exited'})
            continue
        if c[0] != group[0]:
            if p == pid:
                result['unknown_candidates'].append({'pid': p, 'kind': kind, 'reason': 'app coalition changed'})
            else:
                result['unrelated_webkit_count'] += 1
            continue
        read_begin = clock()
        u = usage_read(p)
        read_end = clock()
        row = {'pid': p, 'kind': kind, 'coalition': c,
               'read_start_at': read_begin['at'], 'read_start_mono': read_begin['mono'],
               'read_at': read_end['at'], 'read_mono': read_end['mono'],
               **(u or {'unread': True})}
        # Association is rechecked after rusage; a disappearing/changing process
        # must not be silently presented as an attributed successful read.
        if coalition_read(p) != c:
            row['unread'] = True
            row['identity_error'] = 'coalition changed or unread after rusage'
        row['identity'] = {'pid': p, 'started': row.get('started')}
        result['members'].append(row)
    helper_candidates = [(p, name) for p, name in ps if name.rsplit('/', 1)[-1] == 'margin-helper']
    result['helper_candidate_count'] = len(helper_candidates)
    result['unrelated_helper_count'] = 0
    expected_helper = str(Path(HELPER).resolve())
    for p, name in helper_candidates:
        # ps COMM can be the launch agent's relative argv[0]. It identifies a
        # candidate only; libproc supplies the executable path we attribute.
        actual = path_read(p) if path_read else None
        if not actual or not actual.startswith('/'):
            result['unknown_helper_candidates'].append({'pid': p, 'reason': 'executable path unread or process exited'})
            continue
        resolved = str(Path(actual).resolve())
        if resolved != expected_helper:
            result['unrelated_helper_count'] += 1
            continue
        read_begin = clock()
        u = usage_read(p)
        read_end = clock()
        row = {
            'pid': p, 'kind': 'helper', 'path': resolved,
            'read_start_at': read_begin['at'], 'read_start_mono': read_begin['mono'],
            'read_at': read_end['at'], 'read_mono': read_end['mono'],
            'identity': {'pid': p, 'started': u.get('started') if u else None},
            **(u or {'unread': True}),
        }
        again = path_read(p)
        if not again or not again.startswith('/') or str(Path(again).resolve()) != expected_helper:
            row['unread'] = True
            row['identity_error'] = 'helper executable changed or unread after rusage'
        result['helper'].append(row)
    members = result['members']
    readable = [m for m in members if not m.get('unread')]
    result['observed_footprint'] = sum(m['footprint'] for m in readable)
    result['observed_resident'] = sum(m['resident'] for m in readable)
    result['census_complete'] = not result['unknown_candidates']
    result['complete'] = (result['census_complete'] and any(m['pid'] == pid for m in readable)
                          and len(readable) == len(members))
    result['helper_complete'] = not result['unknown_helper_candidates'] and all(not m.get('unread') for m in result['helper'])
    result['helper_count'] = len(result['helper'])  # zero is explicit absence, not a zero-byte helper
    if result['complete']:
        result['total_footprint'] = result['observed_footprint']
        result['total_resident'] = result['observed_resident']
    return finish()


def process_list():
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True)
    return [(int(parts[0]), parts[1]) for line in rows.splitlines()
            if len(parts := line.strip().split(None, 1)) == 2]


def sample():
    n = native()
    return collect(process_list, n.coal, n.usage, meta=metadata(n.timebase), path_read=n.path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--duration', type=float, default=0)
    parser.add_argument('--interval', type=float, default=.25)
    args = parser.parse_args()
    if not 0 <= args.duration <= 600 or not .1 <= args.interval <= 10:
        parser.error('duration 0–600 seconds, interval 0.1–10 seconds')
    end = time.monotonic() + args.duration
    while True:
        print(json.dumps(sample()), flush=True)
        if time.monotonic() >= end:
            break
        time.sleep(args.interval)
