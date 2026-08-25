import {
  EventEmitter,
  TreeDataProvider,
  TreeItem,
  Event,
  TreeView,
  window,
  MarkdownString,
  TreeItemCollapsibleState,
  TreeItemLabel,
  ProviderResult,
  workspace,
  ThemeIcon,
  ThemeColor,
  Uri,
} from 'vscode';
import { ChangeWithDetails, FileStatus, FileStatusType } from './jj/types';
import { JJRepository } from './jj/repository';
import { toJJUri } from './uri';
import { getLogger } from './logger';
import { getGraphConfig } from './config';
import { formatRelativeTime, toItalic } from './utils';
import path from 'path';

function getChangeDescription(change: ChangeWithDetails): TreeItemLabel {
  return {
    label:
      change.description.split('\n')[0].trim() ||
      `[${change.changeId.slice(0, 8)}]`,
  };
}

function getChangeTooltip(change: ChangeWithDetails): MarkdownString {
  const str = new MarkdownString(change.description || '(no description)');

  str.appendMarkdown(`\n\n**Change ID:** ${change.changeId}`);
  str.appendMarkdown(`\n\n**Commit ID:** ${change.commitId}`);
  str.appendMarkdown(`\n\n**Author:** ${change.author.name || '(unknown)'}`);
  if (change.author.email) {
    str.appendMarkdown(` \\<${change.author.email}\\>`);
  }
  const relativeTime = formatRelativeTime(change.authoredDate);
  if (relativeTime) {
    str.appendMarkdown(
      `\n\n**Date:** ${change.authoredDate} (${relativeTime})`,
    );
  } else {
    str.appendMarkdown(`\n\n**Date:** ${change.authoredDate}`);
  }
  if (change.bookmarks && change.bookmarks.length > 0) {
    str.appendMarkdown(`\n\n**Bookmarks:** ${change.bookmarks.join(', ')}`);
  }

  return str;
}

export type GraphTreeElement =
  | GraphTreeItem
  | CommitFilesGroupTreeItem
  | CommitFileTreeItem;

export class GraphTreeView {
  private readonly subscriptions: {
    dispose(): unknown;
  }[] = [];
  private readonly graphTreeView: TreeView<GraphTreeElement>;

  constructor(private readonly treeDataProvider: GraphTreeDataProvider) {
    this.graphTreeView = window.createTreeView<GraphTreeElement>('jjGraph', {
      treeDataProvider: this.treeDataProvider,
    });
    this.updateTitle(this.treeDataProvider.getSelectedRepo().repositoryRoot);
    this.graphTreeView.onDidChangeVisibility((e) => {
      // Update the selection whenever the tree view becomes visible. We cannot
      // do any selection updates while the view is hidden since that would cause
      // disruptive panel switching.
      if (e.visible) {
        void this.refresh();
      }
    });
    this.subscriptions.push(
      workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('ukemi.graph')) {
          void this.refresh();
        }
      }),
    );
    this.subscriptions.push(this.graphTreeView);
    void this.refresh();
  }

  async setSelectedRepo(repo: JJRepository) {
    await this.treeDataProvider.setSelectedRepo(repo, this.graphTreeView);
    this.updateTitle(repo.repositoryRoot);
  }

  getRepositoryRoot(): string {
    return this.treeDataProvider.getSelectedRepo().repositoryRoot;
  }

  async refresh() {
    await this.treeDataProvider.refresh(this.graphTreeView);
    this.updateTitle(this.treeDataProvider.getSelectedRepo().repositoryRoot);
  }

  async promptFilter() {
    const current = this.treeDataProvider.getFilter();
    const input = await window.showInputBox({
      prompt: 'Filter commits by description, author, or filename',
      value: current,
      placeHolder: 'e.g. bug, Alice, .ts, or path/to/file',
    });
    if (input !== undefined) {
      await this.setFilter(input.trim());
    }
  }

  async clearFilter() {
    await this.setFilter('');
  }

  async setFilter(filter: string) {
    await this.treeDataProvider.setFilter(filter, this.graphTreeView);
    this.updateTitle(this.treeDataProvider.getSelectedRepo().repositoryRoot);
    void window.showInformationMessage; // noop import check
  }

  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
  }

  private updateTitle(repoName: string) {
    const filter = this.treeDataProvider.getFilter();
    this.graphTreeView.title = filter
      ? `Commits (${path.basename(repoName)}) [${filter}]`
      : `Commits (${path.basename(repoName)})`;
    this.graphTreeView.description = filter ? 'filtered' : undefined;
  }
}

