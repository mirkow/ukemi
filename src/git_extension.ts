import * as vscode from 'vscode';
import path from 'path';
import fs from 'fs/promises';
import { getLogger } from './logger';
import { pathEquals, stripUNCPrefix } from './utils';

// Minimal subset of the built-in Git extension API that ukemi uses.
// See VS Code's extensions/git/src/api/git.d.ts for the full definition.
interface GitRepository {
  readonly rootUri: vscode.Uri;
}
interface GitAPI {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: typeof GIT_API_VERSION): GitAPI;
}

/** Identifier of VS Code's built-in Git extension. */
const GIT_EXTENSION_ID = 'vscode.git';
/** Version of the Git extension API this module is written against. */
const GIT_API_VERSION = 1;

/**
 * Returns whether ukemi should close the built-in Git extension's repository
 * for the jj repository at `repoRoot`.
 */
export function isAutoCloseGitEnabled(repoRoot: string): boolean {
  return vscode.workspace
    .getConfiguration('ukemi', vscode.Uri.file(repoRoot))
    .get<boolean>('autoCloseGitRepositories', true);
}

/**
 * Returns whether `a` and `b` refer to the same directory. Compares the
 * resolved paths first (case-insensitively on Windows and macOS) and falls
 * back to comparing real paths to handle symlinks.
 */
export async function isSamePath(a: string, b: string): Promise<boolean> {
  if (pathEquals(path.resolve(a), path.resolve(b))) {
    return true;
  }
  const [realA, realB] = await Promise.all([
    realpathOrResolve(a),
    realpathOrResolve(b),
  ]);
  return pathEquals(realA, realB);
}

/** Returns the real path of `p`, or the resolved path if it doesn't exist. */
async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Closes repositories in the built-in Git extension that are also jj
 * repositories, so that only the jj source control UI is shown for them.
 */
export class GitRepositoryCloser implements vscode.Disposable {
  /** Roots of the jj repositories currently known to ukemi. */
  private jjRepoRoots: string[] = [];
  /**
   * Resolves to the activated Git extension, or undefined if it is not
   * installed. Unset until the Git extension is first needed.
   */
  private gitExtensionPromise: Promise<GitExtension | undefined> | undefined;
  /** Listener for newly opened Git repositories; set while Git is enabled. */
  private openRepoListener: vscode.Disposable | undefined;
  /** Git roots for which a `git.close` call is in flight. */
  private closingRoots = new Set<string>();
  private subscriptions: vscode.Disposable[] = [];

  /**
   * Sets the current jj repository roots and closes every matching repository
   * in the Git extension for which `ukemi.autoCloseGitRepositories` is enabled.
   * Repositories the Git extension opens later (e.g. while it is still
   * initializing) are handled by the `onDidOpenRepository` listener.
   */
  async closeGitReposForJJRepos(jjRepoRoots: string[]): Promise<void> {
    this.jjRepoRoots = jjRepoRoots;
    const gitExtension = await this.getGitExtension();
    if (!gitExtension?.enabled) {
      return;
    }
    const api = gitExtension.getAPI(GIT_API_VERSION);
    for (const repo of api.repositories) {
      await this.closeIfJJRepo(api, repo);
    }
  }

  /** Closes `repo` if its root is a known jj repository root. */
  private async closeIfJJRepo(api: GitAPI, repo: GitRepository) {
    const gitRoot = repo.rootUri.fsPath;
    const jjRoot = await this.findJJRoot(gitRoot);
    if (!jjRoot || !isAutoCloseGitEnabled(jjRoot)) {
      return;
    }
    // `git.close` resolves its argument to the innermost open repository
    // containing `rootUri` (i.e. possibly a parent repository) and shows a
    // QuickPick if there is none, so skip repos that are already being closed
    // or were closed while awaiting above. No await happens between this check
    // and the close call.
    const isStillOpen = api.repositories.some(
      (r) => r.rootUri.fsPath === gitRoot,
    );
    if (this.closingRoots.has(gitRoot) || !isStillOpen) {
      return;
    }
    getLogger().info(
      `Closing Git extension repository for jj repo: ${gitRoot}`,
    );
    this.closingRoots.add(gitRoot);
    try {
      await vscode.commands.executeCommand('git.close', repo);
    } finally {
      this.closingRoots.delete(gitRoot);
    }
  }

  /** Returns the jj repository root that matches `gitRoot`, if any. */
  private async findJJRoot(gitRoot: string): Promise<string | undefined> {
    for (const jjRoot of this.jjRepoRoots) {
      if (await isSamePath(stripUNCPrefix(jjRoot), gitRoot)) {
        return jjRoot;
      }
    }
    return undefined;
  }

  /** Activates the Git extension once and subscribes to its events. */
  private getGitExtension(): Promise<GitExtension | undefined> {
    this.gitExtensionPromise ??= this.activateGitExtension();
    return this.gitExtensionPromise;
  }

  private async activateGitExtension(): Promise<GitExtension | undefined> {
    const extension =
      vscode.extensions.getExtension<GitExtension>(GIT_EXTENSION_ID);
    if (!extension) {
      getLogger().info('Git extension not found; not closing Git repositories');
      return undefined;
    }
    const gitExtension = await extension.activate();
    this.listenForOpenedRepos(gitExtension, gitExtension.enabled);
    this.subscriptions.push(
      gitExtension.onDidChangeEnablement((enabled) => {
        this.listenForOpenedRepos(gitExtension, enabled);
        if (enabled) {
          this.closeGitReposForJJRepos(this.jjRepoRoots).catch((e) =>
            getLogger().error(`Failed to close Git repositories: ${e}`),
          );
        }
      }),
    );
    return gitExtension;
  }

  /**
   * (Re)subscribes to repositories opened by the Git extension, so that git
   * repos opened after the initial scan are closed as well. `getAPI` throws
   * while the Git extension is disabled, so only subscribe when enabled.
   */
  private listenForOpenedRepos(gitExtension: GitExtension, enabled: boolean) {
    this.openRepoListener?.dispose();
    this.openRepoListener = undefined;
    if (!enabled) {
      getLogger().info('Git extension disabled; not closing Git repositories');
      return;
    }
    const api = gitExtension.getAPI(GIT_API_VERSION);
    this.openRepoListener = api.onDidOpenRepository((repo) =>
      this.closeIfJJRepo(api, repo).catch((e) =>
        getLogger().error(`Failed to close Git repository: ${e}`),
      ),
    );
  }

  dispose() {
    this.openRepoListener?.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
