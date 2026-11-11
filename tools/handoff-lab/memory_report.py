"""Describe guarded validation events and sampled resources; never grade performance.

Events: request/settled/idle_begin/idle_end, index, phase, mode, at (epoch ms),
mono (systemUptime seconds); settled.ok or status records the gate's outcome.
Samples: memory.py JSONL, including legacy wall-clock-only captures. Outputs JSON.
"""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import statistics

MIB = 1024 * 1024
NORMAL_PHASES = {'matched', 'repeated'}
MODES = ('freeze', 'live')


def number(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def percentile(values, q):
    """Nearest-rank descriptive quantile; small groups are not inferential."""
    values = sorted(v for v in values if number(v))
    return values[max(0, math.ceil(q * len(values)) - 1)] if values else None


def distribution(values):
    values = [v for v in values if number(v)]
    return {'count': len(values), 'p50': statistics.median(values) if values else None,
            'p95_descriptive': percentile(values, .95),
            'min': min(values) if values else None, 'max': max(values) if values else None}


def identity(row):
    pid, started = row.get('pid'), row.get('started')
    return f'{pid}:{started}' if isinstance(pid, int) and isinstance(started, int) and pid > 0 and started > 0 else None


def event_time(event, clock):
    value = event.get('mono') if clock == 'mono' else event.get('at')
    return value if number(value) and clock == 'mono' else value / 1000 if number(value) else None


def sample_bounds(sample, clock):
    if clock == 'mono':
        start, end = sample.get('sample_start_mono'), sample.get('sample_end_mono')
    else:
        start, end = sample.get('sample_start_at', sample.get('at')), sample.get('sample_end_at', sample.get('at'))
    return (start, end) if number(start) and number(end) and start <= end else (None, None)


def row_time(row, sample, clock):
    value = row.get('read_mono' if clock == 'mono' else 'read_at')
    return value if number(value) else sample_bounds(sample, clock)[1]


def snapshot(sample):
    if sample is None:
        return None
    return {
        'at': sample.get('at'), 'mono': sample.get('sample_end_mono'),
        'complete': sample.get('complete') is True,
        'footprint_mib': sample['total_footprint'] / MIB if number(sample.get('total_footprint')) else None,
        'resident_mib': sample['total_resident'] / MIB if number(sample.get('total_resident')) else None,
        'app_identities': sorted(filter(None, (identity(m) for m in sample.get('members', []) if m.get('kind') == 'app'))),
        'member_identities': sorted(filter(None, (identity(m) for m in sample.get('members', [])))),
        'helper_identities': sorted(filter(None, (identity(m) for m in sample.get('helper', [])))),
        'webkit_count': sum(m.get('kind', '').startswith('com.apple.WebKit.') for m in sample.get('members', [])),
        'webcontent_count': sum(m.get('kind') == 'com.apple.WebKit.WebContent' for m in sample.get('members', [])),
        'helper_count': len(sample.get('helper', [])),
    }


def resource_summary(samples):
    good = [s for s in samples if s.get('complete') is True
            and number(s.get('total_footprint')) and number(s.get('total_resident'))]
    def values(key):
        return [s[key] / MIB for s in good]
    def count_range(predicate):
        counts = [sum(predicate(m) for m in s.get('members', [])) for s in samples]
        return [min(counts), max(counts)] if counts else None
    categories = {}
    for category in ['app', 'webkit', 'helper']:
        totals = []
        counts = []
        for s in samples:
            rows = s.get('helper', []) if category == 'helper' else [m for m in s.get('members', []) if (m.get('kind') == 'app') == (category == 'app')]
            counts.append(len(rows))
            # An absent helper is a known empty cohort only with an explicit
            # helper census result; legacy captures do not make that promise.
            complete = s.get('helper_complete') if category == 'helper' else s.get('complete')
            if complete is True and all(not r.get('unread') and number(r.get('footprint')) and number(r.get('resident')) for r in rows):
                totals.append({k: sum(r[k] for r in rows) / MIB for k in ['footprint', 'resident']})
        categories[category] = {
            'count_range': [min(counts), max(counts)] if counts else None,
            'footprint_mib': distribution([s['footprint'] for s in totals]),
            'resident_mib': distribution([s['resident'] for s in totals]),
        }
    return {
        'samples': len(samples), 'complete_samples': len(good),
        'incomplete_samples': len(samples) - len(good),
        'unknown_candidate_samples': sum(bool(s.get('unknown_candidates')) for s in samples),
        'footprint_mib': distribution(values('total_footprint')),
        'resident_mib': distribution(values('total_resident')),
        'webkit_count_range': count_range(lambda m: m.get('kind', '').startswith('com.apple.WebKit.')),
        'webcontent_count_range': count_range(lambda m: m.get('kind') == 'com.apple.WebKit.WebContent'),
        'app_identities': sorted({i for s in samples for m in s.get('members', []) if m.get('kind') == 'app' and (i := identity(m))}),
        'member_identities': sorted({i for s in samples for m in s.get('members', []) if (i := identity(m))}),
        'helper_identities': sorted({i for s in samples for m in s.get('helper', []) if (i := identity(m))}),
        'categories': categories,
    }


def cpu_window(samples, start, end, clock):
    """Observed counter deltas, separated from unassigned first-seen lifetime CPU.

    The baseline read is the last at/before start; the endpoint is the last
    at/before end. This brackets the start imperfectly and misses CPU after the
    final observation of an exiting process. No negative delta is clamped away.
    """
    groups = {name: defaultdict(list) for name in ['app', 'webkit', 'helper']}
    flags = []
    if any(s.get('complete') is not True for s in samples if sample_bounds(s, clock)[0] is not None
           and sample_bounds(s, clock)[1] >= start and sample_bounds(s, clock)[0] <= end):
        flags.append({'kind': 'incomplete_inventory_or_attribution'})
    if any(s.get('helper_complete') is False for s in samples if sample_bounds(s, clock)[0] is not None
           and sample_bounds(s, clock)[1] >= start and sample_bounds(s, clock)[0] <= end):
        flags.append({'kind': 'unread_cpu_or_identity', 'category': 'helper', 'pid': None})
    pid_observations = defaultdict(list)
    for sample in samples:
        for collection in ['members', 'helper']:
            for row in sample.get(collection, []):
                category = 'helper' if collection == 'helper' else 'app' if row.get('kind') == 'app' else 'webkit'
                at = row_time(row, sample, clock)
                if not number(at) or at > end:
                    continue
                ident = identity(row)
                if not ident or row.get('unread') or not number(row.get('cpu_ns')):
                    if at >= start:
                        flags.append({'kind': 'unread_cpu_or_identity', 'category': category, 'pid': row.get('pid')})
                    continue
                groups[category][ident].append((at, row['cpu_ns']))
                pid_observations[row['pid']].append((at, ident))
    for pid, observations in pid_observations.items():
        before = sorted(p for p in observations if p[0] <= start)
        inside = [p for p in observations if start < p[0] <= end]
        identities = {p[1] for p in inside + before[-1:]} if inside else set()
        if len(identities) > 1:
            flags.append({'kind': 'pid_reuse', 'pid': pid, 'identities': sorted(identities)})
    result = {}
    for category, lifetimes in groups.items():
        total, initial = 0, 0
        births, absent, resets = [], [], []
        used = []
        for ident, observations in lifetimes.items():
            observations.sort()
            before = [p for p in observations if p[0] <= start]
            inside = [p for p in observations if start < p[0] <= end]
            if not inside:
                # A member present at the boundary can disappear before its
                # next counter read. Its final CPU remains unknown, not zero.
                boundary = [s for s in samples if sample_bounds(s, clock)[1] <= start]
                after = [s for s in samples if sample_bounds(s, clock)[1] > start and sample_bounds(s, clock)[1] <= end]
                if before and boundary and after:
                    rows = boundary[-1].get('helper' if category == 'helper' else 'members', [])
                    last_rows = after[-1].get('helper' if category == 'helper' else 'members', [])
                    if any(identity(m) == ident for m in rows) and not any(identity(m) == ident for m in last_rows):
                        absent.append(ident)
                continue
            points = ([before[-1]] if before else []) + inside
            used.append(ident)
            if not before:
                births.append(ident)
                initial += points[0][1]
            for a, b in zip(points, points[1:]):
                if b[1] < a[1]:
                    resets.append({'identity': ident, 'at': b[0], 'before_ns': a[1], 'after_ns': b[1]})
                else:
                    total += b[1] - a[1]
            # Absence is not proof of exit: a process could be unread or not in
            # the sampled attribution cohort. Keep that uncertainty explicit.
            later = [s for s in samples if sample_bounds(s, clock)[0] is not None
                     and sample_bounds(s, clock)[0] > points[-1][0]
                     and sample_bounds(s, clock)[1] <= end]
            if later:
                last = later[-1]
                rows = last.get('helper' if category == 'helper' else 'members', [])
                if not any(identity(m) == ident for m in rows):
                    absent.append(ident)
        category_unknown = any(f.get('category') == category for f in flags)
        result[category] = {
            'observed_cpu_ms': None if resets or category_unknown else total / 1e6,
            'valid_segment_cpu_ms': total / 1e6,
            'unassigned_first_seen_lifetime_cpu_ms': initial / 1e6,
            'birth_or_first_observation': births, 'exit_or_absent_before_end': absent,
            'counter_resets': resets, 'identities': sorted(used),
        }
        flags.extend({'kind': 'counter_reset', 'category': category, **r} for r in resets)
    app_cpu, webkit_cpu = result['app']['observed_cpu_ms'], result['webkit']['observed_cpu_ms']
    return {'categories': result, 'flags': flags,
            'aggregate_observed_cpu_ms': app_cpu + webkit_cpu if app_cpu is not None and webkit_cpu is not None else None,
            'approximate': True,
            'limitations': ['Sequential read boundaries differ from request boundaries.',
                            'First-seen lifetime CPU is not assigned to this step; births can predate attribution.',
                            'Exited/absent processes can lose their unobserved final CPU.']}


def gate_ok(event):
    if not event:
        return None
    if event.get('ok') is False or event.get('status') in {'fail', 'failed', 'error', 'recovered', 'aborted'}:
        return False
    if event.get('ok') is True or event.get('status') in {'pass', 'success', 'settled', 'expected_fault'}:
        return True
    return None


def report(events, samples, tail_seconds=2):
    warnings = []
    events = list(events)
    samples = list(samples)
    time_events = [e for e in events if e.get('event') in {'request', 'settled', 'idle_begin', 'idle_end'}]
    clock = ('mono' if time_events and all(number(e.get('mono')) for e in time_events)
             and samples and all(number(s.get('sample_end_mono')) and number(s.get('sample_start_mono')) for s in samples)
             else 'wall')
    if clock == 'wall':
        warnings.append('Wall-clock fallback: no common complete monotonic timeline; clock adjustments/read skew are unresolved.')
    invalid_samples = [s for s in samples if sample_bounds(s, clock)[0] is None]
    if invalid_samples:
        warnings.append(f'{len(invalid_samples)} samples have invalid/missing time boundaries and were excluded.')
    samples = sorted((s for s in samples if sample_bounds(s, clock)[0] is not None), key=lambda s: sample_bounds(s, clock)[1])
    events = sorted((e for e in time_events if event_time(e, clock) is not None), key=lambda e: event_time(e, clock))
    if len(events) != len(time_events):
        warnings.append('Events with invalid/missing selected-clock timestamps were excluded.')
    requests = [e for e in events if e['event'] == 'request']
    seen_indices = set()
    steps = []
    for position, request in enumerate(requests):
        index = request.get('index')
        start = event_time(request, clock)
        next_start = event_time(requests[position + 1], clock) if position + 1 < len(requests) else math.inf
        settled = [e for e in events if e['event'] == 'settled' and e.get('index') == index
                   and start <= event_time(e, clock) < next_start]
        done = settled[0] if settled else None
        end = event_time(done, clock) if done else max(start, min(next_start, sample_bounds(samples[-1], clock)[1] if samples else start))
        flags = []
        valid_index = isinstance(index, int) and not isinstance(index, bool)
        if not valid_index or index in seen_indices:
            flags.append('duplicate_or_invalid_index')
        if valid_index:
            seen_indices.add(index)
        if len(settled) > 1:
            flags.append('duplicate_settled_events')
        if done and any(done.get(k) != request.get(k) for k in ['phase', 'mode']):
            flags.append('settled_context_mismatch')
        if not done:
            flags.append('no_settled_event')
        ok = gate_ok(done)
        if done and ok is None:
            flags.append('settled_success_unverified')
        during = [s for s in samples if sample_bounds(s, clock)[0] >= start and sample_bounds(s, clock)[1] <= end]
        before = [s for s in samples if sample_bounds(s, clock)[1] <= start]
        # Never borrow a later fault/close request's memory for a normal tail.
        tail = [s for s in samples if sample_bounds(s, clock)[0] >= end
                and sample_bounds(s, clock)[1] < next_start and sample_bounds(s, clock)[1] <= end + tail_seconds] if done else []
        resources = resource_summary(during)
        if resources['incomplete_samples'] or not during:
            flags.append('incomplete_resource_window')
        own = set(resources['app_identities']) | set(snapshot(before[-1])['app_identities'] if before else [])
        if len(own) != 1:
            flags.append('app_identity_not_stable')
        cpu = cpu_window(samples, start, end, clock)
        if any(f['kind'] in {'pid_reuse', 'counter_reset', 'unread_cpu_or_identity'} for f in cpu['flags']):
            flags.append('cpu_identity_or_counter_problem')
        eligible = request.get('phase') == 'matched' and request.get('mode') in MODES and ok is True and not flags
        previous = snapshot(before[-1]) if before else None
        delta = {}
        for field in ['footprint_mib', 'resident_mib']:
            peak = resources[field]['max']
            delta[field] = peak - previous[field] if peak is not None and previous and previous[field] is not None else None
        steps.append({
            'index': index, 'phase': request.get('phase'), 'mode': request.get('mode'),
            'request_at_ms': request.get('at'), 'request_mono': request.get('mono'),
            'window_start': start, 'window_end': end,
            'settled_at_ms': done.get('at') if done else None, 'settled_mono': done.get('mono') if done else None,
            'duration_ms': (end - start) * 1000 if done else None,
            'gate_ok': ok, 'flags': flags, 'normal_matched_eligible': eligible,
            'before': previous, 'sampled_peak_minus_before_mib': delta,
            'during': resources, 'tail': resource_summary(tail), 'tail_last': snapshot(tail[-1]) if tail else None,
            'cpu': cpu, 'summary': done.get('summary') if done else None,
        })
    idle = []
    for begin in [e for e in events if e['event'] == 'idle_begin']:
        start = event_time(begin, clock)
        ends = [e for e in events if e['event'] == 'idle_end' and e.get('index') == begin.get('index')
                and e.get('phase') == begin.get('phase') and event_time(e, clock) >= start]
        done = ends[0] if ends else None
        if not done:
            idle.append({'phase': begin.get('phase'), 'index': begin.get('index'), 'flags': ['no_idle_end']})
            continue
        end = event_time(done, clock)
        inside = [s for s in samples if sample_bounds(s, clock)[0] >= start and sample_bounds(s, clock)[1] <= end]
        idle.append({'phase': begin.get('phase'), 'index': begin.get('index'),
                     'duration_ms': (end - start) * 1000, 'resources': resource_summary(inside),
                     'first': snapshot(inside[0]) if inside else None, 'last': snapshot(inside[-1]) if inside else None,
                     'cpu': cpu_window(samples, start, end, clock),
                     'overlapping_request_indices': [s['index'] for s in steps if s['window_start'] < end and s['window_end'] > start]})
    matched = {}
    for mode in MODES:
        eligible = [s for s in steps if s['normal_matched_eligible'] and s['mode'] == mode]
        attempted = [s for s in steps if s['phase'] == 'matched' and s['mode'] == mode]
        matched[mode] = {
            'attempted': len(attempted), 'eligible': len(eligible),
            'gate_successes': sum(s['gate_ok'] is True for s in attempted),
            'duration_ms': distribution([s['duration_ms'] for s in eligible]),
            'sampled_peak_footprint_mib': distribution([s['during']['footprint_mib']['max'] for s in eligible]),
            'sampled_peak_resident_mib': distribution([s['during']['resident_mib']['max'] for s in eligible]),
        }
    if not all(matched[m]['eligible'] for m in MODES):
        warnings.append('Both normal matched modes are not represented by eligible measured steps; no matched comparison is available.')
    metadata_rows = {json.dumps(s.get('metadata', {}), sort_keys=True) for s in samples}
    app_ids = sorted({i for s in samples for m in s.get('members', []) if m.get('kind') == 'app' and (i := identity(m))})
    if len(app_ids) != 1:
        warnings.append('Capture does not have one stable app PID/start identity; same-process comparison is not established.')
    return {
        'schema_version': 1, 'clock': clock, 'performance_grade': 'not_assigned',
        'matched_data_available': all(matched[m]['eligible'] for m in MODES) and len(app_ids) == 1,
        'warnings': warnings, 'metadata': [json.loads(m) for m in sorted(metadata_rows)],
        'app_identities': app_ids, 'matched': matched,
        'phase_counts': {phase: sum(s['phase'] == phase for s in steps) for phase in sorted({str(s['phase']) for s in steps})},
        'steps': steps, 'idle': idle,
        'limitations': ['Descriptive p95 uses nearest rank; small samples do not establish a performance promise.',
                        'Peaks and process births/exits may fall between samples.',
                        'Summed resident bytes are not unique physical RAM; Safari/WindowServer are excluded.',
                        'Fault, close, warmup and repeated phases do not enter normal matched summaries.'],
    }


def read_jsonl(path):
    rows = []
    for line_number, line in enumerate(Path(path).read_text().splitlines(), 1):
        if line.strip():
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f'{path}:{line_number}: expected a JSON object')
            rows.append(value)
    return rows


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', required=True)
    parser.add_argument('--samples', required=True)
    parser.add_argument('--tail-seconds', type=float, default=2)
    args = parser.parse_args()
    if not math.isfinite(args.tail_seconds) or args.tail_seconds < 0:
        parser.error('--tail-seconds must be finite and nonnegative')
    try:
        result = report(read_jsonl(args.events), read_jsonl(args.samples), args.tail_seconds)
    except (OSError, ValueError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2, allow_nan=False))
