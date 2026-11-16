"""Offline inventory, not a complete call graph or an absence proof.

Inputs: matching dyld_info AppKit disassembly and native-strings --all-constants
JSONL from 25G342. Labels nearby ADRP/ADD constant materializations only. Other
branches may supply different keys to the same call; this is not SSA analysis.
Never launches an app, writes preferences or invokes a private API.
"""
import hashlib
import json
import pathlib
import re
import sys

dump, constants, output = map(pathlib.Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=False)
with constants.open() as stream:
    values = {int(row['unslidAddress'], 16): row['value'] for row in map(json.loads, stream)}
family = re.compile(r'\[(?:NSWindow|NSFrameView|NSThemeFrame|NSTitlebar\w*|_?NSThemeWidget\w*)(?:\([^)]*\))? ')
config = re.compile(r'\b(?:bl|b)\s+__NSGet\w*AppConfig\b')
selected = {
    '-[NSThemeFrame _updateButtons]', '-[NSThemeFrame _wantsLeftHandButtons]',
    '-[NSThemeFrame newCloseButton]', '-[NSThemeFrame newMiniaturizeButton]',
    '-[NSThemeFrame newZoomButton]', '-[NSThemeFrame _updateButtonState]',
    '-[NSThemeFrame _updateButtonPositions]', '-[NSThemeFrame setButtonRevealAmount:]',
    '-[NSThemeFrame _canFloatForTabsOrTitlebar:]',
    '-[NSWindow standardWindowButton:]', '-[NSWindow _findStandardWindowButton:]',
    '-[NSWindow setStandardWindowTitleButtonsAlphaValue:]',
    '-[NSWindow setTitlebarHidden:]', '-[NSThemeFrame setTitlebarHidden:]',
    '-[NSWindow(NSFullScreen) _didExitFullScreen]',
    '-[NSWindow(NSWindow_Theme) _updateButtonsForModeChanged]',
    '_NSAccessibilitySetAttributeValue',
    '-[NSWindow(NSWindowAccessibility) accessibilityIsCloseButtonAttributeSettable]',
    '-[NSWindow(NSWindowAccessibility) accessibilityIsMinimizeButtonAttributeSettable]',
    '-[NSWindow(NSWindowAccessibility) accessibilityIsZoomButtonAttributeSettable]',
    '-[NSResponder setAccessibilityCloseButton:]',
    '-[NSResponder setAccessibilityMinimizeButton:]',
    '-[NSResponder setAccessibilityZoomButton:]',
    '-[NSObject(NSAccessibilityOverridingAttributes) accessibilitySetOverrideValue:forAttribute:]'
}
inventory, lifecycle, excerpts = [], [], []
method_count = 0


def process(name, lines):
    global method_count
    included = bool(family.search(name))
    if included:
        method_count += 1
    reads = []
    for index, line in enumerate(lines):
        if not included or not config.search(line):
            continue
        # Only a directly materialized x0 is resolved. Branch/dataflow analysis is
        # deliberately excluded; unresolved reads keep their instruction context.
        address = None
        for previous in lines[max(0, index - 16):index]:
            page = re.search(r'adrp\s+x0,.*; (0x[0-9a-f]+)', previous)
            add = re.search(r'add\s+x0, x0, #(0x[0-9a-f]+|\d+)', previous)
            if page:
                address = int(page[1], 16)
            elif add and address is not None:
                address += int(add[1], 0)
            elif re.search(r'\b(?:bl|blr)\s|\b[a-z][a-z0-9.]*\s+x0\s*,', previous):
                address = None
        reads.append({'instruction': line.strip(), 'adjacent_literal_key': values.get(address),
                      'constant_address': hex(address) if address in values else None,
                      'context': [entry.rstrip() for entry in lines[max(0, index - 12):index + 1]]})
    if reads:
        inventory.append({'method': name, 'reads': reads})
    if name in selected:
        excerpts.append(name + ':\n' + ''.join(line.rstrip() + '\n' for line in lines))
        lifecycle.append({'method': name, 'direct_app_config_reads': len(reads),
                          'calls': [line.strip() for line in lines
                                    if re.search(r'\b(?:bl|b)\s+(?!0x)', line)]})


name, body = '', []
with dump.open() as stream:
    for line in stream:
        if line.endswith(':\n') and not line.startswith('0x'):
            process(name, body)
            name, body = line.rstrip()[:-1], []
        else:
            body.append(line)
process(name, body)
assert selected == {row['method'] for row in lifecycle}, 'required excerpt missing'
reads = [read for row in inventory for read in row['reads']]
summary = {
    'scope': 'direct AppConfig calls in selected Objective-C window/frame/titlebar/widget families and blocks; excludes dynamic dispatch closure, other frameworks and indirect constants',
    'build': '25G342', 'constant_count': len(values), 'methods_in_scope': method_count,
    'methods_with_direct_reads': len(inventory), 'direct_read_count': len(reads),
    'reads_with_adjacent_literal': sum(read['adjacent_literal_key'] is not None for read in reads),
    'adjacent_literal_keys': sorted({read['adjacent_literal_key'] for read in reads if read['adjacent_literal_key']}),
    'sources': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in [dump, constants]}
}
(output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
(output / 'config-reads.json').write_text(json.dumps(inventory, indent=2) + '\n')
(output / 'lifecycle-calls.json').write_text(json.dumps(lifecycle, indent=2) + '\n')
(output / 'static.txt').write_text('\n'.join(excerpts))
print(json.dumps({key: summary[key] for key in ['methods_in_scope', 'direct_read_count', 'reads_with_adjacent_literal']}))
