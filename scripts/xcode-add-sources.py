#!/usr/bin/env python3
"""Add Margin.app's shell to the generated Xcode project (scripts/make-xcode.sh runs it): each
app/shell/*.swift to the app target's sources, in a Shell group, and dist/app (the overlay's page,
`npm run build`) as a folder copied to the app's Resources/app/. From feat/native-panel's version
(its panel), with the paths changed.

  python3 scripts/xcode-add-sources.py <project file> <repo>

The project file is the one the converter made: project.xcproj (Xcode 27.2's own format: what's in
each group, and which target and build phase each file is for) or project.pbxproj (before it). In
a pbxproj, the converter makes new object ids each time, so the app target, its group and build
phases are found by name (plutil reads the project as JSON), and what's added has ids made from its
path (a SHA-1), the same every run. Either way the project stays in its own text format: lines are
put in, nothing else is rewritten, and running it again changes nothing. The project points at the
files where they are in the repo (nothing copied), so a change to one needs no new project; a file
added or removed does. System python3, nothing to install.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

APP_TARGET = 'Margin'


def panel_files(repo):
    swift_dir = os.path.join(repo, 'app', 'shell')
    return swift_dir, sorted(n for n in os.listdir(swift_dir) if n.endswith('.swift'))


# ---- project.xcproj ----------------------------------------------------------------------------

def add_xcproj(path, repo):
    with open(path) as f:
        text = f.read()
    # The app's group, first in the project's files: { "kind": "group", "path": "Margin", "children": [
    group = re.search(r'\n( *)\{\n\1  "kind": "group",\n\1  "path": "%s",\n\1  "children": \[\n' % APP_TARGET, text)
    if not group:
        sys.exit('xcode-add-sources: no %s group in %s' % (APP_TARGET, path))
    pad = group.group(1) + '    '
    group_dir = os.path.join(os.path.dirname(os.path.dirname(path)), APP_TARGET)
    swift_dir, swift = panel_files(repo)
    block = (
        '%s{\n%s  "kind": "group",\n%s  "name": "Shell",\n%s  "path": "%s",\n%s  "children": [\n' % (pad, pad, pad, pad, os.path.relpath(swift_dir, group_dir), pad)
        + ''.join('%s    { "path": "%s", "target-membership": [ "%s/compile-sources" ] },\n' % (pad, n, APP_TARGET) for n in swift)
        + '%s  ],\n%s},\n' % (pad, pad)
        + '%s{ "path": "%s", "target-membership": [ "%s/resources" ] },\n' % (pad, os.path.relpath(os.path.join(repo, 'dist', 'app'), group_dir), APP_TARGET)
    )
    if block in text:
        return swift
    # Added before, with other files: that goes first.
    text = re.sub(r'%s\{\n%s  "kind": "group",\n%s  "name": "Shell",\n.*?\n%s\},\n%s\{ "path": "[^"]*dist/app", [^\n]*\n' % ((re.escape(pad),) * 5), '', text, flags=re.S)
    group = re.search(r'\n( *)\{\n\1  "kind": "group",\n\1  "path": "%s",\n\1  "children": \[\n' % APP_TARGET, text)
    text = text[:group.end()] + block + text[group.end():]
    with open(path, 'w') as f:
        f.write(text)
    return swift


# ---- project.pbxproj ---------------------------------------------------------------------------

def object_id(name):
    return hashlib.sha1(('margin:' + name).encode()).hexdigest()[:24].upper()


def insert_in_section(text, section, lines):
    end = '/* End %s section */' % section
    if end not in text:
        sys.exit('xcode-add-sources: no %s section' % section)
    return text.replace(end, ''.join(lines) + end, 1)


def insert_in_list(text, owner_id, key, entries):
    # The `key = (` list of the object `owner_id`.
    match = re.search(r'\t\t%s(?: /\*[^*]*\*/)? = \{\n(?:\t\t\t[^\n]*\n)*?\t\t\t%s = \(\n' % (owner_id, key), text)
    if not match:
        sys.exit('xcode-add-sources: no %s list in %s' % (key, owner_id))
    return text[:match.end()] + ''.join('\t\t\t\t%s,\n' % e for e in entries) + text[match.end():]


def add_pbxproj(path, repo):
    objects = json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', path]))['objects']
    target = next(o for o in objects.values() if o.get('isa') == 'PBXNativeTarget' and o.get('name') == APP_TARGET)
    phases = {objects[p]['isa']: p for p in target['buildPhases']}
    sources, resources = phases['PBXSourcesBuildPhase'], phases['PBXResourcesBuildPhase']
    root = next(o for o in objects.values() if o.get('isa') == 'PBXProject')['mainGroup']
    app_group = next(c for c in objects[root]['children'] if objects[c].get('isa') == 'PBXGroup' and (objects[c].get('name') or objects[c].get('path')) == APP_TARGET)
    group_dir = os.path.join(os.path.dirname(os.path.dirname(path)), objects[app_group].get('path', ''))

    with open(path) as f:
        text = f.read()
    swift_dir, swift = panel_files(repo)
    panel_group = object_id('group:app/shell')
    folder_ref = object_id('folder:dist/app')
    folder_build = object_id('build:dist/app')

    if panel_group not in text:
        text = insert_in_section(text, 'PBXGroup', ['\t\t%s /* Shell */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t);\n\t\t\tname = Shell;\n\t\t\tpath = "%s";\n\t\t\tsourceTree = "<group>";\n\t\t};\n'
                                                     % (panel_group, os.path.relpath(swift_dir, group_dir))])
        text = insert_in_list(text, app_group, 'children', ['%s /* Shell */' % panel_group])
    refs, builds, children, compiled = [], [], [], []
    for name in swift:
        ref, build = object_id('file:app/shell/' + name), object_id('build:app/shell/' + name)
        if ref in text:
            continue
        refs.append('\t\t%s /* %s */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = %s; sourceTree = "<group>"; };\n' % (ref, name, name))
        builds.append('\t\t%s /* %s in Sources */ = {isa = PBXBuildFile; fileRef = %s /* %s */; };\n' % (build, name, ref, name))
        children.append('%s /* %s */' % (ref, name))
        compiled.append('%s /* %s in Sources */' % (build, name))
    if children:
        text = insert_in_section(text, 'PBXFileReference', refs)
        text = insert_in_section(text, 'PBXBuildFile', builds)
        text = insert_in_list(text, panel_group, 'children', children)
        text = insert_in_list(text, sources, 'files', compiled)
    if folder_ref not in text:
        panel_dir = os.path.relpath(os.path.join(repo, 'dist', 'app'), group_dir)
        text = insert_in_section(text, 'PBXFileReference', ['\t\t%s /* app */ = {isa = PBXFileReference; lastKnownFileType = folder; name = app; path = "%s"; sourceTree = "<group>"; };\n' % (folder_ref, panel_dir)])
        text = insert_in_section(text, 'PBXBuildFile', ['\t\t%s /* app in Resources */ = {isa = PBXBuildFile; fileRef = %s /* app */; };\n' % (folder_build, folder_ref)])
        text = insert_in_list(text, app_group, 'children', ['%s /* app */' % folder_ref])
        text = insert_in_list(text, resources, 'files', ['%s /* app in Resources */' % folder_build])
    with open(path, 'w') as f:
        f.write(text)
    return swift


def main():
    path, repo = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    swift = add_xcproj(path, repo) if path.endswith('.xcproj') else add_pbxproj(path, repo)
    print('Shell: %d Swift files in the app, dist/app in its Resources' % len(swift))


if __name__ == '__main__':
    main()
