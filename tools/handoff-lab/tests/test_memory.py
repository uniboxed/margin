"""Synthetic accounting regressions: no native calls, processes or windows."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


memory = module('memory')
reporter = module('memory_report')
M = 1024 * 1024


def row(pid=1, started=10, kind='app', cpu=0, mono=0):
    return dict(pid=pid, started=started, kind=kind, cpu_ns=cpu, footprint=100 * M,
                resident=50 * M, read_mono=mono, read_at=1000 + mono)


def sample(mono, members=None, fp=100, complete=True, helper=None):
    members = [row(cpu=int(mono * 1e6), mono=mono)] if members is None else members
    return dict(schema_version=2, at=1000 + mono,
                sample_start_at=1000 + mono, sample_end_at=1000 + mono,
                sample_start_mono=mono, sample_end_mono=mono, complete=complete,
                helper_complete=True,
                total_footprint=fp * M if complete else None,
                total_resident=fp * M / 2 if complete else None,
                members=members, helper=helper or [])


def event(kind, index, phase, mode, mono, **extra):
    return dict(event=kind, index=index, phase=phase, mode=mode,
                mono=mono, at=(1000 + mono) * 1000, **extra)


class SamplerTests(unittest.TestCase):
    def test_raw_mach_stamp_has_boot_origin_and_uses_host_timebase(self):
        n = memory.Native.__new__(memory.Native)
        n.timebase = {'numer': 125, 'denom': 3}
        n.absolute_ticks = lambda: 48000000
        self.assertEqual(n.monotonic(), 2)

    def test_native_clock_metadata_states_its_origin(self):
        meta = memory.metadata({'numer': 125, 'denom': 3})
        self.assertEqual(meta['monotonic_origin'], 'boot')
        self.assertEqual(meta['monotonic_clock'], 'raw mach_absolute_time()')

    def collect(self, processes=None, coal=None, usage=None, path=None):
        tick = iter(range(100))
        def clock():
            t = next(tick) / 100
            return {'at': 1000 + t, 'mono': t}
        return memory.collect(
            processes or (lambda: [(1, memory.APP)]),
            coal or (lambda pid: (10, 11)),
            usage or (lambda pid: dict(started=pid * 10, footprint=100, resident=50,
                                      cpu_ns=200, user=4, system=1)),
            clock=clock, meta={'timebase': {'numer': 125, 'denom': 3}},
            path_read=path or (lambda pid: memory.HELPER if pid == 4 else '/other/Margin.app/Contents/Helpers/margin-helper'))

    def test_inventory_failure_is_not_an_empty_success(self):
        def failed():
            raise OSError('synthetic')
        s = self.collect(processes=failed)
        self.assertFalse(s['complete'])
        self.assertFalse(s['inventory_ok'])
        self.assertIsNone(s['total_footprint'])
        self.assertGreater(s['sample_end_mono'], s['sample_start_mono'])

    def test_unknown_webkit_candidate_invalidates_census(self):
        s = self.collect(processes=lambda: [(1, memory.APP), (2, '/x/com.apple.WebKit.WebContent')],
                         coal=lambda pid: (10, 11) if pid == 1 else None)
        self.assertFalse(s['complete'])
        self.assertFalse(s['census_complete'])
        self.assertEqual(s['observed_footprint'], 100)
        self.assertIsNone(s['total_footprint'])
        self.assertEqual(s['unknown_candidates'][0]['pid'], 2)

    def test_unrelated_webkit_and_wrong_install_helper_are_excluded(self):
        s = self.collect(processes=lambda: [(1, memory.APP), (2, '/x/com.apple.WebKit.GPU'),
                                            (3, '/other/Margin.app/Contents/Helpers/margin-helper'),
                                            (4, memory.HELPER)],
                         coal=lambda pid: (20, 21) if pid == 2 else (10, 11))
        self.assertTrue(s['complete'])
        self.assertEqual(s['unrelated_webkit_count'], 1)
        self.assertEqual([r['pid'] for r in s['helper']], [4])
        self.assertEqual(s['helper'][0]['identity'], {'pid': 4, 'started': 40})
        self.assertGreater(s['members'][0]['read_mono'], s['members'][0]['read_start_mono'])
        self.assertEqual(s['metadata']['timebase'], {'numer': 125, 'denom': 3})

    def test_unread_member_or_changing_association_is_explicit(self):
        s = self.collect(usage=lambda pid: None)
        self.assertFalse(s['complete'])
        self.assertTrue(s['members'][0]['unread'])
        calls = iter([(10, 11), (10, 11), None])
        s = self.collect(coal=lambda pid: next(calls))
        self.assertFalse(s['complete'])
        self.assertIn('coalition changed', s['members'][0]['identity_error'])

    def test_relative_helper_argv0_is_verified_by_executable_not_comm(self):
        paths = {4: memory.HELPER, 5: '/other/Margin.app/Contents/Helpers/margin-helper', 6: None}
        s = self.collect(processes=lambda: [(1, memory.APP), (4, 'Contents/Helpers/margin-helper'),
                                            (5, 'Contents/Helpers/margin-helper'), (6, 'margin-helper')],
                         path=paths.get)
        self.assertTrue(s['complete'], 'unknown helper is separate from app/WebKit coverage')
        self.assertFalse(s['helper_complete'])
        self.assertEqual(s['helper_candidate_count'], 3)
        self.assertEqual(s['unrelated_helper_count'], 1)
        self.assertEqual([r['pid'] for r in s['helper']], [4])
        self.assertEqual(s['unknown_helper_candidates'][0]['pid'], 6)

    def test_helper_path_change_after_rusage_is_incomplete(self):
        paths = iter([memory.HELPER, None])
        s = self.collect(processes=lambda: [(1, memory.APP), (4, 'Contents/Helpers/margin-helper')],
                         path=lambda pid: next(paths))
        self.assertTrue(s['complete'])
        self.assertFalse(s['helper_complete'])
        self.assertTrue(s['helper'][0]['unread'])


class ReportTests(unittest.TestCase):
    CONTROL = ('handoff: safari:A#1 → safari:B#2 (park+freeze, parked target), '
               'frozen 1685 ms (result 0), request to reveal 1763 ms: shown 11, '
               'B steady 1584, A asked 1726, overlay framed 1721, A normal 1814, '
               'A parked 1871, settled 1721; focus ok; '
               'late (watchdog at 1685 ms, waiting for A not started); dev hook: cover off')
    COVERED = ('handoff: safari:B#2 → safari:A#1 (park, parked target), live cover 1500 ms (no freeze), '
               'request to reveal 1550 ms: B steady 1300, A parked 1500, settled 1400; focus ok')

    def prospective(self):
        protocol = reporter.MATCHED_PROTOCOL
        events = [dict(event='validation_begin', protocol=protocol, gate='MATCHED', prior_requests_consumed=0)]
        for i, (mode, summary) in enumerate([('freeze', self.CONTROL), ('live', self.COVERED)], 1):
            evidence = reporter.comparison_summary(summary, mode)
            events += [event('request', i, 'matched', mode, i * 3 - 2.5,
                             protocol=protocol, old='park', source=i,
                             source_profile='Test A' if i == 1 else 'Test B',
                             target_profile='Test B' if i == 1 else 'Test A'),
                       event('settled', i, 'matched', mode, i * 3 - .5,
                             protocol=protocol, ok=True, status='pass', source=i, destination=3 - i,
                             summary=summary, final_verified=True, cleanup_verified=True,
                             mechanism_verified=True, capabilities_preserved=True, topology_verified=True,
                             final_verified_ms=2000, degraded_control=mode == 'freeze', **evidence)]
        return events

    def test_prospective_degraded_control_keeps_reveal_hazard_separate_from_completion(self):
        r = reporter.report(self.prospective(), [sample(t) for t in range(8)])
        self.assertTrue(r['prospective_protocol_established'])
        self.assertTrue(r['matched_data_available'])
        control = r['matched']['freeze']
        self.assertEqual(control['eligible'], 1)
        self.assertEqual(control['degraded_controls'], 1)
        self.assertEqual(control['on_time_controls'], 0)
        self.assertEqual(control['early_reveal_hazards_observed'], 1)
        self.assertEqual(control['request_to_reveal_ms']['p50'], 1763)
        self.assertEqual(control['independently_verified_completion_ms']['p50'], 2000)
        self.assertEqual(control['on_time_verified_completion_ms']['count'], 0)
        self.assertEqual(r['matched']['live']['degraded_controls'], 0)
        self.assertEqual(r['performance_grade'], 'not_assigned')

    def test_prospective_flags_without_actual_mechanism_never_establish_control(self):
        for bad in ['', 'frozen 1685 ms (result 0)', self.COVERED,
                    self.CONTROL.replace('result 0', 'result 1'),
                    self.CONTROL.replace('waiting for A not started', 'waiting for B'),
                    self.CONTROL.replace('focus ok', 'focus failed'),
                    self.CONTROL.replace('focus ok', 'focus okay'),
                    self.CONTROL.replace('(result 0)', '(result 1), close frozen 1 ms (result 0)'),
                    self.CONTROL.replace('(park+freeze, parked target)', '(park, parked target)'),
                    self.CONTROL.replace('; focus ok;', '; late (watchdog at 1 ms, waiting for B); focus ok;'),
                    self.CONTROL + '; recovered: error', self.CONTROL + '; aborted']:
            with self.subTest(summary=bad):
                events = self.prospective(); events[2]['summary'] = bad
                r = reporter.report(events, [sample(t) for t in range(8)])
                self.assertEqual(r['matched']['freeze']['eligible'], 0)

    def test_prospective_requires_fresh_protocol_and_all_native_verification(self):
        mutations = [lambda es: es.pop(0),
                     lambda es: es[0].update(prior_requests_consumed=4),
                     lambda es: es[0].update(gate='VALIDATE'),
                     lambda es: es[1].pop('protocol'),
                     lambda es: es[2].update(protocol='legacy'),
                     lambda es: es[2].update(ok=False, status='fail'),
                     lambda es: es[2].update(destination=1),
                     lambda es: es[2].update(request_to_reveal_ms=10),
                     lambda es: es[2].update(final_verified_ms=1700)]
        for key in ['final_verified', 'cleanup_verified', 'mechanism_verified', 'capabilities_preserved', 'topology_verified']:
            mutations.append(lambda es, key=key: es[2].update({key: False}))
        for mutation in mutations:
            events = self.prospective(); mutation(events)
            self.assertEqual(reporter.report(events, [sample(t) for t in range(8)])['matched']['freeze']['eligible'], 0)

    def test_legacy_failed_control_stays_failed_even_with_v2_looking_summary(self):
        for ok in [False, True]:
            events = [event('request', 1, 'matched', 'freeze', .5),
                      event('settled', 1, 'matched', 'freeze', 2.5, ok=ok, summary=self.CONTROL)]
            r = reporter.report(events, [sample(t) for t in range(4)])
            self.assertEqual(r['matched']['freeze']['eligible'], 0)
            self.assertEqual(r['steps'][0]['gate_ok'], ok)
            self.assertTrue(r['steps'][0]['early_reveal_hazard'])

    def test_prospective_live_late_or_recovery_cannot_be_a_degraded_control(self):
        for suffix in ['; late (watchdog at 1700 ms, waiting for A not started); dev hook: cover off', '; recovered: failure']:
            events = self.prospective(); events[4]['summary'] += suffix
            events[4].update(degraded_control=True, transition='degraded_freeze', early_reveal_hazard=True)
            self.assertEqual(reporter.report(events, [sample(t) for t in range(8)])['matched']['live']['eligible'], 0)

    def test_prospective_degraded_warmup_does_not_enter_matched_stats(self):
        events = self.prospective()
        events[1]['phase'] = events[2]['phase'] = 'warmup'
        r = reporter.report(events, [sample(t) for t in range(8)])
        self.assertTrue(r['steps'][0]['early_reveal_hazard'])
        self.assertEqual(r['matched']['freeze']['attempted'], 0)
        self.assertFalse(r['matched_data_available'])

    def test_matched_only_statistics_exclude_warmup_repeated_fault_close(self):
        events = []
        for i, (phase, mode) in enumerate([('warmup', 'live'), ('matched', 'freeze'),
                                          ('matched', 'live'), ('repeated', 'live'),
                                          ('fault', 'live'), ('close', 'live')]):
            events += [event('request', i, phase, mode, i * 3 + .5),
                       event('settled', i, phase, mode, i * 3 + 1.5, ok=True)]
        samples = [sample(t) for t in range(20)]
        r = reporter.report(events, samples)
        self.assertTrue(r['matched_data_available'])
        self.assertEqual(r['matched']['freeze']['eligible'], 1)
        self.assertEqual(r['matched']['live']['eligible'], 1)
        self.assertEqual(r['matched']['live']['duration_ms']['p50'], 1000)
        self.assertEqual(r['phase_counts']['repeated'], 1)
        self.assertEqual(r['performance_grade'], 'not_assigned')

    def test_next_fault_cannot_supply_normal_tail(self):
        events = [event('request', 1, 'matched', 'live', 1),
                  event('settled', 1, 'matched', 'live', 2, ok=True),
                  event('request', 2, 'fault', 'live', 3),
                  event('settled', 2, 'fault', 'live', 5, ok=False)]
        samples = [sample(t, fp=999 if t >= 3 else 100) for t in [0, 1, 2, 2.5, 3, 4, 5, 6]]
        r = reporter.report(events, samples)
        self.assertEqual(r['steps'][0]['tail']['footprint_mib']['max'], 100)
        self.assertEqual(r['steps'][0]['tail_last']['mono'], 2.5)
        self.assertFalse(r['steps'][1]['normal_matched_eligible'])

    def test_pid_reuse_is_separate_identity_and_invalidates_matching(self):
        events = [event('request', 1, 'matched', 'live', .5),
                  event('settled', 1, 'matched', 'live', 2.5, ok=True)]
        samples = [sample(0, [row(cpu=100, mono=0)]),
                   sample(1, [row(started=20, cpu=20, mono=1)]),
                   sample(2, [row(started=20, cpu=40, mono=2)])]
        s = reporter.report(events, samples)['steps'][0]
        self.assertIn('app_identity_not_stable', s['flags'])
        self.assertTrue(any(f['kind'] == 'pid_reuse' for f in s['cpu']['flags']))
        self.assertFalse(s['normal_matched_eligible'])
        self.assertEqual(s['cpu']['categories']['app']['valid_segment_cpu_ms'], 20 / 1e6)

    def test_counter_reset_never_becomes_zero_cpu_success(self):
        samples = [sample(i, [row(cpu=c, mono=i)]) for i, c in enumerate([100, 200, 50, 80])]
        cpu = reporter.cpu_window(samples, .5, 3, 'mono')
        self.assertIsNone(cpu['categories']['app']['observed_cpu_ms'])
        self.assertEqual(len(cpu['categories']['app']['counter_resets']), 1)
        self.assertTrue(any(f['kind'] == 'counter_reset' for f in cpu['flags']))

    def test_unattributed_helper_is_unknown_cpu_not_zero(self):
        samples = [sample(0), sample(1), sample(2)]
        samples[1]['helper_complete'] = False
        samples[1]['unknown_helper_candidates'] = [{'pid': 8, 'reason': 'executable unread'}]
        cpu = reporter.cpu_window(samples, .5, 2, 'mono')
        self.assertIsNone(cpu['categories']['helper']['observed_cpu_ms'])
        self.assertIsNotNone(cpu['categories']['app']['observed_cpu_ms'])

    def test_birth_and_absence_do_not_claim_unobserved_final_cpu(self):
        samples = [sample(0), sample(1, [row(cpu=1e6, mono=1), row(2, 20, 'com.apple.WebKit.WebContent', 9e6, 1)]),
                   sample(2, [row(cpu=2e6, mono=2), row(2, 20, 'com.apple.WebKit.WebContent', 12e6, 2)]), sample(3)]
        cpu = reporter.cpu_window(samples, .5, 3, 'mono')['categories']['webkit']
        self.assertEqual(cpu['observed_cpu_ms'], 3)
        self.assertEqual(cpu['unassigned_first_seen_lifetime_cpu_ms'], 9)
        self.assertEqual(cpu['birth_or_first_observation'], ['2:20'])
        self.assertEqual(cpu['exit_or_absent_before_end'], ['2:20'])

    def test_failed_or_unverified_settlement_is_not_matched_success(self):
        for done in [dict(ok=False), dict()]:
            events = [event('request', 1, 'matched', 'live', 1),
                      event('settled', 1, 'matched', 'live', 2, **done)]
            r = reporter.report(events, [sample(t) for t in range(4)])
            self.assertEqual(r['matched']['live']['eligible'], 0)
            self.assertFalse(r['matched_data_available'])

    def test_idle_uses_its_own_interval_and_reports_overlapping_requests(self):
        events = [event('idle_begin', -1, 'post_idle', 'live', 3),
                  event('idle_end', -1, 'post_idle', 'live', 6),
                  event('request', 1, 'fault', 'live', 4),
                  event('settled', 1, 'fault', 'live', 5, ok=False)]
        r = reporter.report(events, [sample(t, fp=t * 10) for t in range(8)])
        self.assertEqual(r['idle'][0]['resources']['footprint_mib']['p50'], 45)
        self.assertEqual(r['idle'][0]['overlapping_request_indices'], [1])

    def test_legacy_samples_require_explicit_wall_clock_fallback(self):
        events = [event('request', 1, 'matched', 'freeze', 1),
                  event('settled', 1, 'matched', 'freeze', 2, ok=True)]
        samples = [sample(t) for t in range(4)]
        for s in samples:
            del s['sample_start_mono']; del s['sample_end_mono']
        r = reporter.report(events, samples)
        self.assertEqual(r['clock'], 'wall')
        self.assertTrue(any('Wall-clock fallback' in w for w in r['warnings']))

    def test_partial_inventory_is_preserved_and_excluded_from_eligible_stats(self):
        events = [event('request', 1, 'matched', 'live', .5),
                  event('settled', 1, 'matched', 'live', 2.5, ok=True)]
        samples = [sample(0), sample(1, complete=False), sample(2)]
        samples[1]['unknown_candidates'] = [{'pid': 8, 'reason': 'unread'}]
        s = reporter.report(events, samples)['steps'][0]
        self.assertEqual(s['during']['incomplete_samples'], 1)
        self.assertEqual(s['during']['unknown_candidate_samples'], 1)
        self.assertFalse(s['normal_matched_eligible'])
        self.assertTrue(any(f['kind'] == 'incomplete_inventory_or_attribution' for f in s['cpu']['flags']))

    def test_sequential_read_spans_are_not_mistaken_for_inside_phase_peaks(self):
        events = [event('request', 1, 'matched', 'live', 1),
                  event('settled', 1, 'matched', 'live', 2, ok=True)]
        samples = [sample(0), sample(1.5, fp=200), sample(2.5, fp=999)]
        samples[2]['sample_start_mono'] = 1.9
        s = reporter.report(events, samples)['steps'][0]
        self.assertEqual(s['during']['footprint_mib']['max'], 200)
        self.assertEqual(s['sampled_peak_minus_before_mib']['footprint_mib'], 100)

    def test_process_relative_monotonic_origins_use_preserved_wall_times(self):
        events = [event('request', 1, 'repeated', 'live', .5),
                  event('settled', 1, 'repeated', 'live', 2.5, ok=True)]
        samples = [sample(t) for t in range(4)]
        for s in samples:
            s['sample_start_mono'] += 10000
            s['sample_end_mono'] += 10000
        r = reporter.report(events, samples)
        self.assertEqual(r['clock'], 'wall')
        self.assertEqual(r['steps'][0]['during']['samples'], 2)
        self.assertEqual(r['steps'][0]['cpu']['categories']['app']['observed_cpu_ms'], 2)
        self.assertTrue(any('origins differ' in w for w in r['warnings']))

    def test_clock_offset_jumps_cannot_enter_matched_statistics(self):
        events = [event('request', 1, 'matched', 'live', .5),
                  event('settled', 1, 'matched', 'live', 2.5, ok=True)]
        samples = [sample(t) for t in range(4)]
        for s in samples:
            s['sample_start_mono'] += 10000
            s['sample_end_mono'] += 10000
        samples[-1]['sample_end_at'] += 2
        r = reporter.report(events, samples)
        self.assertFalse(r['steps'][0]['normal_matched_eligible'])
        self.assertIn('unstable_clock_alignment', r['steps'][0]['flags'])

    def test_cli_outputs_json_and_sampler_help_never_loads_native(self):
        subprocess.run([sys.executable, str(ROOT / 'memory.py'), '--help'], check=True, capture_output=True)
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            events = [event('request', 1, 'matched', 'live', .5),
                      event('settled', 1, 'matched', 'live', 1.5, ok=True)]
            for name, values in [('events', events), ('samples', [sample(t) for t in range(3)])]:
                (base / name).write_text(''.join(json.dumps(v) + '\n' for v in values))
            result = subprocess.run([sys.executable, str(ROOT / 'memory_report.py'),
                                     '--events', str(base / 'events'), '--samples', str(base / 'samples')],
                                    check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(result.stdout)['performance_grade'], 'not_assigned')


if __name__ == '__main__':
    unittest.main()
