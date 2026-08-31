# Change Log

## 0.0.14

- Add context menu action to set or move bookmarks (`jj bookmark set`) with QuickPick selection of existing bookmarks or creation of new bookmark names.
- Add context menu action to push bookmark/branch to remote (`jj git push --bookmark <name>`) when a commit has associated bookmarks.
- Update "Fetch and sync to main" to "Fetch and rebase branch on `<main>`" using whole-branch rebasing (`jj rebase -b`) to automatically rebase the entire stack off main.
- Actively trigger change detection and graph/SCM refresh immediately upon completion of mutating commands.

## 0.0.13

- Add collapsible list of changed files to both Commits tree view and Source Control Graph webview to inspect diffs and copy paths without checking out.
- Add file status indicators (added, modified, deleted, renamed, conflict) in commit file lists.
- Show conflict indicators on commit nodes and files across Source Control Graph and Commits tree view, including conflict notices in tooltips.
- Add quick filter for Commits tree view searching descriptions, authors, and touched files.
- Add context menu to Source Control Graph and Commits tree view with actions for:
  - Copy Commit ID, Change ID, and Description
  - Edit description
  - Rebase including descendants (`jj rebase -s`) and Rebase without descendants (`jj rebase -r`) with QuickPick search across descriptions and IDs
  - Fetch and sync to main (`jj.fetchAndSyncToMain`, with configurable `ukemi.mainBookmark` setting)
  - Edit, New commit, and Abandon (with commit description quoted in confirmation popup)
- Add JJ Undo button to the title bar of the Source Control Graph view.
- Display italicized relative commit age in Commits tree view.
- Fix diff viewer for added and deleted files in JJ file system provider.
- Fix copying relative path on non-working copy revision.

## 0.0.12

- adds compact mode by @sesceu in https://github.com/sbarfurth/ukemi/pull/51
- bugfix: ensure @ is shown even on repos without additional workspaces. by @sesceu in https://github.com/sbarfurth/ukemi/pull/52
- Use --no-integrate-operation on background queries. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/55
- Allow copying file paths in SCM view. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/58

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.11...0.0.12

## 0.0.11

- Prevent switching the view to SCM view after changes. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/47

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.10...0.0.11

## 0.0.10

- Use icons to denote change state in graph. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/45
- Disable file tracking on custom backends. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/41

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.9...0.0.10

## 0.0.9

- Don't focus tree view after selection. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/42
- Fix incorrect calculation of root items in graph tree view. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/43

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.8...0.0.9

## 0.0.8

- Prevent showing immutable parent in SCM panel. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/36
- Provide more customization on change nodes in graph. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/37
- Show progress indicator when checking out a revision by @dakhlopkau in https://github.com/sbarfurth/ukemi/pull/35
- Add commit tree view. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/39

### New Contributors

- @dakhlopkau made their first contribution in https://github.com/sbarfurth/ukemi/pull/35

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.7...0.0.8

## 0.0.7

- Allow configuring graph revset. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/28
- Open working copy on right side of diff editors. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/30
- Switch open and diff actions on SCM file resources. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/31

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.6...0.0.7

## 0.0.6

- add bookmarks to graph view by @sesceu in https://github.com/sbarfurth/ukemi/pull/25
- fix missing working copy indicator by @sesceu in https://github.com/sbarfurth/ukemi/pull/26

### New Contributors

- @sesceu made their first contribution in https://github.com/sbarfurth/ukemi/pull/25

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.5...0.0.6

## 0.0.5

- _no user-visible changes_

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.3...0.0.5

## 0.0.3

- Fix remaining references to "Kaisen" in codebase. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/11

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.2...0.0.3

## 0.0.2

- _no user-visible changes_

**Full Changelog**: https://github.com/sbarfurth/ukemi/compare/0.0.1...0.0.2

## 0.0.1

- Show open button on parent commit. by @sbarfurth in https://github.com/sbarfurth/ukemi/pull/1

**Full Changelog**: https://github.com/sbarfurth/ukemi/commits/0.0.1

## 0.0.0

The base of this extension is
[`v.0.8.2`](https://github.com/keanemind/jjk/releases/tag/v0.8.2) of
keanemind/jjk.
