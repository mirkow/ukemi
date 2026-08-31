import { parseRenamePaths } from '../../jj/parser';
import { parseJJLog } from '../../graph_webview';
import * as assert from 'assert/strict';
import { JJRepository } from '../../jj/repository';
import { Change, FileStatus, Show, ChangeWithDetails } from '../../jj/types';
import { getJJPath, getRepoAuthor, getRepoPath } from '../utils';
import fs from 'fs/promises';
import path from 'path';
import { SemVer } from '../../semver';

suite('JJRepository', () => {
  let suiteDir: string;

  suiteSetup(async () => {
    suiteDir = await fs.mkdtemp(path.join(getRepoPath(), 'suite-'));
  });

  suiteTeardown(async () => {
    await fs.rm(suiteDir, { recursive: true });
  });

  suite('getStatus', () => {
    test('retrieves the status of the jj workspace', async () => {
      const fileName = 'file.txt';
      const filePath = path.join(suiteDir, fileName);
      const relativeFilePath = path.relative(getRepoPath(), filePath);

      await fs.writeFile(filePath, 'Initial content');
      const repo = new JJRepository(
        getRepoPath(),
        getJJPath(),
        SemVer.parse('0.42.0'),
        [],
      );

      const status = await repo.getStatus();

      assert.deepStrictEqual(status.conflictedFiles, new Set<string>());
      assert.deepStrictEqual(status.fileStatuses, [
        {
          file: relativeFilePath,
          path: filePath,
          type: 'A',
        } satisfies FileStatus,
      ]);
      assert.strictEqual(status.parentChanges.length, 1);
      assert.deepStrictEqual(status.parentChanges[0], {
        bookmarks: [],
        changeId: 'zzzzzzzz',
        commitId: '00000000',
        description: '',
        isConflict: false,
        isEmpty: true,
        isImmutable: true,
      } satisfies Change);
      assert.partialDeepStrictEqual(status.workingCopy, {
        bookmarks: [],
        description: '',
        isEmpty: false,
        isConflict: false,
        isImmutable: false,
      } satisfies Partial<Change>);
      assert.match(status.workingCopy.changeId, /^[k-z]{8}$/);
      assert.match(status.workingCopy.commitId, /^[a-f0-9]{8}$/);
    });
  });

  suite('showAll', () => {
    test('shows all commits for a revset', async () => {
      const fileName = 'file.txt';
      const filePath = path.join(suiteDir, fileName);
      const relativeFilePath = path.relative(getRepoPath(), filePath);
      const repoAuthor = getRepoAuthor();

      await fs.writeFile(filePath, 'Initial content');
      const repo = new JJRepository(
        getRepoPath(),
        getJJPath(),
        SemVer.parse('0.42.0'),
        [],
      );

      const show = await repo.showAll(['::']);

      assert.strictEqual(relativeFilePath, relativeFilePath);
      assert.strictEqual(show.length, 2);
      assert.partialDeepStrictEqual(show[0], {
        conflictedFiles: new Set<string>(),
        fileStatuses: [
          {
            file: relativeFilePath,
            path: filePath,
            type: 'A',
          },
        ],
      } satisfies Partial<Show>);
      assert.partialDeepStrictEqual(show[0].change, {
        author: {
          email: repoAuthor.email,
          name: repoAuthor.name,
        },
        description: '',
        isConflict: false,
        isEmpty: false,
        isImmutable: false,
      } satisfies Partial<ChangeWithDetails>);
      assert.match(show[0].change.changeId, /^[k-z]{32}$/);
      assert.match(show[0].change.commitId, /^[a-f0-9]{40}$/);
      assert.partialDeepStrictEqual(show[1].change, {
        author: {
          email: '',
          name: '',
        },
        changeId: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
        commitId: '0000000000000000000000000000000000000000',
        parentChangeIds: [],
        bookmarks: [],
        description: '',
        isConflict: false,
        isEmpty: true,
        isImmutable: true,
        isCurrentWorkingCopy: false,
        isSynced: true,
      } satisfies Partial<ChangeWithDetails>);
      assert.deepStrictEqual(show[1].conflictedFiles, new Set<string>());
      assert.deepStrictEqual(show[1].fileStatuses, []);
    });
  });

  suite('getChanges', () => {
    test('retrieves commit metadata without diff files', async () => {
      const fileName = 'file_get_changes.txt';
      const filePath = path.join(suiteDir, fileName);
      const repoAuthor = getRepoAuthor();

      await fs.writeFile(filePath, 'Some content');
      const repo = new JJRepository(
        getRepoPath(),
        getJJPath(),
        SemVer.parse('0.42.0'),
        [],
      );

      const changes = await repo.getChanges(['::']);

      assert.strictEqual(changes.length, 2);
      assert.partialDeepStrictEqual(changes[0], {
        author: {
          email: repoAuthor.email,
          name: repoAuthor.name,
        },
        description: '',
        isConflict: false,
        isEmpty: false,
        isImmutable: false,
      } satisfies Partial<ChangeWithDetails>);
      assert.match(changes[0].changeId, /^[k-z]{32}$/);
      assert.match(changes[0].commitId, /^[a-f0-9]{40}$/);
      assert.partialDeepStrictEqual(changes[1], {
        author: {
          email: '',
          name: '',
        },
        changeId: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
        commitId: '0000000000000000000000000000000000000000',
        parentChangeIds: [],
        bookmarks: [],
        description: '',
        isConflict: false,
        isEmpty: true,
        isImmutable: true,
        isCurrentWorkingCopy: false,
        isSynced: true,
      } satisfies Partial<ChangeWithDetails>);
    });
  });

  suite('rebase', () => {
    test('rebases a revision including descendants onto a destination revision', async () => {
      const repo = new JJRepository(
        getRepoPath(),
        getJJPath(),
        SemVer.parse('0.42.0'),
        [],
      );

      const fileA = path.join(suiteDir, 'rebase_inc_a.txt');
      await fs.writeFile(fileA, 'A content');
      await repo.describe('@', 'Commit A');
      const showA = await repo.show('@');
      const changeA = showA.change.changeId;
      await repo.new();

      const fileB = path.join(suiteDir, 'rebase_inc_b.txt');
      await fs.writeFile(fileB, 'B content');
      await repo.describe('@', 'Commit B');
      const showB = await repo.show('@');
      const changeB = showB.change.changeId;
      await repo.new();

      const fileC = path.join(suiteDir, 'rebase_inc_c.txt');
      await fs.writeFile(fileC, 'C content');
      await repo.describe('@', 'Commit C');
      const showC = await repo.show('@');
      const changeC = showC.change.changeId;
      await repo.new();

      // Create destination commit D off A
      await repo.new(undefined, [changeA]);
      const fileD = path.join(suiteDir, 'rebase_inc_d.txt');
      await fs.writeFile(fileD, 'D content');
      await repo.describe('@', 'Commit D');
      const showD = await repo.show('@');
      const changeD = showD.change.changeId;
      await repo.new();

      // Rebase B including descendants onto D
      await repo.rebase({
        sourceRev: changeB,
        destRev: changeD,
        withDescendants: true,
      });

      const showBAfter = await repo.show(changeB);
      assert.ok(
        showBAfter.change.parentChangeIds.includes(changeD),
        'Expected Commit B parent to be Commit D after rebase',
      );

      const showCAfter = await repo.show(changeC);
      assert.ok(
        showCAfter.change.parentChangeIds.includes(changeB),
        'Expected Commit C parent to still be Commit B after rebase with descendants',
      );
      assert.ok(
        !showCAfter.change.parentChangeIds.includes(changeA),
        'Expected Commit C parent not to be Commit A after rebase with descendants',
      );
    });

    test('rebases a revision without descendants onto a destination revision', async () => {
      const repo = new JJRepository(
        getRepoPath(),
        getJJPath(),
        SemVer.parse('0.42.0'),
        [],
      );

      const fileA = path.join(suiteDir, 'rebase_no_a.txt');
      await fs.writeFile(fileA, 'A content');
      await repo.describe('@', 'Commit A');
      const showA = await repo.show('@');
      const changeA = showA.change.changeId;
      await repo.new();

      const fileB = path.join(suiteDir, 'rebase_no_b.txt');
      await fs.writeFile(fileB, 'B content');
      await repo.describe('@', 'Commit B');
      const showB = await repo.show('@');
      const changeB = showB.change.changeId;
      await repo.new();

      const fileC = path.join(suiteDir, 'rebase_no_c.txt');
      await fs.writeFile(fileC, 'C content');
      await repo.describe('@', 'Commit C');
      const showC = await repo.show('@');
      const changeC = showC.change.changeId;
      await repo.new();

      // Create destination commit D off A
      await repo.new(undefined, [changeA]);
      const fileD = path.join(suiteDir, 'rebase_no_d.txt');
      await fs.writeFile(fileD, 'D content');
      await repo.describe('@', 'Commit D');
      const showD = await repo.show('@');
      const changeD = showD.change.changeId;
      await repo.new();

      // Rebase B without descendants onto D
      await repo.rebase({
        sourceRev: changeB,
        destRev: changeD,
        withDescendants: false,
      });

      const showBAfter = await repo.show(changeB);
      assert.ok(
        showBAfter.change.parentChangeIds.includes(changeD),
        'Expected Commit B parent to be Commit D after rebase',
      );

      const showCAfter = await repo.show(changeC);
      assert.ok(
        showCAfter.change.parentChangeIds.includes(changeA),
        'Expected Commit C to be re-parented onto Commit A after single revision rebase',
      );
    });

    test('rebases an entire branch onto a destination revision using wholeBranch', async () => {
      const repo = new JJRepository(
        getRepoPath(),
        getJJPath(),
        SemVer.parse('0.42.0'),
        [],
      );

      // Create base commit Base
      const fileBase = path.join(suiteDir, 'rebase_wb_base.txt');
      await fs.writeFile(fileBase, 'Base content');
      await repo.describe('@', 'Commit Base');
      const showBase = await repo.show('@');
      const changeBase = showBase.change.changeId;
      await repo.new();

      // Create branch A -> B -> C off Base
      await repo.new(undefined, [changeBase]);
      const fileA = path.join(suiteDir, 'rebase_wb_a.txt');
      await fs.writeFile(fileA, 'A content');
      await repo.describe('@', 'Commit A');
      const showA = await repo.show('@');
      const changeA = showA.change.changeId;
      await repo.new();

      // Create commit B off A
      const fileB = path.join(suiteDir, 'rebase_wb_b.txt');
      await fs.writeFile(fileB, 'B content');
      await repo.describe('@', 'Commit B');
      const showB = await repo.show('@');
      const changeB = showB.change.changeId;
      await repo.new();

      // Create commit C off B
      const fileC = path.join(suiteDir, 'rebase_wb_c.txt');
      await fs.writeFile(fileC, 'C content');
      await repo.describe('@', 'Commit C');
      const showC = await repo.show('@');
      const changeC = showC.change.changeId;
      await repo.new();

      // Create destination commit D off Base
      await repo.new(undefined, [changeBase]);
      const fileD = path.join(suiteDir, 'rebase_wb_d.txt');
      await fs.writeFile(fileD, 'D content');
      await repo.describe('@', 'Commit D');
      const showD = await repo.show('@');
      const changeD = showD.change.changeId;
      await repo.new();

      // Rebase entire branch using C as target onto D
      await repo.rebase({
        sourceRev: changeC,
        destRev: changeD,
        wholeBranch: true,
      });

      // Commit A (the root of the branch off Base) should now be on D
      const showAAfter = await repo.show(changeA);
      assert.ok(
        showAAfter.change.parentChangeIds.includes(changeD),
        'Expected root Commit A parent to be Commit D after wholeBranch rebase',
      );

      const showBAfter = await repo.show(changeB);
      assert.ok(
        showBAfter.change.parentChangeIds.includes(changeA),
        'Expected Commit B parent to still be Commit A after wholeBranch rebase',
      );

      const showCAfter = await repo.show(changeC);
      assert.ok(
        showCAfter.change.parentChangeIds.includes(changeB),
        'Expected Commit C parent to still be Commit B after wholeBranch rebase',
      );
    });
  });

  suite('undo', () => {
    test('undoes the last operation', async () => {
      const repo = new JJRepository(
        getRepoPath(),
        getJJPath(),
        SemVer.parse('0.42.0'),
        [],
      );

      const beforeShow = await repo.show('@');
      const beforeDesc = beforeShow.change.description;

      await repo.describe('@', 'Temporary message');
      const duringShow = await repo.show('@');
      assert.strictEqual(duringShow.change.description, 'Temporary message');

      await repo.undo();
      const afterShow = await repo.show('@');
      assert.strictEqual(afterShow.change.description, beforeDesc);
    });
  });

  suite('bookmarks', () => {
    test('sets and lists bookmarks on a change', async () => {
      const repo = new JJRepository(
        getRepoPath(),
        getJJPath(),
        SemVer.parse('0.42.0'),
        [],
      );

      const show = await repo.show('@');
      const changeId = show.change.changeId;
      const testBookmark = `test-bm-${Date.now()}`;

      await repo.setBookmark(testBookmark, changeId);
      const bookmarks = await repo.listBookmarks();
      assert.ok(
        bookmarks.includes(testBookmark),
        `Expected ${testBookmark} to be in listed bookmarks: ${bookmarks.join(', ')}`,
      );

      const showAfter = await repo.show(changeId);
      assert.ok(
        showAfter.change.bookmarks.includes(testBookmark),
        `Expected commit bookmarks to include ${testBookmark}`,
      );
    });
  });
});

