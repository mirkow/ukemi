import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseFileStatusCounts, type JJRepository } from './jj/repository';
import type { ChangeWithDetails, FileStatusCounts } from './jj/types';
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
        linesAdded?: number;
        linesRemoved?: number;
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
    /**
     * The full (multi-line) commit description, trimmed of trailing
     * whitespace. Unlike `description`, it has no "(empty)" prefix and no
     * "(no description set)" placeholder (empty string if not set).
     */
    readonly fullDescription?: string,
    readonly fileCounts?: FileStatusCounts,
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
              { rev: originalRev },
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
            const mainBookmark = getMainBookmark(
              this.repository.repositoryRoot
                ? vscode.Uri.file(this.repository.repositoryRoot)
                : undefined,
            );
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `Fetching and rebasing branch ${shortId} on ${mainBookmark}...`,
                cancellable: false,
              },
              async () => {
                await this.repository.gitFetch();
                await this.repository.rebaseRetryImmutable({
                  sourceRev: message.changeId,
                  destRev: mainBookmark,
                  wholeBranch: true,
                });
              },
            );
            await this.workspaceSCM?.checkForUpdates(
              this.repository.repositoryRoot,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to fetch and rebase branch${error instanceof Error ? `: ${error.message}` : ''}`,
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
            const withDescendants = message.withDescendants !== false;

            const destRev = await promptRebaseDestination(
              this.repository,
              sourceChangeId,
              withDescendants,
            );
            if (!destRev) {
              break;
            }

            await this.repository.rebaseRetryImmutable({
              sourceRev: sourceChangeId,
              destRev,
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
    // Format: JJLOGSTART|change_id|parents|email|timestamp|bookmarks|commit_id|branch_indicator|is_empty|is_immutable|is_conflict|file_statuses|description
    // The description is the full description as a JSON string literal (escape_json), so that
    // multi-line descriptions stay on a single line. It may contain '|', hence it must be the last field.
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
        diff.files().map(|entry| entry.status()).join(","), "|",
        description.escape_json(),
        "\\n"
      )
    `;

    const scopeUri = this.repository.repositoryRoot
      ? vscode.Uri.file(this.repository.repositoryRoot)
      : undefined;
    const {
      useConfigLogRevset,
      revset,
      limit,
      showAuthor,
      showBookmarks,
      showCommitId,
      showTimestamp,
      viewLayout,
    } = getGraphConfig(scopeUri);
    const mainBookmark = getMainBookmark(scopeUri);

    // Collect all changes in a single pass (graph structure + data)
    const output = await this.repository.log(
      useConfigLogRevset ? null : revset,
      template,
      limit,
      false, // noGraph: false (we want the graph structure)
    );

    const changes = parseJJLog(output);

    const status = await this.repository.getStatus({ useCache: false });
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
      mainBookmark,
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
        nodeA.isConflict === nodeB.isConflict &&
        nodeA.fileCounts?.added === nodeB.fileCounts?.added &&
        nodeA.fileCounts?.modified === nodeB.fileCounts?.modified &&
        nodeA.fileCounts?.deleted === nodeB.fileCounts?.deleted
      );
    });
  }

  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
  }
}

/**
 * Minimum number of '|'-separated fields preceding the description field
 * following the "JJLOGSTART|" sentinel of the graph log template.
 */
const MIN_FIELDS_BEFORE_DESCRIPTION = 13;

const VALID_FILE_STATUS_TOKENS = new Set([
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'A',
  'M',
  'D',
  'R',
  'C',
]);

function isFileStatusesField(value: string | undefined): value is string {
  if (value === undefined) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return true;
  }
  return trimmed
    .split(',')
    .every((token) => VALID_FILE_STATUS_TOKENS.has(token.trim()));
}

/**
 * Matches the trailing JSON string literal (the `escape_json()` description) of
 * a graph log line, including the '|' separator in front of it. Since a '"'
 * inside a JSON string literal is always escaped, '|"' cannot occur within it,
 * so the match starts at the real separator even if earlier fields (e.g. the
 * author email or bookmark names) contain '|'.
 */
const TRAILING_JSON_DESCRIPTION_REGEX = /\|("(?:[^"\\]|\\.)*")\s*$/;

