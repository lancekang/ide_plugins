import * as vscode from 'vscode';
import { GitService } from './gitService.js';
import { MergePanel } from './mergePanel.js';
import { hasGitConflictMarkers } from './diffEngine.js';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function activate(context: vscode.ExtensionContext) {
  const configuredGit = vscode.workspace.getConfiguration('git').get<string>('path');
  GitService.setGitExecutable(configuredGit);

  const resolveCurrentCmd = vscode.commands.registerCommand(
    'webstorm-merge.resolveCurrentFile',
    async (uri?: vscode.Uri) => {
      let targetPath: string | undefined;

      if (uri && uri.fsPath) {
        targetPath = uri.fsPath;
      } else if (vscode.window.activeTextEditor) {
        targetPath = vscode.window.activeTextEditor.document.uri.fsPath;
      }

      if (!targetPath) {
        await vscode.commands.executeCommand('webstorm-merge.scanAndResolve');
        return;
      }

      try {
        const mergeData = await GitService.loadMergeData(targetPath);
        MergePanel.createOrShow(context.extensionUri, mergeData);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to open WebStorm Merge GUI: ${errorText(err)}`);
      }
    }
  );

  const scanAndResolveCmd = vscode.commands.registerCommand(
    'webstorm-merge.scanAndResolve',
    async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }

      const allConflicts: Array<{ fsPath: string; relPath: string; fileName: string; folder: string }> = [];

      try {
        for (const folder of folders) {
          const gitRoot = await GitService.findGitRoot(folder.uri.fsPath);
          if (gitRoot) {
            const conflicts = await GitService.getConflictedFiles(gitRoot);
            allConflicts.push(...conflicts.map(item => ({ ...item, folder: folder.name })));
          }
        }
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to scan Git conflicts: ${errorText(err)}`);
        return;
      }

      if (allConflicts.length === 0) {
        vscode.window.showInformationMessage('No Git merge conflicts found in workspace.');
        return;
      }

      const items = allConflicts.map(item => ({
        label: `$(git-merge) ${item.fileName}`,
        description: item.relPath,
        detail: `Folder: ${item.folder}`,
        conflict: item
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Found ${allConflicts.length} conflicted file(s). Select one to resolve:`,
        matchOnDescription: true
      });

      if (!selected) {
        return;
      }

      try {
        const mergeData = await GitService.loadMergeData(selected.conflict.fsPath);
        MergePanel.createOrShow(context.extensionUri, mergeData);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to open WebStorm Merge GUI: ${errorText(err)}`);
      }
    }
  );

  const conflictStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  conflictStatusBarItem.command = 'webstorm-merge.resolveCurrentFile';

  const applyConflictContext = async (editor?: vscode.TextEditor) => {
    if (!editor || editor.document.isUntitled || editor.document.uri.scheme !== 'file') {
      conflictStatusBarItem.hide();
      await vscode.commands.executeCommand('setContext', 'webstormMerge.fileHasConflict', false);
      return;
    }

    const text = editor.document.getText();
    if (hasGitConflictMarkers(text)) {
      conflictStatusBarItem.text = '$(git-merge) WebStorm Merge';
      conflictStatusBarItem.tooltip = 'Open the 3-way merge view for this file';
      conflictStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      conflictStatusBarItem.show();
      await vscode.commands.executeCommand('setContext', 'webstormMerge.fileHasConflict', true);
    } else {
      conflictStatusBarItem.hide();
      await vscode.commands.executeCommand('setContext', 'webstormMerge.fileHasConflict', false);
    }
  };

  let conflictCheckTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleConflictCheck = (editor?: vscode.TextEditor) => {
    if (conflictCheckTimer) {
      clearTimeout(conflictCheckTimer);
    }
    conflictCheckTimer = setTimeout(() => {
      void applyConflictContext(editor);
    }, 200);
  };

  context.subscriptions.push(
    resolveCurrentCmd,
    scanAndResolveCmd,
    conflictStatusBarItem,
    vscode.window.onDidChangeActiveTextEditor(editor => {
      void applyConflictContext(editor);
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      const active = vscode.window.activeTextEditor;
      if (active && event.document === active.document) {
        scheduleConflictCheck(active);
      }
    }),
    new vscode.Disposable(() => {
      if (conflictCheckTimer) {
        clearTimeout(conflictCheckTimer);
      }
    })
  );

  void applyConflictContext(vscode.window.activeTextEditor);
}

export function deactivate() {}
