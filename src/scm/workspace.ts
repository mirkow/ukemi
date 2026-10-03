import * as vscode from 'vscode';
import path from 'path';
import { JJDecorationProvider } from '../decoration_provider';
import { JJFileSystemProvider } from '../file_system_provider';
import { SemVer } from '../semver';
import {
  getJJPath,
  getJJVersion,
  getConfigArgs,
  spawnJJ,
  handleCommand,
} from '../jj/cli';
import { getLogger } from '../logger';
import { extensionDir } from '../env';
import { RepositorySourceControlManager } from './repository';
import { isDescendant, stripUNCPrefix } from '../utils';

/** Information about a jj repository detected in the workspace. */
type RepoInfo = {
  jjPath: Awaited<ReturnType<typeof getJJPath>>;
  jjVersion: SemVer;
  jjConfigArgs: string[];
  /** Repository root as printed by `jj root`. */
  repoRoot: string;
};

/**
 * Returns the entries of `repoInfos` (keyed by repo URI) whose repository
 * contains `folderPath`, i.e. whose root equals `folderPath` or is one of its
 * ancestors. `jj root` walks up from the workspace folder, so these are the
 * repos that were detected for `folderPath`.
 */
export function getRepoInfosContainingFolder<T extends { repoRoot: string }>(
  repoInfos: Map<string, T> | undefined,
  folderPath: string,
): [string, T][] {
  return [...(repoInfos?.entries() ?? [])].filter(([, { repoRoot }]) =>
    isDescendant(stripUNCPrefix(repoRoot), folderPath),
  );
}

export class WorkspaceSourceControlManager {
  repoInfos: Map<string, RepoInfo> | undefined;
  repoSCMs: RepositorySourceControlManager[] = [];
  subscriptions: {
    dispose(): unknown;
  }[] = [];
  fileSystemProvider: JJFileSystemProvider;

  private _onDidRepoUpdate = new vscode.EventEmitter<{
    repoSCM: RepositorySourceControlManager;
  }>();
  readonly onDidRepoUpdate: vscode.Event<{
    repoSCM: RepositorySourceControlManager;
  }> = this._onDidRepoUpdate.event;