/**
 * Splits the data part of a graph log line (after the sentinel) into the fields
 * preceding the description and the full description (trailing whitespace
 * trimmed). If the description is not a valid JSON string literal, the raw
 * remaining text is used instead, so that the node is kept (dropping it would
 * break the parent links of other nodes). Returns undefined if the line has
 * too few fields.
 */
function splitLogLine(
  dataPart: string,
): { fields: string[]; fullDescription: string } | undefined {
  const match = TRAILING_JSON_DESCRIPTION_REGEX.exec(dataPart);
  if (!match) {
    const parts = dataPart.split('|');
    if (parts.length <= MIN_FIELDS_BEFORE_DESCRIPTION) {
      return undefined;
    }
    const descIndex =
      parts.length > MIN_FIELDS_BEFORE_DESCRIPTION + 1 &&
      isFileStatusesField(parts[MIN_FIELDS_BEFORE_DESCRIPTION])
        ? MIN_FIELDS_BEFORE_DESCRIPTION + 1
        : MIN_FIELDS_BEFORE_DESCRIPTION;
    return {
      fields: parts.slice(0, descIndex),
      fullDescription: parts.slice(descIndex).join('|').trimEnd(),
    };
  }

  const fields = dataPart.substring(0, match.index).split('|');
  if (fields.length < MIN_FIELDS_BEFORE_DESCRIPTION) {
    return undefined;
  }
  const jsonDescription = match[1];
  let fullDescription: string;
  try {
    fullDescription = JSON.parse(jsonDescription) as string;
  } catch {
    fullDescription = jsonDescription;
  }
  return { fields, fullDescription: fullDescription.trimEnd() };
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
    const splitLine = splitLogLine(dataPart);
    if (!splitLine) {
      continue;
    }
    const { fields, fullDescription } = splitLine;

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
      fileStatusesStr,
    ] = fields;

    const fileCounts = isFileStatusesField(fileStatusesStr)
      ? parseFileStatusCounts(fileStatusesStr)
      : undefined;

    let description = fullDescription.split(/\r?\n/)[0];
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
    const emptyPrefix = isEmpty ? '(empty) ' : '';
    const tooltip = `${emptyPrefix}${fullDescription || '(no description set)'}${conflictTooltip}\n\n${email} ${timestamp}`;

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
        fullDescription,
        fileCounts,
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

export interface CommitQuickPickItem extends vscode.QuickPickItem {
  changeId: string;
  commitId: string;
}

/**
 * Creates a QuickPickItem representation of a JJ change for commit selection popups.
 */
export function createCommitQuickPickItem(
  change: ChangeWithDetails,
): CommitQuickPickItem {
  const shortChange = change.changeId.substring(0, 8);
  const shortCommit = change.commitId.substring(0, 8);
  const firstLine = change.description
    ? change.description.split('\n')[0]
    : '(no description)';
  const bookmarkStr =
    change.bookmarks.length > 0 ? ` [${change.bookmarks.join(', ')}]` : '';
  return {
    label: `$(git-commit) ${firstLine}`,
    description: `${shortChange}${bookmarkStr} (${shortCommit})`,
    detail: `Change: ${change.changeId} • Commit: ${change.commitId} • ${change.author.name}`,
    changeId: change.changeId,
    commitId: change.commitId,
  };
}

/**
 * Retrieves candidate changes for a rebase operation.
 * Prioritizes the user's commits (mine()), their parents, the current working stack,
 * and the configured main branch bookmark, supplemented with recent commits.
 */
export async function getRebaseCandidateChanges(
  repository: JJRepository,
  sourceChangeId: string,
): Promise<ChangeWithDetails[]> {
  const scopeUri = repository.repositoryRoot
    ? vscode.Uri.file(repository.repositoryRoot)
    : undefined;
  const mainBookmark = getMainBookmark(scopeUri);

  // Revset for essential commits: main branch, user's commits, their parents, working copy & current stack
  const essentialRevset = `present(${JSON.stringify(mainBookmark)}) | present("main") | present(trunk()) | mine() | parents(mine()) | (mutable() & ::@) | @`;

  const [essentialChanges, recentChanges] = await Promise.all([
    repository
      .getChanges([essentialRevset], { noIntegrate: true })
      .catch(() => [] as ChangeWithDetails[]),
    repository
      .getChanges(['all()'], { noIntegrate: true, limit: 100 })
      .catch(() => repository.getChanges([], { noIntegrate: true }))
      .catch(() => [] as ChangeWithDetails[]),
  ]);

  const seenChangeIds = new Set<string>();
  const candidates: ChangeWithDetails[] = [];

  for (const change of [...essentialChanges, ...recentChanges]) {
    if (change.changeId === sourceChangeId) {
      continue;
    }
    if (!seenChangeIds.has(change.changeId)) {
      seenChangeIds.add(change.changeId);
      candidates.push(change);
    }
  }

  return candidates;
}

