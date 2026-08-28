import * as vscode from 'vscode';
import * as fs from 'fs';
import type { JJRepository } from './jj/repository';
import type { ChangeWithDetails } from './jj/types';
import type { WorkspaceSourceControlManager } from './scm/workspace';
import path from 'path';
import { getGraphConfig, getMainBookmark } from './config';
import { toJJUri } from './uri';

type Message =
  | {
      command: 'webviewReady';
    }
  | {
      command: 'editChange';
      changeId: string;
    }
  | {
      command: 'selectChange';
      selectedNodes: string[];
    }
  | {
      command: 'getCommitFiles';
      changeId: string;
    }
  | {
      command: 'openFileDiff';
      changeId: string;
      fileStatus: {
        type: 'A' | 'M' | 'D' | 'R' | 'C';
        file: string;
        path: string;
        renamedFrom?: string;
      };
    }
  | {
      command: 'copyPath';
      path: string;
    }
  | {
      command: 'copyRelativePath';
      file: string;
    }
  | {
      command: 'copyText';
      text: string;
    }
  | {
      command: 'rebaseChange';
      changeId: string;
      withDescendants?: boolean;
    }
  | {
      command: 'newChange';
      changeId: string;
    }
  | {
      command: 'abandonChange';
      changeId: string;
      description?: string;
    }
  | {
      command: 'fetchAndSyncToMain';
      changeId: string;
    }
  | {
      command: 'describeChange';
      changeId: string;
    }
  | {
      command: 'setBookmark';
      changeId: string;
    }
  | {
      command: 'pushBookmark';
      changeId: string;
      bookmarks?: string[];
    };

export class ChangeNode {
  constructor(
    readonly label: string,
    readonly description: string,
    readonly isImmutable: boolean,
    readonly tooltip: string,
    readonly contextValue: string,
    readonly shortestChangeId: string,
    readonly parentChangeIds?: string[],
    readonly branchType?: string,
    readonly bookmarks?: string[],
    readonly commitId?: string,
    readonly shortestCommitId?: string,
    readonly email?: string,
    readonly timestamp?: string,
    readonly timestampAgo?: string,
    readonly isEmpty?: boolean,
    readonly isConflict?: boolean,
  ) {}
}

export class JJGraphWebview implements vscode.WebviewViewProvider {
  subscriptions: {
    dispose(): unknown;
  }[] = [];

  public panel?: vscode.WebviewView;
  public repository: JJRepository;
  public selectedNodes: Set<string> = new Set();

  constructor(
    private readonly extensionUri: vscode.Uri,
    repo: JJRepository,
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceSCM?: WorkspaceSourceControlManager,
  ) {
    this.repository = repo;

    // Register the webview provider
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('jjGraphWebview', this, {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }),
    );

