import * as assert from 'assert/strict';
import * as path from 'path';
import fs from 'fs/promises';
import { TreeItemCollapsibleState, TreeView, Uri } from 'vscode';
import {
  CommitFileTreeItem,
  CommitFilesGroupTreeItem,
  GraphTreeDataProvider,
  GraphTreeElement,
  GraphTreeItem,
} from '../graph_tree_view';
import { JJRepository } from '../jj/repository';
import { SemVer } from '../semver';
import { getJJPath, getRepoPath } from './utils';
import { getParams } from '../uri';
import { formatRelativeTime, toItalic } from '../utils';

function createMockTreeView(): TreeView<GraphTreeElement> {
  return {
    visible: false,
    reveal: async () => {},
  } as unknown as TreeView<GraphTreeElement>;
}

suite('GraphTreeView', () => {
  let suiteDir: string;
  let repo: JJRepository;

  suiteSetup(async () => {
    suiteDir = await fs.mkdtemp(path.join(getRepoPath(), 'tree-suite-'));
    repo = new JJRepository(
      getRepoPath(),
      getJJPath(),
      SemVer.parse('0.42.0'),
      [],
    );
  });

  suiteTeardown(async () => {
    await fs.rm(suiteDir, { recursive: true });
  });

  test('getChildren returns root commits from repo', async () => {
    const fileName = 'tree_test_file.txt';
    const filePath = path.join(suiteDir, fileName);
    await fs.writeFile(filePath, 'Hello world');
    await repo.describe('@', 'Test commit 1');
    await repo.new();

    const provider = new GraphTreeDataProvider(repo);

    // getChildren should auto-load without needing an explicit refresh call
    const rootItems = (await provider.getChildren()) as GraphTreeItem[];
    assert.ok(rootItems.length >= 1, 'Expected at least 1 root commit item');

    const firstCommit = rootItems[0];
    assert.ok(firstCommit instanceof GraphTreeItem);
    assert.strictEqual(
      firstCommit.collapsibleState,
      TreeItemCollapsibleState.Collapsed,
    );
    assert.strictEqual(provider.getParent(firstCommit), undefined);
    assert.match(firstCommit.getCommitId(), /^[a-f0-9]{40}$/);
  });

  test('getChildren on a commit returns files group and child commits', async () => {
    const fileName = 'tree_lazy_file.txt';
    const filePath = path.join(suiteDir, fileName);
    await fs.writeFile(filePath, 'Lazy content');
    await repo.describe('@', 'Test commit parent');
    await repo.new();

    const childFileName = 'tree_child_file.txt';
    const childFilePath = path.join(suiteDir, childFileName);
    await fs.writeFile(childFilePath, 'Child content');
    await repo.describe('@', 'Test commit child');
    await repo.new();

    const provider = new GraphTreeDataProvider(repo);
    const mockTreeView = createMockTreeView();

    await provider.refresh(mockTreeView);

    async function findCommitInTree(
      desc: string,
      element?: GraphTreeElement,
    ): Promise<GraphTreeItem | undefined> {
      const children = await provider.getChildren(element);
      for (const child of children) {
        if (child instanceof GraphTreeItem) {
          if (child.getDescription().includes(desc)) {
            return child;
          }
          const found = await findCommitInTree(desc, child);
          if (found) {
            return found;
          }
        }
      }
      return undefined;
    }

    const parentCommit = await findCommitInTree('Test commit parent');
    assert.ok(parentCommit, 'Expected to find parent commit in tree');

    // Children of parent commit should contain "files" group AND the child commit
    const commitChildren = await provider.getChildren(parentCommit);
    assert.ok(commitChildren.length >= 2, 'Expected files group and child commit');

    const filesGroup = commitChildren.find(
      (item) => item instanceof CommitFilesGroupTreeItem,
    ) as CommitFilesGroupTreeItem;
    assert.ok(filesGroup, 'Expected files group item under commit');
    assert.strictEqual(filesGroup.label, 'files');
    assert.strictEqual(provider.getParent(filesGroup), parentCommit);

    const childCommit = commitChildren.find(
      (item) =>
        item instanceof GraphTreeItem &&
        item.getDescription().includes('Test commit child'),
    ) as GraphTreeItem;
    assert.ok(childCommit, 'Expected child commit under parent commit');
    assert.strictEqual(provider.getParent(childCommit), parentCommit);

    // Expanding "files" group lazily loads files
    const fileItems = (await provider.getChildren(
      filesGroup,
    )) as CommitFileTreeItem[];
    assert.ok(fileItems.length >= 1, 'Expected at least 1 changed file item');

    const fileItem = fileItems.find(
      (item) =>
        item.label === fileName || item.fileStatus.file.endsWith(fileName),
    );
    assert.ok(fileItem, `Expected to find ${fileName} in changed files`);
    assert.ok(fileItem instanceof CommitFileTreeItem);
    assert.strictEqual(
      fileItem.collapsibleState,
      TreeItemCollapsibleState.None,
    );
    assert.strictEqual(fileItem.contextValue, 'commitFile');
    assert.ok(fileItem.iconPath, 'Expected iconPath on fileItem');
    assert.ok(fileItem.tooltip, 'Expected tooltip on fileItem');
    assert.strictEqual(provider.getParent(fileItem), filesGroup);

    // Verify diff command on file item
    assert.ok(fileItem.command, 'Expected command on file item');
    assert.strictEqual(fileItem.command?.command, 'vscode.diff');
    assert.strictEqual(fileItem.command?.arguments?.length, 3);

    const [leftUri, , title] = fileItem.command.arguments as [
      Uri,
      Uri,
      string,
    ];
    assert.strictEqual(leftUri.scheme, 'jj');
    const leftParams = getParams(leftUri);
    assert.ok('diffOriginalRev' in leftParams);
    assert.strictEqual(
      leftParams.diffOriginalRev,
      parentCommit.getParentChangeIds()?.[0] || `${parentCommit.getChangeId()}-`,
    );

    assert.ok(
      title.includes(parentCommit.getChangeId().slice(0, 8)),
      'Title should contain short change ID',
    );

    // Files have no children
    const fileChildren = await provider.getChildren(fileItem);
    assert.deepStrictEqual(fileChildren, []);
  });

  test('relative time formatting and italic conversion', () => {
    const base = 1700000000000; // Fixed timestamp
    assert.strictEqual(
      formatRelativeTime(new Date(base - 10 * 1000), base),
      'few seconds',
    );
    assert.strictEqual(
      formatRelativeTime(new Date(base - 60 * 1000), base),
      '1 minute',
    );
    assert.strictEqual(
      formatRelativeTime(new Date(base - 5 * 60 * 1000), base),
      '5 minutes',
    );
    assert.strictEqual(
      formatRelativeTime(new Date(base - 60 * 60 * 1000), base),
      '1 hour',
    );
    assert.strictEqual(
      formatRelativeTime(new Date(base - 4 * 60 * 60 * 1000), base),
      '4 hours',
    );
    assert.strictEqual(
      formatRelativeTime(new Date(base - 24 * 60 * 60 * 1000), base),
      '1 day',
    );
    assert.strictEqual(
      formatRelativeTime(new Date(base - 3 * 24 * 60 * 60 * 1000), base),
      '3 days',
    );
    assert.strictEqual(
      formatRelativeTime(new Date(base - 7 * 24 * 60 * 60 * 1000), base),
      '1 week',
    );
    assert.strictEqual(
      formatRelativeTime(new Date(base - 2 * 7 * 24 * 60 * 60 * 1000), base),
      '2 weeks',
    );

    assert.strictEqual(toItalic('few seconds'), '𝘧𝘦𝘸 𝘴𝘦𝘤𝘰𝘯𝘥𝘴');
    assert.strictEqual(toItalic('5 minutes'), '𝟧 𝘮𝘪𝘯𝘶𝘵𝘦𝘴');
    assert.strictEqual(toItalic('2 hours'), '𝟤 𝘩𝘰𝘶𝘳𝘴');
    assert.strictEqual(toItalic('3 days'), '𝟥 𝘥𝘢𝘺𝘴');
    assert.strictEqual(toItalic('1 week'), '𝟣 𝘸𝘦𝘦𝘬');
    assert.strictEqual(toItalic('12 days'), '𝟣𝟤 𝘥𝘢𝘺𝘴');
  });

  test('setFilter filters commits by description and filename', async () => {
    const provider = new GraphTreeDataProvider(repo);

    // Create distinct commits
    const fileAlpha = 'alpha_filter_test.txt';
    await fs.writeFile(path.join(suiteDir, fileAlpha), 'Alpha content');
    await repo.describe('@', 'Alpha feature commit');
    await repo.new();

    const fileBeta = 'beta_filter_test.txt';
    await fs.writeFile(path.join(suiteDir, fileBeta), 'Beta content');
    await repo.describe('@', 'Beta bugfix commit');
    await repo.new();

    // Filter by description
    await provider.setFilter('Alpha feature');
    assert.strictEqual(provider.getFilter(), 'Alpha feature');
    const alphaItems = (await provider.getChildren()) as GraphTreeItem[];
    assert.ok(
      alphaItems.some((item) => item.getDescription().includes('Alpha')),
      'Expected to find Alpha commit',
    );
    assert.ok(
      !alphaItems.some((item) => item.getDescription().includes('Beta bugfix')),
      'Beta commit should be filtered out',
    );

    // Filter by filename
    await provider.setFilter('beta_filter_test');
    const betaItems = (await provider.getChildren()) as GraphTreeItem[];
    assert.ok(
      betaItems.some((item) => item.getDescription().includes('Beta bugfix')),
      'Expected to find Beta commit by filename',
    );

    // Clear filter
    await provider.setFilter('');
    assert.strictEqual(provider.getFilter(), '');
    const rootItems = (await provider.getChildren()) as GraphTreeItem[];
    assert.ok(rootItems.length >= 1, 'Expected root commits after clear');

    async function hasCommitInTree(
      desc: string,
      element?: GraphTreeElement,
    ): Promise<boolean> {
      const children = await provider.getChildren(element);
      for (const child of children) {
        if (child instanceof GraphTreeItem) {
          if (child.getDescription().includes(desc)) {
            return true;
          }
          const found = await hasCommitInTree(desc, child);
          if (found) {
            return true;
          }
        }
      }
      return false;
    }

    assert.ok(
      await hasCommitInTree('Alpha feature'),
      'Expected Alpha commit in tree after clear',
    );
    assert.ok(
      await hasCommitInTree('Beta bugfix'),
      'Expected Beta commit in tree after clear',
    );
  });
});