/**
 * Shows an interactive QuickPick popup to select a destination commit for rebasing.
 * Opens the popup immediately, loads candidate commits asynchronously in the background,
 * and dynamically looks up change IDs or revision patterns entered by the user after a 0.5s delay.
 */
export async function promptRebaseDestination(
  repository: JJRepository,
  sourceChangeId: string,
  withDescendants: boolean,
): Promise<string | undefined> {
  const sourceShortId = sourceChangeId.substring(0, 8);

  const title = withDescendants
    ? `Rebase ${sourceShortId} (including descendants) onto...`
    : `Rebase ${sourceShortId} (without descendants) onto...`;

  const quickPick = vscode.window.createQuickPick<CommitQuickPickItem>();
  quickPick.title = title;
  quickPick.placeholder =
    'Select destination commit (search description, commit ID, change ID, bookmarks)...';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.busy = true;

  const itemsMap = new Map<string, CommitQuickPickItem>();

  return new Promise<string | undefined>((resolve) => {
    let debounceTimer: NodeJS.Timeout | undefined;
    let isDisposed = false;

    // Open popup immediately so user does not experience any UI delay
    quickPick.show();

    // Asynchronously load candidate commits
    void (async () => {
      try {
        const candidateChanges = await getRebaseCandidateChanges(
          repository,
          sourceChangeId,
        );
        if (isDisposed) {
          return;
        }
        for (const change of candidateChanges) {
          if (!itemsMap.has(change.changeId)) {
            itemsMap.set(change.changeId, createCommitQuickPickItem(change));
          }
        }
        quickPick.items = Array.from(itemsMap.values());
      } catch {
        // Ignore loading errors
      } finally {
        if (!isDisposed) {
          quickPick.busy = false;
        }
      }
    })();

    // Dynamically look up commits when the user types a change ID or revision pattern
    quickPick.onDidChangeValue((value) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }

      const query = value.trim();
      // Only trigger dynamic query if pattern looks like a change ID, commit hash, or revision name
      if (query.length < 2 || !/^[a-zA-Z0-9@_.-]+$/.test(query)) {
        return;
      }

      debounceTimer = setTimeout(() => {
        void (async () => {
          if (isDisposed) {
            return;
          }

          const lowerQuery = query.toLowerCase();
          let alreadyHasCandidate = false;
          for (const item of itemsMap.values()) {
            if (
              item.changeId.toLowerCase().startsWith(lowerQuery) ||
              item.commitId.toLowerCase().startsWith(lowerQuery)
            ) {
              alreadyHasCandidate = true;
              break;
            }
          }

          if (alreadyHasCandidate) {
            return;
          }

          quickPick.busy = true;
          try {
            const lookedUpChanges = await repository.getChanges([query], {
              noIntegrate: true,
            });
            let addedNew = false;
            for (const change of lookedUpChanges) {
              if (
                change.changeId !== sourceChangeId &&
                !itemsMap.has(change.changeId)
              ) {
                itemsMap.set(
                  change.changeId,
                  createCommitQuickPickItem(change),
                );
                addedNew = true;
              }
            }
            if (addedNew && !isDisposed) {
              quickPick.items = Array.from(itemsMap.values());
            }
          } catch {
            // Query was not a valid revision or revision was not found, ignore
          } finally {
            if (!isDisposed) {
              quickPick.busy = false;
            }
          }
        })();
      }, 500);
    });

    quickPick.onDidAccept(() => {
      const selection = quickPick.selectedItems[0];
      resolve(selection?.changeId);
      quickPick.hide();
    });

    quickPick.onDidHide(() => {
      isDisposed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      quickPick.dispose();
      resolve(undefined);
    });
  });
}