export class GraphTreeItem extends TreeItem {
  constructor(
    private readonly change: ChangeWithDetails,
    private readonly childrenChangeIds: string[],
    private readonly dataProvider: GraphTreeDataProvider,
  ) {
    const hasChildren = childrenChangeIds.length > 0 || !change.isEmpty;
    super(
      getChangeDescription(change),
      hasChildren
        ? TreeItemCollapsibleState.Collapsed
        : TreeItemCollapsibleState.None,
    );
    this.id = this.change.changeId;
    this.iconPath = this.getIcon();
    const relativeTime = formatRelativeTime(change.authoredDate);
    const italicTime = relativeTime ? toItalic(relativeTime) : '';
    if (this.change.isEmpty) {
      this.description = italicTime ? `${italicTime} (empty)` : 'empty';
    } else if (italicTime) {
      this.description = italicTime;
    }
    if (this.change.isImmutable) {
      this.contextValue = 'immutable';
    } else {
      this.contextValue = 'mutable';
    }
    this.tooltip = getChangeTooltip(change);
  }

  getChangeId(): string {
    return this.change.changeId;
  }

  getChange(): ChangeWithDetails {
    return this.change;
  }

  getChildrenChangeIds(): string[] {
    return this.childrenChangeIds;
  }

  getDescription(): string {
    return this.change.description;
  }

  getParentChangeIds(): string[] {
    return this.change.parentChangeIds;
  }

  getRepository(): JJRepository {
    return this.dataProvider.getSelectedRepo();
  }

  equals(other: TreeItem): boolean {
    if (!(other instanceof GraphTreeItem)) {
      return false;
    }
    return (
      this.id === other.id &&
      this.collapsibleState === other.collapsibleState &&
      this.iconPath === other.iconPath &&
      this.description === other.description &&
      this.contextValue === other.contextValue
    );
  }

  private getIcon(): ThemeIcon | undefined {
    if (this.change.isImmutable) {
      return new ThemeIcon('lock');
    }
    if (!this.change.isSynced) {
      return new ThemeIcon('cloud-upload');
    }
    if (this.change.bookmarks.length > 0) {
      return new ThemeIcon('bookmark');
    }
    return undefined;
  }
}

export class CommitFilesGroupTreeItem extends TreeItem {
  constructor(
    public readonly change: ChangeWithDetails,
    public readonly parentCommit: GraphTreeItem,
    private readonly dataProvider: GraphTreeDataProvider,
  ) {
    super('files', TreeItemCollapsibleState.Collapsed);
    this.id = `${change.changeId}:files`;
    this.iconPath = new ThemeIcon('files');
    this.contextValue = 'commitFilesGroup';
    this.tooltip = `Changed files for ${change.changeId.slice(0, 8)}`;
  }

  getChangeId(): string {
    return this.change.changeId;
  }

  getChange(): ChangeWithDetails {
    return this.change;
  }

  getRepository(): JJRepository {
    return this.dataProvider.getSelectedRepo();
  }

  equals(other: TreeItem): boolean {
    if (!(other instanceof CommitFilesGroupTreeItem)) {
      return false;
    }
    return (
      this.id === other.id &&
      this.collapsibleState === other.collapsibleState
    );
  }
}

