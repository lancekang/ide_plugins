import * as vscode from 'vscode';
import { GitService } from './gitService.js';
import { MergePanel } from './mergePanel.js';

export function activate(context: vscode.ExtensionContext) {
  // Command 1: Resolve current file or selected file
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
        // Fallback to scanning repo for conflicts
        vscode.commands.executeCommand('webstorm-merge.scanAndResolve');
        return;
      }

      try {
        const mergeData = await GitService.loadMergeData(targetPath);
        MergePanel.createOrShow(context.extensionUri, mergeData);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open WebStorm Merge GUI: ${err?.message || err}`);
      }
    }
  );

  // Command 2: Scan for all conflicts in workspace and let user pick
  const scanAndResolveCmd = vscode.commands.registerCommand(
    'webstorm-merge.scanAndResolve',
    async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }

      let allConflicts: Array<{ fsPath: string; relPath: string; fileName: string; folder: string }> = [];

      for (const folder of folders) {
        const gitRoot = await GitService.findGitRoot(folder.uri.fsPath);
        if (gitRoot) {
          const conflicts = await GitService.getConflictedFiles(gitRoot);
          allConflicts.push(...conflicts.map(c => ({ ...c, folder: folder.name })));
        }
      }

      if (allConflicts.length === 0) {
        vscode.window.showInformationMessage('No Git merge conflicts found in workspace! 🎉');
        return;
      }

      const items = allConflicts.map(c => ({
        label: `$(git-merge) ${c.fileName}`,
        description: c.relPath,
        detail: `Folder: ${c.folder}`,
        conflict: c
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Found ${allConflicts.length} conflicted file(s). Select one to resolve:`,
        matchOnDescription: true
      });

      if (selected) {
        const mergeData = await GitService.loadMergeData(selected.conflict.fsPath);
        MergePanel.createOrShow(context.extensionUri, mergeData);
      }
    }
  );

  // Status bar button when conflict markers are detected in active editor
  const conflictStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  conflictStatusBarItem.command = 'webstorm-merge.resolveCurrentFile';

  const checkConflictInActiveEditor = (editor?: vscode.TextEditor) => {
    if (!editor || editor.document.isUntitled) {
      conflictStatusBarItem.hide();
      return;
    }

    const text = editor.document.getText();
    if (text.includes('<<<<<<<') && text.includes('>>>>>>>')) {
      conflictStatusBarItem.text = `$(git-merge) WebStorm Merge (Conflicts Detected)`;
      conflictStatusBarItem.tooltip = 'Click to open WebStorm style 3-way merge conflict resolver';
      conflictStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      conflictStatusBarItem.show();
    } else {
      conflictStatusBarItem.hide();
    }
  };

  context.subscriptions.push(
    resolveCurrentCmd,
    scanAndResolveCmd,
    conflictStatusBarItem,
    vscode.window.onDidChangeActiveTextEditor(checkConflictInActiveEditor),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
        checkConflictInActiveEditor(vscode.window.activeTextEditor);
      }
    })
  );

  // Initial check
  checkConflictInActiveEditor(vscode.window.activeTextEditor);
}

export function deactivate() {}
