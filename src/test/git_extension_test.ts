import * as assert from 'assert/strict';
import * as os from 'os';
import * as path from 'path';
import fs from 'fs/promises';
import { isSamePath } from '../git_extension';

suite('isSamePath', () => {
  let tmpDir: string;

  suiteSetup(async () => {
    tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ukemi-same-path-')),
    );
    await fs.mkdir(path.join(tmpDir, 'repo'));
    await fs.mkdir(path.join(tmpDir, 'other'));
    await fs.symlink(path.join(tmpDir, 'repo'), path.join(tmpDir, 'link'));
  });

  suiteTeardown(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  test('matches identical and unnormalized paths', async () => {
    const repo = path.join(tmpDir, 'repo');
    assert.equal(await isSamePath(repo, repo), true);
    assert.equal(await isSamePath(repo, `${repo}${path.sep}`), true);
    assert.equal(
      await isSamePath(repo, path.join(tmpDir, 'other', '..', 'repo')),
      true,
    );
  });

  test('matches symlinked paths', async () => {
    assert.equal(
      await isSamePath(path.join(tmpDir, 'repo'), path.join(tmpDir, 'link')),
      true,
    );
  });

  test('does not match different or nested paths', async () => {
    const repo = path.join(tmpDir, 'repo');
    assert.equal(await isSamePath(repo, path.join(tmpDir, 'other')), false);
    assert.equal(await isSamePath(repo, path.join(repo, 'sub')), false);
    assert.equal(await isSamePath(repo, tmpDir), false);
  });
});