function getFileIcon(type: FileStatusType): ThemeIcon {
  switch (type) {
    case 'A':
      return new ThemeIcon(
        'diff-added',
        new ThemeColor('jjDecoration.addedResourceForeground'),
      );
    case 'M':
      return new ThemeIcon(
        'diff-modified',
        new ThemeColor('jjDecoration.modifiedResourceForeground'),
      );
    case 'D':
      return new ThemeIcon(
        'diff-removed',
        new ThemeColor('jjDecoration.deletedResourceForeground'),
      );
    case 'R':
      return new ThemeIcon(
        'diff-renamed',
        new ThemeColor('jjDecoration.renamedResourceForeground'),
      );
    case 'C':
      return new ThemeIcon(
        'diff-added',
        new ThemeColor('jjDecoration.addedResourceForeground'),
      );
    default:
      return new ThemeIcon('file');
  }
}

export class CommitFileTreeItem extends TreeItem {
  constructor(
    public readonly fileStatus: FileStatus,
    public readonly change: ChangeWithDetails,
    public readonly parentGroup: CommitFilesGroupTreeItem,
    private readonly dataProvider: GraphTreeDataProvider,
  ) {
    const filename = path.basename(fileStatus.file);
    super(filename, TreeItemCollapsibleState.None);

    this.id = `${change.changeId}:${fileStatus.file}`;
    this.resourceUri = Uri.file(fileStatus.path);
    this.iconPath = getFileIcon(fileStatus.type);

    const dir = path.dirname(fileStatus.file);
    const dirPrefix = dir !== '.' ? dir : '';
    if (fileStatus.type === 'R' && fileStatus.renamedFrom) {
      this.description = `${fileStatus.renamedFrom} → ${dirPrefix}`.trim();
    } else if (fileStatus.type === 'D') {
      this.description = dirPrefix ? `${dirPrefix} (deleted)` : '(deleted)';
    } else if (fileStatus.type === 'A') {
      this.description = dirPrefix ? `${dirPrefix} (added)` : '(added)';
    } else if (dirPrefix) {
      this.description = dirPrefix;
    }

    const statusLabel =
      fileStatus.type === 'A'
        ? 'Added'
        : fileStatus.type === 'D'
          ? 'Deleted'
          : fileStatus.type === 'R'
            ? 'Renamed'
            : fileStatus.type === 'C'
              ? 'Copied'
              : 'Modified';

    if (fileStatus.renamedFrom) {
      this.tooltip = `${statusLabel}: ${fileStatus.renamedFrom} → ${fileStatus.file}`;
    } else {
      this.tooltip = `${statusLabel}: ${fileStatus.file}`;
    }

    this.contextValue = 'commitFile';

    const originalRev = change.parentChangeIds?.[0] || `${change.changeId}-`;
    const fromPath = fileStatus.renamedFrom || fileStatus.file;
    const leftUri = toJJUri(
      Uri.file(path.join(this.dataProvider.getSelectedRepo().repositoryRoot, fromPath)),
      { diffOriginalRev: originalRev },
    );
    const rightUri =
      change.isCurrentWorkingCopy && fileStatus.type !== 'D'
        ? Uri.file(fileStatus.path)
        : toJJUri(Uri.file(fileStatus.path), {
            rev: change.changeId,
          });

    const diffTitleSuffix = change.changeId.slice(0, 8);
    const diffTitle =
      (fileStatus.renamedFrom ? `${fileStatus.renamedFrom} => ` : '') +
      `${fileStatus.file} (${diffTitleSuffix})`;

    this.command = {
      command: 'vscode.diff',
      title: 'Open diff',
      arguments: [leftUri, rightUri, diffTitle],
    };
  }

  getChangeId(): string {
    return this.change.changeId;
  }

  getChange(): ChangeWithDetails {
    return this.change;
  }

  getRepository(): JJRepository {
    return this.dataProvider.getSelectedRepo();
  }

  equals(other: TreeItem): boolean {
    if (!(other instanceof CommitFileTreeItem)) {
      return false;
    }
    return (
      this.id === other.id &&
      this.description === other.description &&
      this.tooltip === other.tooltip &&
      this.iconPath === other.iconPath
    );
  }
}