  constructor(private decorationProvider: JJDecorationProvider) {
    this.fileSystemProvider = new JJFileSystemProvider(this);
    this.subscriptions.push(this.fileSystemProvider);
    this.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(
        'jj',
        this.fileSystemProvider,
        {
          isReadonly: true,
          isCaseSensitive: true,
        },
      ),
    );
  }

  /**
   * Returns the jj version to use for `repoUri` when `jj version` failed.
   *
   * Reuses the version previously detected for the same repo and jj binary, so
   * that a transient failure does not re-initialize the repo with a guessed
   * version. Only if no earlier version is known, the default version is used.
   */
  private getFallbackJJVersion(repoUri: string, jjPath: string): SemVer {
    const previous = this.repoInfos?.get(repoUri);
    if (previous && previous.jjPath.filepath === jjPath) {
      getLogger().info(
        `Keeping previously detected jj version ${previous.jjVersion.toString()} for ${repoUri}.`,
      );
      return previous.jjVersion;
    }
    const fallback = SemVer.default();
    getLogger().warn(
      `Assuming jj version ${fallback.toString()} for ${repoUri}, since the actual version could not be determined.`,
    );
    return fallback;
  }

  /**
   * Detects the jj repo containing `folderPath` and adds it to `newRepoInfos`
   * (unless another workspace folder already added the same repo). Throws if
   * `jj root` fails, including when `folderPath` is not in a jj repo.
   */
  private async detectRepoInfo(
    folderPath: string,
    newRepoInfos: Map<string, RepoInfo>,
  ): Promise<void> {
    const jjPath = await getJJPath(folderPath);

    const repoRoot = (
      await handleCommand(
        spawnJJ(jjPath.filepath, ['root'], {
          timeout: 5000,
          cwd: folderPath,
        }),
      )
    )
      .toString()
      .trim();

    const repoUri = vscode.Uri.file(stripUNCPrefix(repoRoot)).toString();
    if (newRepoInfos.has(repoUri)) {
      return;
    }
    const jjVersion =
      (await getJJVersion(jjPath.filepath)) ??
      this.getFallbackJJVersion(repoUri, jjPath.filepath);
    const jjConfigArgs = await getConfigArgs(extensionDir, jjVersion);
    newRepoInfos.set(repoUri, {
      jjPath,
      jjVersion,
      jjConfigArgs,
      repoRoot,
    });
  }

  /**
   * Handles a failed repo detection for `folderPath`. If the folder is not in
   * a jj repo, nothing is added to `newRepoInfos`. Any other error (e.g. a
   * transient spawn failure after an SSH reconnect) is logged and the repos
   * previously detected for `folderPath` are carried over unchanged, so that
   * they are not torn down and re-initialized.
   */
  private handleDetectRepoInfoError(
    folderPath: string,
    error: unknown,
    newRepoInfos: Map<string, RepoInfo>,
  ): void {
    if (error instanceof Error && error.message.includes('no jj repo in')) {
      getLogger().debug(`No jj repo in ${folderPath}`);
      return;
    }
    getLogger().error(
      `Error while initializing ukemi in workspace ${folderPath}: ${String(error)}. Keeping the previous state of this workspace folder.`,
    );
    for (const [repoUri, repoInfo] of getRepoInfosContainingFolder(
      this.repoInfos,
      folderPath,
    )) {
      if (!newRepoInfos.has(repoUri)) {
        newRepoInfos.set(repoUri, repoInfo);
      }
    }
  }

  /**
   * Returns whether `newRepoInfos` differs from the currently known repos in a
   * way that requires re-initializing the repository source control managers.
   */
  private isAnyRepoChanged(newRepoInfos: Map<string, RepoInfo>): boolean {
    let isAnyRepoChanged = false;
    for (const [key, value] of newRepoInfos) {
      const oldValue = this.repoInfos?.get(key);
      if (!oldValue) {
        isAnyRepoChanged = true;
        getLogger().info(`Detected new jj repo in workspace: ${key}`);
      } else if (
        !oldValue.jjVersion.equals(value.jjVersion) ||
        oldValue.jjPath.filepath !== value.jjPath.filepath ||
        oldValue.jjConfigArgs.join(' ') !== value.jjConfigArgs.join(' ') ||
        oldValue.repoRoot !== value.repoRoot
      ) {
        isAnyRepoChanged = true;
        getLogger().info(
          `Detected change that requires reinitialization in workspace: ${key}`,
        );
      }
    }
    for (const key of this.repoInfos?.keys() || []) {
      if (!newRepoInfos.has(key)) {
        isAnyRepoChanged = true;
        getLogger().info(`Detected jj repo removal in workspace: ${key}`);
      }
    }
    return isAnyRepoChanged;
  }

  async refresh() {
    const newRepoInfos = new Map<string, RepoInfo>();
    for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
      const folderPath = workspaceFolder.uri.fsPath;
      try {
        await this.detectRepoInfo(folderPath, newRepoInfos);
      } catch (e) {
        this.handleDetectRepoInfoError(folderPath, e, newRepoInfos);
      }
    }

    const isAnyRepoChanged = this.isAnyRepoChanged(newRepoInfos);
    this.repoInfos = newRepoInfos;

    if (isAnyRepoChanged) {
      const repoSCMs: RepositorySourceControlManager[] = [];
      for (const [
        workspaceFolder,
        { repoRoot, jjPath, jjVersion, jjConfigArgs },
      ] of newRepoInfos.entries()) {
        getLogger().info(
          `Initializing ukemi in workspace ${workspaceFolder}. Using ${jjVersion.toString()} at ${jjPath.filepath} (${jjPath.source}).`,
        );
        const repoSCM = new RepositorySourceControlManager(
          repoRoot,
          this.decorationProvider,
          this.fileSystemProvider,
          jjPath.filepath,
          jjVersion,
          jjConfigArgs,
        );
        repoSCM.onDidUpdate(
          () => {
            this._onDidRepoUpdate.fire({ repoSCM });
          },
          undefined,
          repoSCM.subscriptions,
        );
        repoSCMs.push(repoSCM);
      }

      for (const repoSCM of this.repoSCMs) {
        repoSCM.dispose();
      }
      this.repoSCMs = repoSCMs;
    }
    return isAnyRepoChanged;
  }

  async checkForUpdates(repositoryRoot?: string): Promise<void> {
    if (repositoryRoot) {
      const repoSCM = this.repoSCMs.find(
        (repo) => repo.repositoryRoot === repositoryRoot,
      );
      if (repoSCM) {
        await repoSCM.checkForUpdates();
      }
    } else {
      await Promise.all(
        this.repoSCMs.map((repoSCM) => repoSCM.checkForUpdates()),
      );
    }
  }

  getRepositoryFromUri(uri: vscode.Uri) {
    return this.repoSCMs.find((repo) => {
      return !path.relative(repo.repositoryRoot, uri.fsPath).startsWith('..');
    })?.repository;
  }

  getRepositoryFromResourceGroup(
    resourceGroup: vscode.SourceControlResourceGroup,
  ) {
    return this.repoSCMs.find((repo) => {
      return (
        resourceGroup === repo.workingCopyResourceGroup ||
        repo.parentResourceGroups.includes(resourceGroup)
      );
    })?.repository;
  }

  getRepositoryFromSourceControl(sourceControl: vscode.SourceControl) {
    return this.repoSCMs.find((repo) => repo.sourceControl === sourceControl)
      ?.repository;
  }

  getRepositorySourceControlManagerFromUri(uri: vscode.Uri) {
    return this.repoSCMs.find((repo) => {
      return !path.relative(repo.repositoryRoot, uri.fsPath).startsWith('..');
    });
  }

  getRepositorySourceControlManagerFromResourceGroup(
    resourceGroup: vscode.SourceControlResourceGroup,
  ) {
    return this.repoSCMs.find(
      (repo) =>
        repo.workingCopyResourceGroup === resourceGroup ||
        repo.parentResourceGroups.includes(resourceGroup),
    );
  }

  getResourceGroupFromResourceState(
    resourceState: vscode.SourceControlResourceState,
  ) {
    const resourceUri = resourceState.resourceUri;

    for (const repo of this.repoSCMs) {
      const groups = [
        repo.workingCopyResourceGroup,
        ...repo.parentResourceGroups,
      ];

      for (const group of groups) {
        if (
          group.resourceStates.some(
            (state) => state.resourceUri.toString() === resourceUri.toString(),
          )
        ) {
          return group;
        }
      }
    }

    throw new Error('Resource state not found in any resource group');
  }

  dispose() {
    for (const subscription of this.repoSCMs) {
      subscription.dispose();
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