    // Auto-refresh when relevant configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('ukemi.graph')) {
          void this.refresh();
        }
      }),
    );
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    this.panel = webviewView;
    this.panel.title = `Source Control Graph (${path.basename(this.repository.repositoryRoot)})`;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getWebviewContent(webviewView.webview);

    await new Promise<void>((resolve) => {
      const messageListener = webviewView.webview.onDidReceiveMessage(
        (message: Message) => {
          if (message.command === 'webviewReady') {
            messageListener.dispose();
            resolve();
          }
        },
      );
    });

    webviewView.webview.onDidReceiveMessage(async (message: Message) => {
      switch (message.command) {
        case 'editChange':
          try {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: 'Updating working directory...',
              },
              async () => {
                await this.repository.editRetryImmutable(message.changeId);
              },
            );
            await this.workspaceSCM?.checkForUpdates(
              this.repository.repositoryRoot,
            );
          } catch (error: unknown) {
            vscode.window.showErrorMessage(
              `Failed to switch to change: ${error as string}`,
            );
          }
          break;
        case 'selectChange':
          this.selectedNodes = new Set(message.selectedNodes);
          vscode.commands.executeCommand(
            'setContext',
            'jjGraphView.nodesSelected',
            message.selectedNodes.length,
          );
          break;
        case 'getCommitFiles':
          try {
            const showResult = await this.repository.show(message.changeId, {
              noIntegrate: true,
            });
            await this.panel?.webview.postMessage({
              command: 'commitFilesLoaded',
              changeId: message.changeId,
              files: showResult.fileStatuses,
            });
          } catch (error) {
            await this.panel?.webview.postMessage({
              command: 'commitFilesLoaded',
              changeId: message.changeId,
              files: [],
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        case 'openFileDiff': {
          try {
            const { changeId, fileStatus } = message;
            const changes = await this.repository.getChanges([changeId], {
              noIntegrate: true,
            });
            const change = changes[0];
            const originalRev = change?.parentChangeIds?.[0] || `${changeId}-`;
            const fromPath = fileStatus.renamedFrom || fileStatus.file;
            const leftUri = toJJUri(
              vscode.Uri.file(
                path.join(this.repository.repositoryRoot, fromPath),
              ),
              { diffOriginalRev: originalRev },
            );
            const rightUri =
              change?.isCurrentWorkingCopy && fileStatus.type !== 'D'
                ? vscode.Uri.file(
                    path.join(this.repository.repositoryRoot, fileStatus.file),
                  )
                : toJJUri(
                    vscode.Uri.file(
                      path.join(
                        this.repository.repositoryRoot,
                        fileStatus.file,
                      ),
                    ),
                    { rev: changeId },
                  );
            const shortChangeId = changeId.slice(0, 8);
            const shortOriginalRev = originalRev.slice(0, 8);
            const diffTitle = `${path.basename(fileStatus.file)} (${shortChangeId} vs ${shortOriginalRev})`;
            await vscode.commands.executeCommand(
              'vscode.diff',
              leftUri,
              rightUri,
              diffTitle,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to open diff: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          break;
        }
        case 'copyPath':
          if (message.path) {
            await vscode.env.clipboard.writeText(message.path);
          }
          break;
        case 'copyRelativePath':
          if (message.file) {
            await vscode.env.clipboard.writeText(message.file);
          }
          break;
        case 'copyText':
          if (message.text) {
            await vscode.env.clipboard.writeText(message.text);
          }
          break;
        case 'newChange':
          try {
            await this.repository.new(undefined, [message.changeId]);
            await this.workspaceSCM?.checkForUpdates(
              this.repository.repositoryRoot,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to create new change${error instanceof Error ? `: ${error.message}` : ''}`,
            );
          }
          break;
        case 'abandonChange':
          try {
            const shortId = message.changeId.slice(0, 8);
            let desc = message.description
              ? message.description
                  .replace(/^\(empty\)\s*/, '')
                  .split('\n')[0]
                  .trim()
              : '';
            if (!desc) {
              const showResult = await this.repository
                .show(message.changeId)
                .catch(() => undefined);
              desc = showResult?.change.description
                ? showResult.change.description
                    .replace(/^\(empty\)\s*/, '')
                    .split('\n')[0]
                    .trim()
                : '';
            }
            const descText = desc ? ` "${desc}"` : '';
            const result = await vscode.window.showWarningMessage(
              `Are you sure that you want to abandon ${shortId}${descText}?`,
              { modal: true },
              'Abandon',
            );
            if (result !== 'Abandon') {
              break;
            }
            await this.repository.abandon(message.changeId);
            await this.workspaceSCM?.checkForUpdates(
              this.repository.repositoryRoot,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to abandon change${error instanceof Error ? `: ${error.message}` : ''}`,
            );
          }
          break;
        case 'fetchAndSyncToMain':
          try {
            const shortId = message.changeId.slice(0, 8);
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `Fetching and syncing ${shortId} to main...`,
                cancellable: false,
              },
              async () => {
                await this.repository.gitFetch();
                const mainBookmark = getMainBookmark(
                  this.repository.repositoryRoot
                    ? vscode.Uri.file(this.repository.repositoryRoot)
                    : undefined,
                );
                await this.repository.rebaseRetryImmutable({
                  sourceRev: message.changeId,
                  destRev: mainBookmark,
                  withDescendants: true,
                });
              },
            );
            await this.workspaceSCM?.checkForUpdates(
              this.repository.repositoryRoot,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to fetch and sync to main${error instanceof Error ? `: ${error.message}` : ''}`,
            );
          }
          break;
        case 'describeChange':
          try {
            const showResult = await this.repository.show(message.changeId);
            const input = await vscode.window.showInputBox({
              prompt: 'Provide a description',
              placeHolder: 'Change description here...',
              value: showResult.change.description,
            });
            if (input === undefined) {
              break;
            }
            await this.repository.describeRetryImmutable(
              message.changeId,
              input,
            );
            await this.workspaceSCM?.checkForUpdates(
              this.repository.repositoryRoot,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to update description${error instanceof Error ? `: ${error.message}` : ''}`,
            );
          }
          break;
        case 'rebaseChange':
          try {
            const sourceChangeId = message.changeId;
            const sourceShortId = sourceChangeId.substring(0, 8);
            const withDescendants = message.withDescendants !== false;

            const changes: ChangeWithDetails[] = await this.repository
              .getChanges(['all()'], { noIntegrate: true, limit: 200 })
              .catch(() =>
                this.repository.getChanges([], { noIntegrate: true }),
              );

            const candidateChanges = changes.filter(
              (change: ChangeWithDetails) => change.changeId !== sourceChangeId,
            );

            interface CommitQuickPickItem extends vscode.QuickPickItem {
              changeId: string;
            }

            const items: CommitQuickPickItem[] = candidateChanges.map(
              (change) => {
                const shortChange = change.changeId.substring(0, 8);
                const shortCommit = change.commitId.substring(0, 8);
                const firstLine = change.description
                  ? change.description.split('\n')[0]
                  : '(no description)';
                const bookmarkStr =
                  change.bookmarks.length > 0
                    ? ` [${change.bookmarks.join(', ')}]`
                    : '';
                return {
                  label: `$(git-commit) ${firstLine}`,
                  description: `${shortChange}${bookmarkStr} (${shortCommit})`,
                  detail: `Change: ${change.changeId} • Commit: ${change.commitId} • ${change.author.name}`,
                  changeId: change.changeId,
                };
              },
            );

            const title = withDescendants
              ? `Rebase ${sourceShortId} (including descendants) onto...`
              : `Rebase ${sourceShortId} (without descendants) onto...`;

            const selection = await vscode.window.showQuickPick(items, {
              title,
              placeHolder:
                'Select destination commit (search description, commit ID, change ID, bookmarks)...',
              matchOnDescription: true,
              matchOnDetail: true,
            });

            if (!selection) {
              break;
            }

            await this.repository.rebaseRetryImmutable({
              sourceRev: sourceChangeId,
              destRev: selection.changeId,
              withDescendants,
            });
            await this.workspaceSCM?.checkForUpdates(
              this.repository.repositoryRoot,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to rebase change${error instanceof Error ? `: ${error.message}` : ''}`,
            );
          }
          break;
        case 'setBookmark':
          await promptSetBookmark(
            this.repository,
            message.changeId,
            this.workspaceSCM,
          );
          break;
        case 'pushBookmark':
          await promptPushBookmark(
            this.repository,
            message.changeId,
            message.bookmarks,
            this.workspaceSCM,
          );
          break;
      }
    });

    await this.refresh();
  }

  public async setSelectedRepository(repo: JJRepository) {
    const prevRepo = this.repository;
    this.repository = repo;
    if (this.panel) {
      this.panel.title = `Source Control Graph (${path.basename(this.repository.repositoryRoot)})`;
    }
    if (prevRepo.repositoryRoot !== repo.repositoryRoot) {
      await this.refresh();
    }
  }

  public async refresh() {
    if (!this.panel) {
      return;
    }

    // Use a custom template to ensure we get all the fields we need in a parseable format
    // Format: JJLOGSTART|change_id|parents|email|timestamp|bookmarks|commit_id|branch_indicator|is_empty|is_immutable|is_conflict|description
    const template = `
      concat(
        "JJLOGSTART|",
        self.change_id(), "|",
        self.change_id().shortest(), "|",
        parents.map(|p| p.change_id()).join(" "), "|",
        author.email(), "|",
        author.timestamp().format("%Y-%m-%d %H:%M:%S"), "|",
        author.timestamp().ago(), "|",
        bookmarks.map(|b| b.name()).join(", "), "|",
        self.commit_id(), "|",
        self.commit_id().shortest(), "|",
        if(current_working_copy, "@", if(self.working_copies(), "@", if(self.contained_in("visible_heads()"), "◆", "○"))), "|",
        if(self.empty(), "true", "false"), "|",
        if(self.immutable(), "true", "false"), "|",
        if(self.conflict(), "true", "false"), "|",
        description.first_line(),
        "\\n"
      )
    `;

    const {
      useConfigLogRevset,
      revset,
      limit,
      showAuthor,
      showBookmarks,
      showCommitId,
      showTimestamp,
      viewLayout,
    } = getGraphConfig();

    // Collect all changes in a single pass (graph structure + data)
    const output = await this.repository.log(
      useConfigLogRevset ? null : revset,
      template,
      limit,
      false, // noGraph: false (we want the graph structure)
    );

    const changes = parseJJLog(output);

    const status = await this.repository.getStatus({ useCache: true });
    const workingCopyId = status.workingCopy.changeId;

    this.selectedNodes.clear();
    this.panel.webview.postMessage({
      command: 'updateGraph',
      changes: changes,
      workingCopyId,
      showAuthor,
      showBookmarks,
      showCommitId,
      showTimestamp,
      viewLayout,
    });
  }

  private getWebviewContent(webview: vscode.Webview) {
    // In development, files are in src/webview
    // In production (bundled extension), files are in dist/webview
    const webviewPath = this.extensionUri.fsPath.includes('extensions')
      ? 'dist'
      : 'src';

    const cssPath = vscode.Uri.joinPath(
      this.extensionUri,
      webviewPath,
      'webview',
      'graph.css',
    );
    const cssUri = webview.asWebviewUri(cssPath);

    const codiconPath = vscode.Uri.joinPath(
      this.extensionUri,
      webviewPath === 'dist'
        ? 'dist/codicons'
        : 'node_modules/@vscode/codicons/dist',
      'codicon.css',
    );
    const codiconUri = webview.asWebviewUri(codiconPath);

    const htmlPath = vscode.Uri.joinPath(
      this.extensionUri,
      webviewPath,
      'webview',
      'graph.html',
    );
    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

    // Replace placeholders in the HTML
    html = html.replace('${cssUri}', cssUri.toString());
    html = html.replace('${codiconUri}', codiconUri.toString());

    return html;
  }

  areChangeNodesEqual(a: ChangeNode[], b: ChangeNode[]): boolean {
    if (a.length !== b.length) {
      return false;
    }

    return a.every((nodeA, index) => {
      const nodeB = b[index];
      return (
        nodeA.label === nodeB.label &&
        nodeA.tooltip === nodeB.tooltip &&
        nodeA.description === nodeB.description &&
        nodeA.contextValue === nodeB.contextValue &&
        nodeA.isConflict === nodeB.isConflict
      );
    });
  }

  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
  }
}

export function parseJJLog(output: string): ChangeNode[] {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  const changeNodes: ChangeNode[] = [];

  for (const line of lines) {
    // Use the sentinel to find the start of our data, ignoring graph characters
    const sentinelIndex = line.indexOf('JJLOGSTART|');
    if (sentinelIndex === -1) {
      continue;
    }

    const dataPart = line.substring(sentinelIndex + 'JJLOGSTART|'.length);
    const parts = dataPart.split('|');

    if (parts.length < 14) {
      continue;
    }

    const [
      changeId,
      shortestChangeId,
      parentsStr,
      email,
      timestamp,
      timestampAgo,
      bookmarksStr,
      commitId,
      shortestCommitId,
      branchIndicator,
      isEmptyStr,
      isImmutableStr,
      isConflictStr,
      rawDescription,
    ] = parts;

    let description = rawDescription;
    // const paddingMarker = "JJLOGSTART|";

    // Filter out redundant branch indicators or clean them up if needed
    // logic for branchType (diamond vs circle)
    let branchType: string;
    if (branchIndicator.trim() === '◆') {
      branchType = '◆';
    } else if (branchIndicator.trim() === '@') {
      branchType = '@';
    } else {
      branchType = '○';
    }

    // Parse bookmarks
    const bookmarks =
      bookmarksStr && bookmarksStr.trim().length > 0
        ? bookmarksStr.split(',').map((b) => b.trim())
        : [];

    // Parse parents
    const parentChangeIds =
      parentsStr && parentsStr.trim().length > 0
        ? parentsStr.split(' ').map((p) => p.trim())
        : [];

    // Handle empty commits and missing descriptions
    if (!description || description.trim().length === 0) {
      description = '(no description set)';
    }

    if (isEmptyStr.trim() === 'true') {
      description = `(empty) ${description}`;
    }

    const isImmutable = isImmutableStr.trim() === 'true';
    const isEmpty = isEmptyStr.trim() === 'true';
    const isConflict = isConflictStr.trim() === 'true';

    // Construct simplified label (though frontend uses description directly now)
    const formattedLabel = `${description}`;
    const conflictTooltip = isConflict ? '\n\n(conflict)' : '';
    const tooltip = `${description}${conflictTooltip}\n\n${email} ${timestamp}`;

    changeNodes.push(
      new ChangeNode(
        formattedLabel,
        description,
        isImmutable,
        tooltip,
        changeId,
        shortestChangeId,
        parentChangeIds,
        branchType,
        bookmarks,
        commitId,
        shortestCommitId,
        email,
        timestamp,
        timestampAgo,
        isEmpty,
        isConflict,
      ),
    );
  }
  return changeNodes;
}

export async function promptSetBookmark(
  repository: JJRepository,
  changeId: string,
  workspaceSCM?: WorkspaceSourceControlManager,
): Promise<void> {
  const shortId = changeId.slice(0, 8);
  const existingBookmarks = await repository.listBookmarks();

  interface BookmarkQuickPickItem extends vscode.QuickPickItem {
    bookmarkName: string;
    isCreateNew?: boolean;
  }

  const quickPick = vscode.window.createQuickPick<BookmarkQuickPickItem>();
  quickPick.title = `Set Bookmark on ${shortId}`;
  quickPick.placeholder =
    'Select an existing bookmark or type a new bookmark name...';
  quickPick.matchOnDescription = true;

  function updateItems(value: string) {
    const trimmed = value.trim();
    const items: BookmarkQuickPickItem[] = [];

    if (trimmed && !existingBookmarks.includes(trimmed)) {
      items.push({
        label: `$(plus) Create new bookmark "${trimmed}"`,
        description: 'New bookmark',
        alwaysShow: true,
        bookmarkName: trimmed,
        isCreateNew: true,
      });
    }

    for (const b of existingBookmarks) {
      items.push({
        label: `$(bookmark) ${b}`,
        description: 'Existing bookmark',
        bookmarkName: b,
      });
    }

    quickPick.items = items;
  }

  updateItems('');

  quickPick.onDidChangeValue((value) => {
    updateItems(value);
  });

  const selected = await new Promise<string | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      const selectedItem = quickPick.selectedItems[0];
      const name = selectedItem
        ? selectedItem.bookmarkName
        : quickPick.value.trim();
      quickPick.hide();
      resolve(name || undefined);
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(undefined);
    });
    quickPick.show();
  });

  if (!selected) {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Setting bookmark "${selected}" on ${shortId}...`,
      },
      async () => {
        await repository.setBookmark(selected, changeId);
        await workspaceSCM?.checkForUpdates(repository.repositoryRoot);
      },
    );
    vscode.window.showInformationMessage(
      `Bookmark "${selected}" set on ${shortId}.`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to set bookmark${error instanceof Error ? `: ${error.message}` : ''}`,
    );
  }
}

export async function promptPushBookmark(
  repository: JJRepository,
  changeId: string,
  bookmarks?: string[],
  workspaceSCM?: WorkspaceSourceControlManager,
): Promise<void> {
  const shortId = changeId.slice(0, 8);
  let availableBookmarks = bookmarks;

  if (!availableBookmarks || availableBookmarks.length === 0) {
    const showResult = await repository.show(changeId).catch(() => undefined);
    availableBookmarks = showResult?.change.bookmarks;
  }

  if (!availableBookmarks || availableBookmarks.length === 0) {
    vscode.window.showWarningMessage(
      `Commit ${shortId} has no associated bookmarks to push.`,
    );
    return;
  }

  let bookmarkToPush: string | undefined;
  let pushAll = false;

  if (availableBookmarks.length === 1) {
    bookmarkToPush = availableBookmarks[0];
  } else {
    interface PushQuickPickItem extends vscode.QuickPickItem {
      bookmarkName?: string;
      pushAll?: boolean;
    }

    const items: PushQuickPickItem[] = [
      {
        label: `$(cloud-upload) Push all bookmarks on this commit`,
        description: availableBookmarks.join(', '),
        pushAll: true,
      },
      ...availableBookmarks.map((b) => ({
        label: `$(bookmark) ${b}`,
        description: 'Bookmark on this commit',
        bookmarkName: b,
      })),
    ];

    const selection = await vscode.window.showQuickPick(items, {
      title: `Push bookmark from ${shortId}...`,
      placeHolder: 'Select bookmark to push to remote...',
    });

    if (!selection) {
      return;
    }

    if (selection.pushAll) {
      pushAll = true;
    } else {
      bookmarkToPush = selection.bookmarkName;
    }
  }

  const title = pushAll
    ? `Pushing all bookmarks (${availableBookmarks.join(', ')}) to remote...`
    : `Pushing bookmark "${bookmarkToPush}" to remote...`;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
      },
      async () => {
        if (pushAll) {
          for (const b of availableBookmarks) {
            await repository.gitPush(b);
          }
        } else if (bookmarkToPush) {
          await repository.gitPush(bookmarkToPush);
        }
        await workspaceSCM?.checkForUpdates(repository.repositoryRoot);
      },
    );
    vscode.window.showInformationMessage(
      `Successfully pushed ${pushAll ? 'all bookmarks' : `bookmark "${bookmarkToPush}"`} to remote.`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to push bookmark${error instanceof Error ? `: ${error.message}` : ''}`,
    );
  }
}