export class GraphTreeDataProvider
  implements TreeDataProvider<GraphTreeElement>
{
  private readonly onDidChangeTreeDataInternal: EventEmitter<
    GraphTreeElement | undefined | null | void
  > = new EventEmitter();
  onDidChangeTreeData: Event<
    GraphTreeElement | undefined | null | void
  > = this.onDidChangeTreeDataInternal.event;

  private filterQuery = '';
  private items: GraphTreeItem[] = [];
  private itemChangeIds = new Set<string>();
  private readonly filesCache: Map<string, CommitFileTreeItem[]> = new Map();
  private workingCopyChange: ChangeWithDetails | undefined;
  private isLoaded = false;
  private loadingPromise: Promise<void> | null = null;

  constructor(private selectedRepository: JJRepository) {}

  getFilter(): string {
    return this.filterQuery;
  }

  async setFilter(
    filter: string,
    treeView?: TreeView<GraphTreeElement>,
  ) {
    this.filterQuery = filter;
    await this.refresh(treeView);
  }

  getTreeItem(element: TreeItem): TreeItem {
    return element;
  }

  async getChildren(
    element?: GraphTreeElement,
  ): Promise<GraphTreeElement[]> {
    if (!this.isLoaded) {
      await this.loadChanges();
    }

    if (!element) {
      // The item is a root item in the graph if none of its parent change IDs are
      // present in the itemChangeIds set.
      const rootItems = this.items.filter((item) =>
        item.getParentChangeIds().every((id) => !this.itemChangeIds.has(id)),
      );
      return rootItems.length > 0 ? rootItems : this.items;
    }

    if (element instanceof GraphTreeItem) {
      const children: GraphTreeElement[] = [];

      // 1. "files" group node if commit is not empty
      if (!element.getChange().isEmpty) {
        children.push(
          new CommitFilesGroupTreeItem(element.getChange(), element, this),
        );
      }

      // 2. Child commits (commits that have this commit as parent)
      const childCommitIds = element.getChildrenChangeIds();
      const childCommits = this.items.filter((item) =>
        childCommitIds.includes(item.getChangeId()),
      );
      children.push(...childCommits);

      return children;
    }

    if (element instanceof CommitFilesGroupTreeItem) {
      const changeId = element.getChangeId();
      const cached = this.filesCache.get(changeId);
      if (cached) {
        return cached;
      }

      try {
        const showResult = await this.selectedRepository.show(
          changeId,
          { noIntegrate: true },
        );
        const fileItems = showResult.fileStatuses.map(
          (fileStatus) =>
            new CommitFileTreeItem(
              fileStatus,
              element.getChange(),
              element,
              this,
            ),
        );
        this.filesCache.set(changeId, fileItems);
        return fileItems;
      } catch (e) {
        getLogger().error(
          `Failed to get changed files for change ${changeId}: ${String(e)}`,
        );
        return [];
      }
    }

    return [];
  }

  private async loadChanges(): Promise<void> {
    if (this.loadingPromise) {
      return this.loadingPromise;
    }
    this.loadingPromise = (async () => {
      try {
        const { useConfigLogRevset, revset, limit } = getGraphConfig();
        let changes: ChangeWithDetails[];

        const filter = this.filterQuery.trim();
        if (filter) {
          const escaped = JSON.stringify(filter);
          const escapedRecursive = JSON.stringify(`**/*${filter}*`);
          const escapedSimple = JSON.stringify(`*${filter}*`);
          const baseRevset = useConfigLogRevset ? '' : revset;
          const filterClause = `(description(${escaped}) | author(${escaped}) | files(glob:${escapedRecursive}) | files(glob:${escapedSimple}) | file(glob:${escapedRecursive}) | file(glob:${escapedSimple}) | files(${escaped}))`;
          const filterRevset = baseRevset
            ? `(${baseRevset}) & ${filterClause}`
            : filterClause;

          try {
            changes = await this.selectedRepository.getChanges([filterRevset], {
              noIntegrate: true,
              limit,
            });
          } catch (filterError) {
            getLogger().warn(
              `Revset filter failed (${String(filterError)}), falling back to in-memory filter`,
            );
            const allShows = await this.selectedRepository.showAll(
              useConfigLogRevset ? [] : [revset],
              { noIntegrate: true, limit },
            );
            const lowerFilter = filter.toLowerCase();
            changes = allShows
              .filter(
                (show) =>
                  show.change.description.toLowerCase().includes(lowerFilter) ||
                  show.change.author.name.toLowerCase().includes(lowerFilter) ||
                  show.change.author.email.toLowerCase().includes(lowerFilter) ||
                  show.change.changeId.toLowerCase().includes(lowerFilter) ||
                  show.change.bookmarks.some((b) =>
                    b.toLowerCase().includes(lowerFilter),
                  ) ||
                  show.fileStatuses.some((f) =>
                    f.file.toLowerCase().includes(lowerFilter),
                  ),
              )
              .map((s) => s.change);
          }
        } else {
          changes = await this.selectedRepository.getChanges(
            useConfigLogRevset ? [] : [revset],
            { noIntegrate: true, limit },
          );
        }

        const items: GraphTreeItem[] = [];
        const itemChangeIds = new Set<string>();

        for (const change of changes) {
          if (change.isCurrentWorkingCopy) {
            this.workingCopyChange = change;
            continue;
          }
          itemChangeIds.add(change.changeId);
        }

        for (const change of changes) {
          if (change.isCurrentWorkingCopy) {
            continue;
          }
          const childrenChangeIds = changes
            .filter(
              (c) =>
                !c.isCurrentWorkingCopy &&
                c.parentChangeIds.includes(change.changeId),
            )
            .map((c) => c.changeId);
          const item = new GraphTreeItem(change, childrenChangeIds, this);
          items.push(item);
        }

        this.items = items;
        this.itemChangeIds = itemChangeIds;
        this.isLoaded = true;
      } catch (e) {
        getLogger().error(`Failed to load changes: ${String(e)}`);
      } finally {
        this.loadingPromise = null;
      }
    })();
    return this.loadingPromise;
  }

  async refresh(
    treeView?: TreeView<GraphTreeElement>,
  ) {
    const prev = [...this.items];

    this.filesCache.clear();
    this.isLoaded = false;
    await this.loadChanges();

    if (
      prev.length !== this.items.length ||
      !prev.every((change, i) => change.equals(this.items[i]))
    ) {
      this.onDidChangeTreeDataInternal.fire();
    } else {
      this.onDidChangeTreeDataInternal.fire();
    }
    if (treeView) {
      await this.updateSelection(treeView);
    }
  }

  async setSelectedRepo(
    repo: JJRepository,
    treeView?: TreeView<GraphTreeElement>,
  ) {
    const prevRepo = this.selectedRepository;
    this.selectedRepository = repo;
    if (prevRepo.repositoryRoot !== repo.repositoryRoot) {
      await this.refresh(treeView);
    }
  }

  getSelectedRepo() {
    return this.selectedRepository;
  }

  getParent(
    element: GraphTreeElement,
  ): ProviderResult<GraphTreeElement> {
    if (element instanceof CommitFileTreeItem) {
      return element.parentGroup;
    }
    if (element instanceof CommitFilesGroupTreeItem) {
      return element.parentCommit;
    }
    if (element instanceof GraphTreeItem) {
      const parentChangeIds = element.getParentChangeIds();
      if (parentChangeIds.length === 0) {
        return undefined;
      }
      return this.items.find((item) => item.getChangeId() === parentChangeIds[0]);
    }
    return undefined;
  }

  async updateSelection(
    treeView: TreeView<GraphTreeElement>,
  ) {
    if (!treeView.visible || !this.workingCopyChange) {
      return;
    }
    for (const item of this.items) {
      if (this.workingCopyChange.parentChangeIds.includes(item.getChangeId())) {
        try {
          await treeView.reveal(item, { select: true, focus: false });
        } catch {
          // Ignore reveal failures
        }
      }
    }
  }
}
