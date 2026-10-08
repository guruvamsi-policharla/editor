/**
 * Agent Review: the built-in extension of the fork.
 *
 * - Hosts the review engine (one baseline store per workspace folder, persisted in workspace storage).
 * - Feeds it file-watcher events and the user's saves (with the buffer edit log for attribution).
 * - Pushes pending files to the fork's core review UI (`_agentReview.*` commands), which renders them with
 *   VS Code's chat-editing review UI: deleted lines as real rows, per-hunk Keep/Undo, the review bar.
 * - Review list (Explorer > Agent Changes), multi-file diff, agent terminal and Ctrl/Cmd+L.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MultiRootReview } from '@editor/engine';
import { AgentTerminal } from './agentTerminal';
import { ConflictMerger } from './conflicts';
import { ReviewController, type CoreBridge, type ReviewAction } from './controller';
import { EditLogs } from './editLog';
import { BASELINE_SCHEME, BaselineContentProvider, baselineUri, ReviewTree, type FileItem } from './reviewTree';

const CORE_SET_BASELINE = '_agentReview.setBaseline';
const CORE_REMOVE = '_agentReview.remove';
const CORE_CLEAR = '_agentReview.clear';

let controller: ReviewController | undefined;
let review: MultiRootReview | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Agent Review', { log: true });
  context.subscriptions.push(log);

  const agentTerminal = new AgentTerminal();
  context.subscriptions.push(agentTerminal);
  context.subscriptions.push(
    vscode.commands.registerCommand('agentReview.openAgentTerminal', () => agentTerminal.show()),
    vscode.commands.registerCommand('agentReview.sendSelectionToAgent', () => agentTerminal.sendSelection()),
  );

  const config = vscode.workspace.getConfiguration('agentReview');
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  if (!config.get<boolean>('enabled', true) || folders.length === 0) {
    log.info('Agent review inactive (disabled, or no local folder open).');
    return;
  }

  const storageBase = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'baselines');
  const t0 = Date.now();
  review = await MultiRootReview.open({
    roots: folders.map((f) => f.uri.fsPath),
    storageBase,
    ignore: { patterns: config.get<string[]>('ignore', []) },
  });
  log.info(`Engine ready for ${folders.length} folder(s) in ${Date.now() - t0} ms (storage: ${storageBase}).`);

  // Core supports the commands only in the fork; in stock VS Code there's no inline rendering.
  // Probe with `_agentReview.clear`, which also starts core clean (an extension-host restart leaves old
  // entries). getCommands(true) can't be used for detection: it filters out `_`-prefixed commands.
  let hasCore = true;
  try {
    await vscode.commands.executeCommand(CORE_CLEAR);
  } catch {
    hasCore = false;
    log.warn('Core review UI not found (not running in the fork): review list only.');
  }

  const bridge: CoreBridge = {
    setBaseline: async (abs, baseline, kind) => {
      if (hasCore) await vscode.commands.executeCommand(CORE_SET_BASELINE, vscode.Uri.file(abs), baseline, kind);
    },
    remove: async (abs) => {
      if (hasCore) await vscode.commands.executeCommand(CORE_REMOVE, vscode.Uri.file(abs));
    },
  };

  const docs = {
    isDirty: (abs: string) => vscode.workspace.textDocuments.some((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, abs) && d.isDirty),
  };

  let conflicts: ConflictMerger | undefined;
  controller = new ReviewController(review, bridge, docs, {
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
    error: (m, e) => log.error(m, e instanceof Error ? e : String(e ?? '')),
  }, (abs) => void conflicts?.onConflict(abs));
  const ctl = controller;
  context.subscriptions.push({ dispose: () => ctl.dispose() });

  // core -> extension
  context.subscriptions.push(
    vscode.commands.registerCommand('agentReview.ext.onDidHunkAction', async (e: { uri: CoreUri; kind: ReviewAction['kind']; baseline?: string }) => {
      const uri = toUri(e.uri);
      if (uri.scheme !== 'file') return;
      const action = (e.kind === 'accepted' ? { kind: 'accepted', path: uri.fsPath, baseline: e.baseline ?? '' } : { kind: e.kind, path: uri.fsPath }) as ReviewAction;
      try {
        await ctl.onReviewAction(action);
      } catch (err) {
        log.error(`${e.kind} failed for ${uri.fsPath}`, err instanceof Error ? err : String(err));
        void vscode.window.showErrorMessage(`Agent Review: ${String(err instanceof Error ? err.message : err)}`);
      }
    }),
  );

  // Edit logs for user-save attribution.
  const logs = new EditLogs();
  for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === 'file' && !d.isDirty) logs.markClean(d.uri.toString(), d.getText());
  // Agent writes under unsaved edits: 3-way merge.
  conflicts = new ConflictMerger(ctl, logs, path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'conflicts'), hasCore, log);
  const merger = conflicts;
  context.subscriptions.push(
    merger,
    vscode.commands.registerCommand('agentReview.mergeWithDisk', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme === 'file') return merger.merge(target.fsPath);
    }),
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (d.uri.scheme === 'file' && !d.isDirty) logs.markClean(d.uri.toString(), d.getText());
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      logs.forget(d.uri.toString());
      if (d.uri.scheme === 'file') void ctl.onBufferSettled(d.uri.fsPath);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) return;
      logs.onChange(e.document.uri.toString(), e.contentChanges, e.document.isDirty, e.document.version, e.document.isDirty ? undefined : e.document.getText());
      if (!e.document.isDirty) void ctl.onBufferSettled(e.document.uri.fsPath); // reverted or reloaded
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.scheme !== 'file') return;
      logs.markClean(d.uri.toString(), d.getText());
      void ctl.onBufferSettled(d.uri.fsPath);
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      for (const f of e.files) if (f.scheme === 'file') void reviewFor(f.fsPath).then((eng) => eng?.reportUserDelete(f.fsPath));
    }),
    vscode.workspace.onDidRenameFiles((e) => {
      for (const f of e.files) {
        if (f.oldUri.scheme === 'file' && f.newUri.scheme === 'file') void reviewFor(f.oldUri.fsPath).then((eng) => eng?.reportUserRename(f.oldUri.fsPath, f.newUri.fsPath));
      }
    }),
  );
  // Saves. In the fork, core reports each save right before the write, after every save participant, with
  // the buffer version the user's own edits ended at: later edits (format on save, code actions on save)
  // are attributed to the formatter. Without core, onWillSaveTextDocument is the best we get, and it may
  // run after formatters, so their edits count as the user's.
  if (hasCore) {
    context.subscriptions.push(
      vscode.commands.registerCommand('agentReview.ext.onWillWrite', async (e: { uri: CoreUri; userVersion: number; version: number }) => {
        const uri = toUri(e.uri);
        if (uri.scheme !== 'file') return;
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (!doc) return;
        // The document has seen every edit core made (events arrive in order); if not, don't trust the versions.
        const inSync = doc.version === e.version;
        if (!inSync) log.warn(`save of ${uri.fsPath}: document version ${doc.version}, core ${e.version}; attributing all edits to the user`);
        await ctl.onWillSave(uri.fsPath, doc.getText(), logs.get(uri.toString(), inSync ? e.userVersion : undefined));
      }),
    );
  } else {
    context.subscriptions.push(
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.scheme !== 'file') return;
        e.waitUntil(ctl.onWillSave(e.document.uri.fsPath, e.document.getText(), logs.get(e.document.uri.toString())));
      }),
    );
  }
  async function reviewFor(abs: string) {
    return review?.engineFor(abs);
  }

  // File watching: forward every change; the engine decides what is external, ignored or pending.
  const queued = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const paths = [...queued];
    queued.clear();
    ctl.handleFsEvents(paths).catch((err) => log.error('handling file events failed', err instanceof Error ? err : String(err)));
  };
  const onFsEvent = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file') return;
    queued.add(uri.fsPath);
    timer ??= setTimeout(flush, 75);
  };
  for (const folder of folders) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
    context.subscriptions.push(watcher, watcher.onDidCreate(onFsEvent), watcher.onDidChange(onFsEvent), watcher.onDidDelete(onFsEvent));
  }
  context.subscriptions.push({ dispose: () => timer && clearTimeout(timer) });

  // Review list, baseline documents, multi-file diff.
  const baselines = new BaselineContentProvider(ctl);
  const tree = new ReviewTree(ctl);
  const view = vscode.window.createTreeView('agentReview.changes', { treeDataProvider: tree, showCollapseAll: false });
  const status = vscode.window.createStatusBarItem('agentReview.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Agent Review';
  status.command = 'agentReview.changes.focus';
  const updateBadge = () => {
    const n = ctl.pendingFiles.length;
    void vscode.commands.executeCommand('setContext', 'agentReview.hasPendingChanges', n > 0);
    view.badge = n > 0 ? { value: n, tooltip: `${n} file(s) with pending changes` } : undefined;
    status.text = `$(diff-multiple) ${n}`;
    status.tooltip = `Agent Review: ${n} file(s) with pending changes`;
    if (n > 0) status.show();
    else status.hide();
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, baselines),
    baselines,
    tree,
    view,
    status,
    ctl.onDidChangeFiles(updateBadge),
  );

  const itemPath = (arg?: FileItem | vscode.Uri): string | undefined => {
    if (!arg) return vscode.window.activeTextEditor?.document.uri.fsPath;
    return arg instanceof vscode.Uri ? arg.fsPath : arg.file.absPath;
  };
  const run = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      void vscode.window.showErrorMessage(`Agent Review: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('agentReview.acceptFile', (arg?: FileItem | vscode.Uri) => run('Keep', async () => {
      const p = itemPath(arg);
      if (p) await ctl.acceptFile(p);
    })),
    vscode.commands.registerCommand('agentReview.rejectFile', (arg?: FileItem | vscode.Uri) => run('Undo', async () => {
      const p = itemPath(arg);
      if (p) await ctl.rejectFile(p);
    })),
    vscode.commands.registerCommand('agentReview.acceptAll', () => run('Keep All', async () => {
      const r = await ctl.acceptAll();
      if (r.skipped.length) void vscode.window.showWarningMessage(`Agent Review: ${r.skipped.length} file(s) changed while accepting and were skipped.`);
    })),
    vscode.commands.registerCommand('agentReview.rejectAll', () => run('Undo All', async () => {
      const n = ctl.pendingFiles.length;
      const ok = await vscode.window.showWarningMessage(`Undo all pending changes in ${n} file(s)? Files go back to their accepted content.`, { modal: true }, 'Undo All');
      if (ok !== 'Undo All') return;
      const r = await ctl.rejectAll();
      if (r.skipped.length) void vscode.window.showWarningMessage(`Agent Review: skipped ${r.skipped.length} file(s) with unsaved edits or newer changes.`);
    })),
    vscode.commands.registerCommand('agentReview.openChanges', () => run('Open All Changes', async () => {
      const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = ctl.pendingFiles.map((f) => {
        const file = vscode.Uri.file(f.absPath);
        if (f.kind === 'created') return [file, undefined, file];
        if (f.kind === 'deleted') return [file, baselineUri(f.absPath), undefined];
        if (f.kind === 'renamed') return [file, baselineUri(f.oldAbsPath ?? f.absPath), file];
        return [file, baselineUri(f.absPath), file];
      });
      await vscode.commands.executeCommand('vscode.changes', 'Agent Changes', resources);
    })),
    vscode.commands.registerCommand('agentReview.openFileDiff', (arg?: FileItem | vscode.Uri) => run('Open Diff', async () => {
      const p = itemPath(arg);
      if (!p) return;
      const f = ctl.pendingFiles.find((x) => samePath(x.absPath, p));
      const left = baselineUri(f?.oldAbsPath ?? p);
      const right = f?.kind === 'deleted' ? undefined : vscode.Uri.file(p);
      if (!right) await vscode.window.showTextDocument(left, { preview: true });
      else await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(p)} (accepted ↔ current)`);
    })),
    vscode.commands.registerCommand('agentReview.refresh', () => run('Rescan', async () => {
      for (const e of review!.engines.values()) await e.rescan();
      await ctl.syncAll();
    })),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('agentReview.ignore')) {
        const patterns = vscode.workspace.getConfiguration('agentReview').get<string[]>('ignore', []);
        for (const eng of review!.engines.values()) await eng.setIgnorePatterns(patterns);
      }
    }),
  );

  // Push everything pending (core was cleared by the probe above).
  await ctl.syncAll();
  updateBadge();
  // Changes made while the editor was closed were picked up by the engine's open (stat-cache rescan).
  log.info(`Agent review active: ${ctl.pendingFiles.length} file(s) pending.`);
}

export async function deactivate(): Promise<void> {
  controller?.dispose();
  await review?.close();
}

/** A URI passed by core in a command argument (revived or plain components). */
type CoreUri = vscode.Uri | { scheme: string; path: string };

function toUri(u: CoreUri): vscode.Uri {
  return u instanceof vscode.Uri ? u : vscode.Uri.from(u as vscode.Uri);
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
