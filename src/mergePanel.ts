import * as vscode from 'vscode';
import * as path from 'path';
import { MergeFileData } from './types.js';
import { GitService } from './gitService.js';

export class MergePanel {
  public static currentPanel: MergePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _data: MergeFileData;

  public static createOrShow(extensionUri: vscode.Uri, data: MergeFileData) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MergePanel.currentPanel) {
      MergePanel.currentPanel._panel.reveal(column);
      MergePanel.currentPanel.update(data);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'webstormMerge',
      `Merge: ${data.fileName}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    MergePanel.currentPanel = new MergePanel(panel, extensionUri, data);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, data: MergeFileData) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._data = data;

    this.update(data);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'saveAndStage': {
            const resolvedContent = message.content;
            const res = await GitService.saveAndStage(this._data.filePath, resolvedContent);
            if (res.success) {
              vscode.window.showInformationMessage(`[WebStorm Merge] ${res.message}`);
              if (res.remainingConflicts > 0) {
                const pick = await vscode.window.showInformationMessage(
                  `${res.remainingConflicts} conflicted file(s) remaining. Resolve next?`,
                  'Next File',
                  'Done'
                );
                if (pick === 'Next File') {
                  const gitRoot = await GitService.findGitRoot(this._data.filePath);
                  if (gitRoot) {
                    const conflicts = await GitService.getConflictedFiles(gitRoot);
                    if (conflicts.length > 0) {
                      const nextData = await GitService.loadMergeData(conflicts[0].fsPath);
                      this.update(nextData);
                      return;
                    }
                  }
                }
              }
              this._panel.dispose();
            } else {
              vscode.window.showErrorMessage(`[WebStorm Merge] ${res.message}`);
            }
            break;
          }
          case 'openExternalDiff': {
            vscode.commands.executeCommand('vscode.diff', 
              vscode.Uri.file(this._data.filePath),
              vscode.Uri.file(this._data.filePath),
              `Diff: ${this._data.fileName}`
            );
            break;
          }
          case 'info': {
            vscode.window.showInformationMessage(message.text);
            break;
          }
          case 'error': {
            vscode.window.showErrorMessage(message.text);
            break;
          }
        }
      },
      null,
      this._disposables
    );
  }

  public update(data: MergeFileData) {
    this._data = data;
    this._panel.title = `Merge: ${data.fileName}`;
    this._panel.webview.html = this._getHtmlForWebview(data);
  }

  public dispose() {
    MergePanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(data: MergeFileData): string {
    const rawDataJson = JSON.stringify(data).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebStorm Merge: ${data.fileName}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --border-color: var(--vscode-panel-border, #333333);
      --header-bg: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      --toolbar-bg: var(--vscode-sideBar-background, #1e1e20);
      --button-bg: var(--vscode-button-background, #0e639c);
      --button-fg: var(--vscode-button-foreground, #ffffff);
      --button-hover: var(--vscode-button-hoverBackground, #1177bb);
      --secondary-btn-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --secondary-btn-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --secondary-btn-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --accent-green: #388e3c;
      --accent-blue: #1976d2;
      --accent-red: #d32f2f;
      --accent-orange: #f57c00;
      --conflict-bg: rgba(239, 83, 80, 0.18);
      --conflict-border: #ef5350;
      --left-diff-bg: rgba(67, 160, 71, 0.15);
      --left-border: #43a047;
      --right-diff-bg: rgba(33, 150, 243, 0.15);
      --right-border: #2196f3;
      --font-code: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
      --font-size: var(--vscode-editor-font-size, 13px);
      --line-height: 20px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* TOP TOOLBAR - WebStorm Style */
    .toolbar {
      background: var(--toolbar-bg);
      border-bottom: 1px solid var(--border-color);
      padding: 8px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      user-select: none;
      box-shadow: 0 2px 4px rgba(0,0,0,0.15);
      z-index: 100;
      flex-wrap: wrap;
    }

    .toolbar-left, .toolbar-center, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .file-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: 13px;
      color: var(--fg);
      background: rgba(255, 255, 255, 0.05);
      padding: 4px 10px;
      border-radius: 4px;
      border: 1px solid var(--border-color);
    }

    .status-badge {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.3px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .status-badge.has-conflicts {
      background: var(--accent-orange);
      color: #fff;
    }

    .status-badge.all-resolved {
      background: var(--accent-green);
      color: #fff;
    }

    .btn {
      background: var(--secondary-btn-bg);
      color: var(--secondary-btn-fg);
      border: 1px solid rgba(255,255,255,0.08);
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 500;
      transition: all 0.15s ease;
      white-space: nowrap;
    }

    .btn:hover {
      background: var(--secondary-btn-hover);
    }

    .btn-primary {
      background: var(--button-bg);
      color: var(--button-fg);
      font-weight: 600;
    }

    .btn-primary:hover {
      background: var(--button-hover);
    }

    .btn-success {
      background: #2e7d32;
      color: #ffffff;
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }

    .btn-success:hover {
      background: #388e3c;
    }

    .btn-magic {
      background: linear-gradient(135deg, #7b1fa2, #512da8);
      color: #ffffff;
      font-weight: 600;
      border: 1px solid #9c27b0;
      box-shadow: 0 2px 5px rgba(123, 31, 162, 0.3);
    }

    .btn-magic:hover {
      background: linear-gradient(135deg, #8e24aa, #5e35b1);
    }

    .toggle-group {
      display: inline-flex;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      overflow: hidden;
    }

    .toggle-group .btn {
      border: none;
      border-radius: 0;
      padding: 5px 9px;
    }

    .toggle-group .btn.active {
      background: var(--button-bg);
      color: #fff;
    }

    /* MAIN EDITORS CONTAINER */
    .merge-body {
      flex: 1;
      display: flex;
      overflow: hidden;
      position: relative;
    }

    /* 3-Column Layout */
    .merge-body.layout-3col {
      flex-direction: row;
    }

    .merge-body.layout-3col .pane-left {
      width: 32%;
      border-right: 1px solid var(--border-color);
    }

    .merge-body.layout-3col .pane-center {
      width: 36%;
      border-right: 1px solid var(--border-color);
    }

    .merge-body.layout-3col .pane-right {
      width: 32%;
    }

    /* 2-Row Split Layout */
    .merge-body.layout-2row {
      flex-direction: column;
    }

    .merge-body.layout-2row .top-row {
      display: flex;
      flex-direction: row;
      height: 48%;
      border-bottom: 2px solid var(--border-color);
    }

    .merge-body.layout-2row .top-row .pane-left {
      width: 50%;
      border-right: 1px solid var(--border-color);
    }

    .merge-body.layout-2row .top-row .pane-right {
      width: 50%;
    }

    .merge-body.layout-2row .bottom-row {
      height: 52%;
      display: flex;
      flex-direction: column;
    }

    .merge-body.layout-2row .bottom-row .pane-center {
      width: 100%;
      height: 100%;
    }

    /* PANE COMMON */
    .editor-pane {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg);
      overflow: hidden;
    }

    .pane-header {
      background: var(--header-bg);
      border-bottom: 1px solid var(--border-color);
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      user-select: none;
    }

    .pane-header .badge {
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
    }

    .pane-left .badge {
      background: var(--left-border);
      color: #fff;
    }

    .pane-center .badge {
      background: var(--accent-orange);
      color: #fff;
    }

    .pane-right .badge {
      background: var(--right-border);
      color: #fff;
    }

    /* EDITOR SCROLL AREA */
    .pane-content {
      flex: 1;
      overflow: auto;
      display: flex;
      font-family: var(--font-code);
      font-size: var(--font-size);
      line-height: var(--line-height);
      position: relative;
    }

    /* Gutter and Line Numbers */
    .gutter {
      user-select: none;
      background: rgba(0, 0, 0, 0.12);
      border-right: 1px solid var(--border-color);
      padding: 8px 4px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground, #858585);
      font-size: 11px;
      min-width: 42px;
    }

    .line-number {
      height: var(--line-height);
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-right: 6px;
    }

    /* Action Gutter (WebStorm Arrow Buttons » « ✕) */
    .action-gutter {
      user-select: none;
      width: 48px;
      background: rgba(0, 0, 0, 0.08);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 8px;
    }

    .action-btn-slot {
      height: var(--line-height);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
    }

    .apply-btn {
      width: 20px;
      height: 18px;
      line-height: 18px;
      text-align: center;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 800;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.1s, opacity 0.1s;
    }

    .apply-btn:hover {
      transform: scale(1.15);
    }

    .apply-btn.apply-left {
      background: var(--accent-green);
    }

    .apply-btn.apply-right {
      background: var(--accent-blue);
    }

    .apply-btn.ignore-btn {
      background: #757575;
      font-size: 10px;
      margin-left: 2px;
    }

    .apply-btn.ignore-btn:hover {
      background: var(--accent-red);
    }

    /* Code View Area */
    .code-view {
      flex: 1;
      padding: 8px 0;
      white-space: pre;
      overflow-x: auto;
    }

    .code-line {
      height: var(--line-height);
      padding: 0 10px;
      display: flex;
      align-items: center;
    }

    .code-line.conflict-highlight {
      background-color: var(--conflict-bg);
      border-left: 3px solid var(--conflict-border);
    }

    .code-line.left-diff-highlight {
      background-color: var(--left-diff-bg);
      border-left: 3px solid var(--left-border);
    }

    .code-line.right-diff-highlight {
      background-color: var(--right-diff-bg);
      border-left: 3px solid var(--right-border);
    }

    .code-line.active-conflict {
      box-shadow: inset 0 0 0 1px var(--accent-orange);
    }

    /* Editable Textarea in Center Pane */
    .result-editor-wrapper {
      flex: 1;
      display: flex;
      position: relative;
    }

    .result-textarea {
      flex: 1;
      background: transparent;
      color: var(--fg);
      font-family: var(--font-code);
      font-size: var(--font-size);
      line-height: var(--line-height);
      padding: 8px 10px;
      border: none;
      outline: none;
      resize: none;
      white-space: pre;
      overflow: auto;
      tab-size: 2;
    }

    /* Conflict navigation indicator bar */
    .conflict-marker-label {
      background: var(--accent-orange);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 3px;
      margin-right: 6px;
      display: inline-block;
    }

    /* Keyboard help footer */
    .status-bar {
      background: var(--toolbar-bg);
      border-top: 1px solid var(--border-color);
      padding: 4px 14px;
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      color: #888;
      user-select: none;
    }

    .status-bar kbd {
      background: rgba(255,255,255,0.1);
      padding: 1px 5px;
      border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.15);
      color: var(--fg);
      font-family: var(--font-code);
    }
  </style>
</head>
<body>

  <!-- TOP TOOLBAR -->
  <div class="toolbar">
    <div class="toolbar-left">
      <div class="file-badge">
        <span>📄</span>
        <span id="lblFileName">${data.fileName}</span>
      </div>
      <div id="statusBadge" class="status-badge has-conflicts">
        <span id="conflictCountIcon">⚡</span>
        <span id="conflictCountText">Calculating...</span>
      </div>
      <div class="toggle-group" title="Navigate between conflict chunks">
        <button id="btnPrevConflict" class="btn" title="Previous Conflict (Shift+F7 or Alt+Up)">▲ Prev</button>
        <button id="btnNextConflict" class="btn" title="Next Conflict (F7 or Alt+Down)">▼ Next</button>
      </div>
    </div>

    <div class="toolbar-center">
      <button id="btnMagicWand" class="btn btn-magic" title="WebStorm Magic Wand: Automatically accept all non-conflicting changes from both sides">
        🪄 Magic Wand (Auto-Resolve)
      </button>
      <button id="btnAcceptAllLeft" class="btn" title="Accept all changes from Left (Ours)">
        »» Accept All Left
      </button>
      <button id="btnAcceptAllRight" class="btn" title="Accept all changes from Right (Theirs)">
        «« Accept All Right
      </button>
    </div>

    <div class="toolbar-right">
      <!-- Layout Switcher: 3-Col vs 2-Row -->
      <div class="toggle-group">
        <button id="btnLayout3Col" class="btn active" title="WebStorm Classic 3-Column Layout">⬌ 3-Column</button>
        <button id="btnLayout2Row" class="btn" title="2-Row Split Layout (Top: Compare, Bottom: Result)">⬍ 2-Row Split</button>
      </div>
      <button id="btnToggleSyncScroll" class="btn active" title="Toggle Synchronized Scrolling">
        🔗 Sync Scroll
      </button>
      <button id="btnSaveStage" class="btn btn-success" title="Save file and stage with 'git add' (Ctrl+S)">
        💾 Apply & Save (git add)
      </button>
    </div>
  </div>

  <!-- MAIN MERGE BODY -->
  <div id="mergeBody" class="merge-body layout-3col">
    <!-- LEFT PANE: OURS -->
    <div class="editor-pane pane-left" id="paneLeft">
      <div class="pane-header">
        <span id="titleLeft">${data.leftTitle}</span>
        <span class="badge">OURS (LOCAL)</span>
      </div>
      <div class="pane-content" id="scrollLeft">
        <div class="gutter" id="gutterLeft"></div>
        <div class="code-view" id="codeLeft"></div>
        <div class="action-gutter" id="actionGutterLeft" title="Apply to Result"></div>
      </div>
    </div>

    <!-- CENTER PANE: RESULT -->
    <div class="editor-pane pane-center" id="paneCenter">
      <div class="pane-header">
        <span>Result (Merged Output)</span>
        <span class="badge" style="background:#0e639c;">EDITABLE</span>
      </div>
      <div class="pane-content" id="scrollCenter">
        <div class="gutter" id="gutterCenter"></div>
        <div class="result-editor-wrapper">
          <textarea id="resultTextarea" class="result-textarea" spellcheck="false"></textarea>
        </div>
      </div>
    </div>

    <!-- RIGHT PANE: THEIRS -->
    <div class="editor-pane pane-right" id="paneRight">
      <div class="pane-header">
        <span id="titleRight">${data.rightTitle}</span>
        <span class="badge">THEIRS (INCOMING)</span>
      </div>
      <div class="pane-content" id="scrollRight">
        <div class="action-gutter" id="actionGutterRight" title="Apply to Result"></div>
        <div class="gutter" id="gutterRight"></div>
        <div class="code-view" id="codeRight"></div>
      </div>
    </div>
  </div>

  <!-- STATUS FOOTER -->
  <div class="status-bar">
    <div>
      Shortcuts: <kbd>F7</kbd> Next Conflict &nbsp;|&nbsp; <kbd>Shift+F7</kbd> Prev Conflict &nbsp;|&nbsp; <kbd>Ctrl+S</kbd> Save & git add
    </div>
    <div id="sourceTypeInfo">
      Source: ${data.sourceType === 'git-index' ? 'Git Index (3-Way Base/Ours/Theirs)' : 'Conflict Marker Parsing'}
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const rawData = ${rawDataJson};

    let state = {
      chunks: rawData.chunks || [],
      leftContent: rawData.leftContent || '',
      rightContent: rawData.rightContent || '',
      baseContent: rawData.baseContent || '',
      resultContent: rawData.initialResultContent || '',
      currentConflictIndex: 0,
      syncScroll: true,
      layout: '3col'
    };

    // DOM Elements
    const mergeBody = document.getElementById('mergeBody');
    const scrollLeft = document.getElementById('scrollLeft');
    const scrollCenter = document.getElementById('scrollCenter');
    const scrollRight = document.getElementById('scrollRight');

    const gutterLeft = document.getElementById('gutterLeft');
    const codeLeft = document.getElementById('codeLeft');
    const actionGutterLeft = document.getElementById('actionGutterLeft');

    const gutterRight = document.getElementById('gutterRight');
    const codeRight = document.getElementById('codeRight');
    const actionGutterRight = document.getElementById('actionGutterRight');

    const gutterCenter = document.getElementById('gutterCenter');
    const resultTextarea = document.getElementById('resultTextarea');

    const statusBadge = document.getElementById('statusBadge');
    const conflictCountText = document.getElementById('conflictCountText');
    const conflictCountIcon = document.getElementById('conflictCountIcon');

    // Buttons
    const btnLayout3Col = document.getElementById('btnLayout3Col');
    const btnLayout2Row = document.getElementById('btnLayout2Row');
    const btnToggleSyncScroll = document.getElementById('btnToggleSyncScroll');
    const btnMagicWand = document.getElementById('btnMagicWand');
    const btnAcceptAllLeft = document.getElementById('btnAcceptAllLeft');
    const btnAcceptAllRight = document.getElementById('btnAcceptAllRight');
    const btnPrevConflict = document.getElementById('btnPrevConflict');
    const btnNextConflict = document.getElementById('btnNextConflict');
    const btnSaveStage = document.getElementById('btnSaveStage');

    // Initialize UI
    function init() {
      resultTextarea.value = state.resultContent;
      renderPanes();
      updateConflictCount();
      setupScrollSync();
      setupEvents();
    }

    function renderPanes() {
      renderLeftPane();
      renderRightPane();
      renderCenterGutter();
    }

    function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function renderLeftPane() {
      const lines = state.leftContent.split('\\n');
      let gutterHtml = '';
      let codeHtml = '';
      let actionHtml = '';

      lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        gutterHtml += '<div class="line-number">' + lineNum + '</div>';

        // Check if line belongs to any conflict/diff chunk
        const chunk = state.chunks.find(c => lineNum >= c.leftStartLine && lineNum <= c.leftEndLine);
        let highlightClass = '';
        if (chunk) {
          highlightClass = chunk.type === 'conflict' ? 'conflict-highlight' : 'left-diff-highlight';
        }

        codeHtml += '<div class="code-line ' + highlightClass + '" id="left-line-' + lineNum + '">' + escapeHtml(line || ' ') + '</div>';

        // Add action button on the first line of the chunk
        if (chunk && lineNum === chunk.leftStartLine) {
          actionHtml += '<div class="action-btn-slot"><div class="apply-btn apply-left" title="Accept Left into Result" onclick="resolveChunk(\\'' + chunk.id + '\\', \\'left\\')">»</div><div class="apply-btn ignore-btn" title="Ignore change" onclick="resolveChunk(\\'' + chunk.id + '\\', \\'ignore\\')">✕</div></div>';
        } else {
          actionHtml += '<div class="action-btn-slot"></div>';
        }
      });

      gutterLeft.innerHTML = gutterHtml;
      codeLeft.innerHTML = codeHtml;
      actionGutterLeft.innerHTML = actionHtml;
    }

    function renderRightPane() {
      const lines = state.rightContent.split('\\n');
      let gutterHtml = '';
      let codeHtml = '';
      let actionHtml = '';

      lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        gutterHtml += '<div class="line-number">' + lineNum + '</div>';

        const chunk = state.chunks.find(c => lineNum >= c.rightStartLine && lineNum <= c.rightEndLine);
        let highlightClass = '';
        if (chunk) {
          highlightClass = chunk.type === 'conflict' ? 'conflict-highlight' : 'right-diff-highlight';
        }

        codeHtml += '<div class="code-line ' + highlightClass + '" id="right-line-' + lineNum + '">' + escapeHtml(line || ' ') + '</div>';

        if (chunk && lineNum === chunk.rightStartLine) {
          actionHtml += '<div class="action-btn-slot"><div class="apply-btn ignore-btn" title="Ignore change" onclick="resolveChunk(\\'' + chunk.id + '\\', \\'ignore\\')">✕</div><div class="apply-btn apply-right" title="Accept Right into Result" onclick="resolveChunk(\\'' + chunk.id + '\\', \\'right\\')">«</div></div>';
        } else {
          actionHtml += '<div class="action-btn-slot"></div>';
        }
      });

      gutterRight.innerHTML = gutterHtml;
      codeRight.innerHTML = codeHtml;
      actionGutterRight.innerHTML = actionHtml;
    }

    function renderCenterGutter() {
      const lines = resultTextarea.value.split('\\n');
      let gutterHtml = '';
      for (let i = 1; i <= lines.length; i++) {
        gutterHtml += '<div class="line-number">' + i + '</div>';
      }
      gutterCenter.innerHTML = gutterHtml;
    }

    // Resolve an individual chunk
    window.resolveChunk = function(chunkId, choice) {
      const chunk = state.chunks.find(c => c.id === chunkId);
      if (!chunk) return;

      chunk.resolved = true;
      chunk.chosen = choice;

      let chosenText = '';
      if (choice === 'left') {
        chosenText = chunk.leftContent;
      } else if (choice === 'right') {
        chosenText = chunk.rightContent;
      } else if (choice === 'both') {
        chosenText = (chunk.leftContent ? chunk.leftContent + '\\n' : '') + chunk.rightContent;
      } else if (choice === 'ignore') {
        chosenText = chunk.baseContent || '';
      }

      // Replace conflict block in Result Textarea
      let currentResult = resultTextarea.value;
      const markerPattern = new RegExp('\\\\/\\\\* CONFLICT #' + chunk.id.replace('chunk-', '') + ':[^\\\\*]+\\\\*\\\\/', 'g');

      if (markerPattern.test(currentResult)) {
        currentResult = currentResult.replace(markerPattern, chosenText);
      } else if (chunk.leftContent && currentResult.includes(chunk.leftContent)) {
        currentResult = currentResult.replace(chunk.leftContent, chosenText);
      } else if (chunk.rightContent && currentResult.includes(chunk.rightContent)) {
        currentResult = currentResult.replace(chunk.rightContent, chosenText);
      } else {
        // Fallback: append or notification
        currentResult = currentResult + '\\n' + chosenText;
      }

      resultTextarea.value = currentResult;
      renderCenterGutter();
      updateConflictCount();
    };

    // Magic Wand: Automatically resolve non-conflicting chunks
    function runMagicWand() {
      let resolvedCount = 0;
      state.chunks.forEach(chunk => {
        if (!chunk.resolved) {
          if (chunk.type === 'diff-left') {
            resolveChunk(chunk.id, 'left');
            resolvedCount++;
          } else if (chunk.type === 'diff-right') {
            resolveChunk(chunk.id, 'right');
            resolvedCount++;
          }
        }
      });
      vscode.postMessage({
        command: 'info',
        text: 'Magic Wand applied! ' + resolvedCount + ' non-conflicting change(s) resolved automatically.'
      });
    }

    function acceptAll(side) {
      state.chunks.forEach(chunk => {
        resolveChunk(chunk.id, side);
      });
      vscode.postMessage({
        command: 'info',
        text: 'Accepted all changes from ' + (side === 'left' ? 'Left (Ours)' : 'Right (Theirs)')
      });
    }

    function updateConflictCount() {
      // Count remaining conflicts from markers or unresolved chunk objects
      const markerMatches = (resultTextarea.value.match(/\\/\\* CONFLICT #\\d+/g) || []).length;
      const markerGitMatches = (resultTextarea.value.match(/<<<<<<<|=======|>>>>>>>/g) || []).length;
      const unresolvedChunks = state.chunks.filter(c => c.type === 'conflict' && !c.resolved).length;
      
      const count = Math.max(markerMatches, unresolvedChunks);

      if (count === 0 && markerGitMatches === 0) {
        statusBadge.className = 'status-badge all-resolved';
        conflictCountIcon.textContent = '✔';
        conflictCountText.textContent = 'All conflicts resolved!';
      } else {
        statusBadge.className = 'status-badge has-conflicts';
        conflictCountIcon.textContent = '⚡';
        conflictCountText.textContent = count + ' conflict' + (count > 1 ? 's' : '') + ' remaining';
      }
    }

    // Scroll Synchronization
    let isSyncing = false;
    function setupScrollSync() {
      const sync = (source, targets) => {
        if (!state.syncScroll || isSyncing) return;
        isSyncing = true;
        const ratio = source.scrollTop / (source.scrollHeight - source.clientHeight || 1);
        targets.forEach(target => {
          if (target) {
            target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
          }
        });
        setTimeout(() => { isSyncing = false; }, 20);
      };

      scrollLeft.addEventListener('scroll', () => sync(scrollLeft, [scrollCenter, scrollRight]));
      scrollRight.addEventListener('scroll', () => sync(scrollRight, [scrollLeft, scrollCenter]));
      resultTextarea.addEventListener('scroll', () => {
        gutterCenter.scrollTop = resultTextarea.scrollTop;
        sync(resultTextarea, [scrollLeft, scrollRight]);
      });
    }

    // Conflict Navigation
    function scrollToConflict(index) {
      if (state.chunks.length === 0) return;
      if (index < 0) index = state.chunks.length - 1;
      if (index >= state.chunks.length) index = 0;
      state.currentConflictIndex = index;

      const chunk = state.chunks[index];
      if (chunk) {
        const leftEl = document.getElementById('left-line-' + chunk.leftStartLine);
        if (leftEl) {
          leftEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }

    // Switch Layout: 3-Col vs 2-Row Split
    function setLayout(layout) {
      state.layout = layout;
      if (layout === '3col') {
        mergeBody.className = 'merge-body layout-3col';
        btnLayout3Col.classList.add('active');
        btnLayout2Row.classList.remove('active');
        // Restore standard structure if needed
        mergeBody.innerHTML = '';
        mergeBody.appendChild(document.getElementById('paneLeft'));
        mergeBody.appendChild(document.getElementById('paneCenter'));
        mergeBody.appendChild(document.getElementById('paneRight'));
      } else {
        mergeBody.className = 'merge-body layout-2row';
        btnLayout2Row.classList.add('active');
        btnLayout3Col.classList.remove('active');
        // Create 2-row layout wrapper
        mergeBody.innerHTML = '<div class="top-row" id="topRow"></div><div class="bottom-row" id="bottomRow"></div>';
        const topRow = document.getElementById('topRow');
        const bottomRow = document.getElementById('bottomRow');
        topRow.appendChild(document.getElementById('paneLeft'));
        topRow.appendChild(document.getElementById('paneRight'));
        bottomRow.appendChild(document.getElementById('paneCenter'));
      }
    }

    function setupEvents() {
      resultTextarea.addEventListener('input', () => {
        renderCenterGutter();
        updateConflictCount();
      });

      btnLayout3Col.addEventListener('click', () => setLayout('3col'));
      btnLayout2Row.addEventListener('click', () => setLayout('2row'));

      btnToggleSyncScroll.addEventListener('click', () => {
        state.syncScroll = !state.syncScroll;
        btnToggleSyncScroll.classList.toggle('active', state.syncScroll);
      });

      btnMagicWand.addEventListener('click', runMagicWand);
      btnAcceptAllLeft.addEventListener('click', () => acceptAll('left'));
      btnAcceptAllRight.addEventListener('click', () => acceptAll('right'));

      btnPrevConflict.addEventListener('click', () => scrollToConflict(state.currentConflictIndex - 1));
      btnNextConflict.addEventListener('click', () => scrollToConflict(state.currentConflictIndex + 1));

      btnSaveStage.addEventListener('click', () => {
        vscode.postMessage({
          command: 'saveAndStage',
          content: resultTextarea.value
        });
      });

      // Keyboard shortcuts
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          btnSaveStage.click();
        } else if (e.key === 'F7') {
          e.preventDefault();
          if (e.shiftKey) {
            scrollToConflict(state.currentConflictIndex - 1);
          } else {
            scrollToConflict(state.currentConflictIndex + 1);
          }
        } else if (e.altKey && e.key === 'ArrowDown') {
          e.preventDefault();
          scrollToConflict(state.currentConflictIndex + 1);
        } else if (e.altKey && e.key === 'ArrowUp') {
          e.preventDefault();
          scrollToConflict(state.currentConflictIndex - 1);
        }
      });
    }

    init();
  </script>
</body>
</html>`;
  }
}