suite('parseRenamePaths', () => {
  test('should handle rename with no prefix or suffix', () => {
    const input = '{old => new}';
    const expected = {
      fromPath: 'old',
      toPath: 'new',
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test('should handle rename with only suffix', () => {
    const input = '{old => new}.txt';
    const expected = {
      fromPath: 'old.txt',
      toPath: 'new.txt',
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test('should handle rename with only prefix', () => {
    const input = 'prefix/{old => new}';
    const expected = {
      fromPath: 'prefix/old',
      toPath: 'prefix/new',
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test('should handle empty fromPart', () => {
    const input = 'src/test/{ => basic-suite}/main.test.ts';
    const expected = {
      fromPath: 'src/test/main.test.ts',
      toPath: 'src/test/basic-suite/main.test.ts',
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test('should handle empty toPart', () => {
    const input = 'src/{old => }/file.ts';
    const expected = {
      fromPath: 'src/old/file.ts',
      toPath: 'src/file.ts',
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test('should parse rename with leading and trailing directories', () => {
    const input = 'a/b/{c => d}/e/f.txt';
    const expected = {
      fromPath: 'a/b/c/e/f.txt',
      toPath: 'a/b/d/e/f.txt',
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test('should handle extra spaces within curly braces', () => {
    const input = 'src/test/{  =>   basic-suite  }/main.test.ts';
    const expected = {
      fromPath: 'src/test/main.test.ts',
      toPath: 'src/test/basic-suite/main.test.ts',
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test('should handle paths with dots in segments', () => {
    const input = 'src/my.component/{old.module => new.module}/index.ts';
    const expected = {
      fromPath: 'src/my.component/old.module/index.ts',
      toPath: 'src/my.component/new.module/index.ts',
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test('should handle paths with spaces', () => {
    // This test depends on how robust the regex is to special path characters.
    // The current regex is simple and might fail with complex characters.
    const input = 'src folder/{a b => c d}/file name with spaces.txt';
    const expected = {
      fromPath: 'src folder/a b/file name with spaces.txt',
      toPath: 'src folder/c d/file name with spaces.txt',
    };
    assert.deepStrictEqual(parseRenamePaths(input), expected);
  });

  test('should return null for simple rename without curly braces', () => {
    const input = 'old.txt => new.txt';
    assert.strictEqual(parseRenamePaths(input), null);
  });

  test('should return null for non-rename lines', () => {
    const input = 'M src/some/file.ts';
    assert.strictEqual(parseRenamePaths(input), null);
  });

  test('should return null for empty input', () => {
    const input = '';
    assert.strictEqual(parseRenamePaths(input), null);
  });
});

suite('parseJJLog', () => {
  test('should parse normal commit', () => {
    const log =
      'JJLOGSTART|kkmpptxz|kkm|root()|author@example.com|2026-08-26 12:00:00|5 minutes ago|main|e14df8|e14|○|false|false|false|Initial commit\n';
    const nodes = parseJJLog(log);
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].contextValue, 'kkmpptxz');
    assert.strictEqual(nodes[0].isConflict, false);
    assert.strictEqual(
      nodes[0].tooltip,
      'Initial commit\n\nauthor@example.com 2026-08-26 12:00:00',
    );
  });

  test('should parse commit with conflict and include conflict in tooltip', () => {
    const log =
      'JJLOGSTART|conflict123|conf|root()|author@example.com|2026-08-26 12:00:00|5 minutes ago||c0ff1ee|c0f|○|false|false|true|Resolve conflict\n';
    const nodes = parseJJLog(log);
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].contextValue, 'conflict123');
    assert.strictEqual(nodes[0].isConflict, true);
    assert.strictEqual(
      nodes[0].tooltip,
      'Resolve conflict\n\n(conflict)\n\nauthor@example.com 2026-08-26 12:00:00',
    );
  });
});
