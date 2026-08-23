import {
  FileSystemProvider,
  FileSystemError,
  EventEmitter,
  Event,
  FileChangeEvent,
  Disposable,
  Uri,
  FileStat,
  FileType,
  window,
  FileChangeType,
  workspace,
} from 'vscode';
import { getParams } from './uri';
import type { WorkspaceSourceControlManager } from './scm/workspace';
import {
  createThrottledAsyncFn,
  eventToPromise,
  filterEvent,
  isDescendant,
  pathEquals,
} from './utils';
import { fakeEditorPath } from './env';
import { getLogger } from './logger';
import * as fs from 'fs';

interface CacheRow {
  uri: Uri;
  timestamp: number;
}

const THREE_MINUTES = 1000 * 60 * 3;
const FIVE_MINUTES = 1000 * 60 * 5;

export class JJFileSystemProvider implements FileSystemProvider {
  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile: Event<FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private changedRepositoryRoots = new Set<string>();
  private cache = new Map<string, CacheRow>();
  private mtime = Date.now();
  private disposables: Disposable[] = [];

  constructor(private repositories: WorkspaceSourceControlManager) {
    setInterval(() => this.cleanup(), FIVE_MINUTES);
  }

  dispose() {}

  onDidChangeRepository({ repositoryRoot }: { repositoryRoot: string }): void {
    this.changedRepositoryRoots.add(repositoryRoot);
    void this.fireChangeEvents();
  }

  fireChangeEvents = createThrottledAsyncFn(this._fireChangeEvents.bind(this));
  private async _fireChangeEvents(): Promise<void> {
    if (!window.state.focused) {
      const onDidFocusWindow = filterEvent(
        window.onDidChangeWindowState,
        (e) => e.focused,
      );
      await eventToPromise(onDidFocusWindow);
    }

    const events: FileChangeEvent[] = [];

    for (const { uri } of this.cache.values()) {
      for (const root of this.changedRepositoryRoots) {
        if (isDescendant(root, uri.fsPath)) {
          events.push({ type: FileChangeType.Changed, uri });
          break;
        }
      }
    }

    if (events.length > 0) {
      this.mtime = new Date().getTime();
      this._onDidChangeFile.fire(events);
    }

    this.changedRepositoryRoots.clear();
  }

  private cleanup(): void {
    const now = new Date().getTime();
    const cache = new Map<string, CacheRow>();

    for (const row of this.cache.values()) {
      const path = row.uri.fsPath;
      const isOpen = workspace.textDocuments
        .filter((d) => d.uri.scheme === 'file')
        .some((d) => pathEquals(d.uri.fsPath, path));

      if (isOpen || now - row.timestamp < THREE_MINUTES) {
        cache.set(row.uri.toString(), row);
      } else {
        // TODO: should fire delete events?
      }
    }

    this.cache = cache;
  }

  watch(): Disposable {
    return new Disposable(() => {});
  }

  async stat(uri: Uri): Promise<FileStat> {
    return {
      type: FileType.File,
      size: (await this.readFile(uri)).length,
      mtime: this.mtime,
      ctime: 0,
    };
  }

  readDirectory(): Thenable<[string, FileType][]> {
    throw new Error('Method not implemented.');
  }

  createDirectory(): void {
    throw new Error('Method not implemented.');
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const params = getParams(uri);

    const repository = this.repositories.getRepositoryFromUri(uri);
    if (!repository) {
      throw FileSystemError.FileNotFound();
    }

    const timestamp = new Date().getTime();
    const cacheValue: CacheRow = { uri, timestamp };

    this.cache.set(uri.toString(), cacheValue);

    if ('diffOriginalRev' in params) {
      if (fakeEditorPath && fs.existsSync(fakeEditorPath)) {
        try {
          const originalContent = await repository.getDiffOriginal(
            params.diffOriginalRev,
            uri.fsPath,
          );
          if (originalContent) {
            return originalContent;
          }
        } catch (e) {
          getLogger().error(`getDiffOriginal failed: ${String(e)}`);
        }
      }
      try {
        const data = await repository.readFile(
          `${params.diffOriginalRev}-`,
          uri.fsPath,
        );
        return data;
      } catch (e) {
        if (
          e instanceof Error &&
          (e.message.includes('No such path') ||
            e.message.includes('No such file') ||
            e.message.includes('does not exist') ||
            e.message.includes('failed to find'))
        ) {
          // File was added in this revision; return empty content for the diff's left side
          return new Uint8Array(0);
        }
        throw e;
      }
    } else {
      try {
        const data = await repository.readFile(params.rev, uri.fsPath);
        return data;
      } catch (e) {
        if (
          e instanceof Error &&
          (e.message.includes('No such path') ||
            e.message.includes('No such file') ||
            e.message.includes('does not exist') ||
            e.message.includes('failed to find'))
        ) {
          // File was deleted in this revision; return empty content for the diff's right side
          return new Uint8Array(0);
        }
        throw e;
      }
    }
  }

  writeFile(): void {
    throw new Error('Method not implemented.');
  }

  delete(): void {
    throw new Error('Method not implemented.');
  }

  rename(): void {
    throw new Error('Method not implemented.');
  }
}
