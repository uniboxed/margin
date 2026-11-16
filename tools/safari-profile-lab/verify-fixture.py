"""Independently verify an owned fixture; never inspect a real Safari store."""
import argparse
import json
import pathlib
import plistlib
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument('run', type=pathlib.Path)
args = parser.parse_args()
run = args.run.resolve(strict=True)
assert '/test-results/safari-profiles-' in str(run)
allowed = run / 'allowed'
assert (allowed / '.margin-profile-fixture').read_text() == 'margin-safari-profile-lab 25G342\n'
summary = json.loads((run / 'result.json').read_text())
assert summary['exit'] == 0 and summary['canaryUnchanged']
events = [json.loads(line) for line in (allowed / 'probe.jsonl').read_text().splitlines()]
assert events[-1]['complete'] and events[-1]['realSafariProfileCreated'] is False
guard = next(row for row in events if 'canaryReadWriteDenied' in row)
assert guard['canaryReadWriteDenied'] and not guard['liveSafariFilesOpened']
assert all(not row['opened'] and row['errno'] in (1, 2, 13) for row in guard['protectedReadResults'])
after = next(row for row in events if row.get('stage') == 'after')
created = next(row for row in after['profiles'] if row['title'] == after['createdTitle'])
with sqlite3.connect((allowed / 'SafariTabs.db').as_uri() + '?mode=ro', uri=True) as connection:
    integrity = connection.execute('pragma integrity_check').fetchall()
    assert integrity == [('ok',)]
    rows = connection.execute('''select title,external_uuid,server_id,extra_attributes
        from bookmarks where type=1 and subtype=2 and parent=0 and deleted=0''').fetchall()
assert len(rows) == 2
stored = next(row for row in rows if row[0] == created['title'])
assert stored[:3] == (created['title'], created['identifier'], created['serverID'])
assert plistlib.loads(stored[3])['SymbolImageName'] == 'flask'
assert any(row[1:3] == ('DefaultProfile', 'DefaultProfile') for row in rows)
# The default row's empty title is rendered as localized "Personal" by the API.
# Compare identifiers, not its derived display title.
assert sorted(row[1] for row in rows) == sorted(row['identifier'] for row in after['profiles'])
result = {'integrity': 'ok', 'activeProfileRows': len(rows), 'nativeIdentifiersMatchDisk': True,
          'newTitleAndSymbolMatchDisk': True, 'canaryUnchanged': True,
          'liveSafariFilesOpened': False, 'realSafariProfileCreated': False}
print(json.dumps(result, indent=2))
