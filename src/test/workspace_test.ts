import * as assert from 'assert/strict';
import * as path from 'path';
import { getRepoInfosContainingFolder } from '../scm/workspace';

suite('getRepoInfosContainingFolder', () => {
  const root = path.resolve('/work');
  const repoRoot = path.join(root, 'repo');
  const otherRepoRoot = path.join(root, 'other');
  const repoInfos = new Map([
    ['file:///work/repo', { repoRoot }],
    ['file:///work/other', { repoRoot: otherRepoRoot }],
  ]);

  test('returns the repo whose root equals the folder', () => {
    assert.deepEqual(getRepoInfosContainingFolder(repoInfos, repoRoot), [
      ['file:///work/repo', { repoRoot }],
    ]);
  });

  test('returns the repo whose root is an ancestor of the folder', () => {
    assert.deepEqual(
      getRepoInfosContainingFolder(repoInfos, path.join(repoRoot, 'sub', 'x')),
      [['file:///work/repo', { repoRoot }]],
    );
  });

  test('ignores repos that do not contain the folder', () => {
    assert.deepEqual(getRepoInfosContainingFolder(repoInfos, root), []);
    assert.deepEqual(
      getRepoInfosContainingFolder(repoInfos, path.join(root, 'repo2')),
      [],
    );
  });

  test('returns nothing without previous repos', () => {
    assert.deepEqual(getRepoInfosContainingFolder(undefined, repoRoot), []);
  });
});
