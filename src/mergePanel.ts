import * as vscode from 'vscode';
import * as fs from 'fs';
import { ConflictChunk, MergeBlock, MergeFileData } from './types.js';
import { describeUnresolved, serializeMerge } from './diffEngine.js';
import { highlightLine, languageFromFileName } from './highlight.js';
import { GitService } from './gitService.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asBlocks(value: unknown): MergeBlock[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const blocks: MergeBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return undefined;
    }
    const record = item as { kind?: unknown; lines?: unknown; chunkId?: unknown };
    if (record.kind !== 'context' && record.kind !== 'hunk') {
      return undefined;
    }
    if (!Array.isArray(record.lines) || record.lines.some(line => typeof line !== 'string')) {
      return undefined;
    }
    if (record.chunkId !== undefined && typeof record.chunkId !== 'string') {
      return undefined;
    }
    blocks.push({
      kind: record.kind,
      lines: record.lines,
      chunkId: record.chunkId
    });
  }
  return blocks;
}

function asChunks(value: unknown, original: ConflictChunk[]): ConflictChunk[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const incoming = new Map<string, string[]>();
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return undefined;
    }
    const record = item as { id?: unknown; resultLines?: unknown };
    if (typeof record.id !== 'string' || !Array.isArray(record.resultLines)) {
      return undefined;
    }
    if (record.resultLines.some(line => typeof line !== 'string')) {
      return undefined;
    }
    incoming.set(record.id, record.resultLines);
  }
  if (incoming.size !== original.length) {
    return undefined;
  }
  const next: ConflictChunk[] = [];
  for (const chunk of original) {
    const lines = incoming.get(chunk.id);
    if (!lines) {
      return undefined;
    }
    next.push({ ...chunk, resultLines: lines });
  }
  return next;
}

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
        switch (message?.command) {
          case 'saveAndStage':
            await this.saveFromWebview(message.blocks, message.chunks);
            break;
          case 'info':
            if (typeof message.text === 'string') {
              vscode.window.showInformationMessage(message.text);
            }
            break;
          case 'error':
            if (typeof message.text === 'string') {
              vscode.window.showErrorMessage(message.text);
            }
            break;
          default:
            break;
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
      const item = this._disposables.pop();
      if (item) {
        item.dispose();
      }
    }
  }

  private async saveFromWebview(rawBlocks: unknown, rawChunks: unknown) {
    const blocks = asBlocks(rawBlocks);
    const chunks = asChunks(rawChunks, this._data.chunks);
    if (!blocks || !chunks) {
      vscode.window.showErrorMessage('The merge view sent an unreadable result.');
      return;
    }

    let content: string;
    try {
      content = serializeMerge(blocks, chunks, this._data.eol, this._data.trailingNewline);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(errorText(err));
      return;
    }

    const unresolved = describeUnresolved(content);
    if (unresolved) {
      vscode.window.showErrorMessage(unresolved);
      return;
    }

    const allowed = await this.confirmOverwrite();
    if (!allowed) {
      return;
    }

    const res = await GitService.saveAndStage(this._data.filePath, content);
    if (!res.success) {
      vscode.window.showErrorMessage(`[WebStorm Merge] ${res.message}`);
      return;
    }

    vscode.window.showInformationMessage(`[WebStorm Merge] ${res.message}`);
    if (res.remainingConflicts > 0) {
      const pick = await vscode.window.showInformationMessage(
        `${res.remainingConflicts} conflicted file(s) remaining. Resolve next?`,
        'Next File',
        'Done'
      );
      if (pick === 'Next File') {
        try {
          const gitRoot = await GitService.findGitRoot(this._data.filePath);
          if (gitRoot) {
            const conflicts = await GitService.getConflictedFiles(gitRoot);
            if (conflicts.length > 0) {
              const nextData = await GitService.loadMergeData(conflicts[0].fsPath);
              this.update(nextData);
              return;
            }
          }
        } catch (err: unknown) {
          vscode.window.showErrorMessage(`Failed to open the next conflict: ${errorText(err)}`);
          return;
        }
      }
    }
    this._panel.dispose();
  }

  private async confirmOverwrite(): Promise<boolean> {
    if (!this._data.diskExisted) {
      return true;
    }
    let current: string | undefined;
    try {
      if (fs.existsSync(this._data.filePath)) {
        current = fs.readFileSync(this._data.filePath, 'utf8');
      }
    } catch {
      return true;
    }
    const changedSinceOpen = current !== undefined && current !== this._data.diskSnapshot;
    if (!this._data.manualResolution && !changedSinceOpen) {
      return true;
    }
    const reason = this._data.manualResolution
      ? 'The working tree has edits without conflict markers.'
      : 'The file changed on disk after this merge view opened.';
    const pick = await vscode.window.showWarningMessage(
      `${reason} Overwrite it and stage the merge result?`,
      { modal: true },
      'Overwrite'
    );
    return pick === 'Overwrite';
  }

  private _getHtmlForWebview(data: MergeFileData): string {
    const view = { ...data, diskSnapshot: undefined };
    const rawDataJson = JSON.stringify(view).replace(/</g, '\\u003c');
    const fileName = escapeHtml(data.fileName);
    const leftTitle = escapeHtml(data.leftTitle);
    const rightTitle = escapeHtml(data.rightTitle);
    const baseTitle = escapeHtml(data.baseTitle);
    const sourceLabel = data.sourceType === 'git-index'
      ? 'Git index (base / ours / theirs)'
      : 'Conflict marker parsing';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebStorm Merge: ${fileName}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border-color: var(--vscode-panel-border, transparent);
      --header-bg: var(--vscode-editorGroupHeader-tabsBackground);
      --toolbar-bg: var(--vscode-sideBar-background);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --secondary-btn-bg: var(--vscode-button-secondaryBackground);
      --secondary-btn-fg: var(--vscode-button-secondaryForeground);
      --secondary-btn-hover: var(--vscode-button-secondaryHoverBackground);
      --focus: var(--vscode-focusBorder);
      --font-code: var(--vscode-editor-font-family, Consolas, monospace);
      --font-size: var(--vscode-editor-font-size, 13px);
      --ours: var(--vscode-gitDecoration-addedResourceForeground);
      --theirs: var(--vscode-gitDecoration-modifiedResourceForeground);
      --conflict: var(--vscode-editorWarning-foreground);
      --muted: var(--vscode-descriptionForeground);
      --line-bg: var(--vscode-editor-background);
      --ours-bg: var(--vscode-diffEditor-insertedLineBackground, var(--vscode-diffEditor-insertedTextBackground));
      --theirs-bg: var(--vscode-editor-selectionHighlightBackground, var(--vscode-diffEditor-diagonalFill));
      --conflict-bg: var(--vscode-diffEditor-removedLineBackground, var(--vscode-diffEditor-removedTextBackground));
      --row-h: 20px;
      --action-h: 28px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 13px;
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .banner {
      padding: 8px 14px;
      background: var(--vscode-inputValidation-warningBackground);
      color: var(--vscode-inputValidation-warningForeground, var(--fg));
      border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, var(--border-color));
    }

    .toolbar {
      background: var(--toolbar-bg);
      border-bottom: 1px solid var(--border-color);
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    .toolbar-left, .toolbar-center, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .file-badge, .status-badge {
      padding: 3px 8px;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      font-size: 12px;
    }

    .status-badge.has-conflicts { color: var(--conflict); }
    .status-badge.all-resolved { color: var(--ours); }

    button {
      font: inherit;
      color: inherit;
    }

    .btn {
      background: var(--secondary-btn-bg);
      color: var(--secondary-btn-fg);
      border: 1px solid transparent;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .btn:hover { background: var(--secondary-btn-hover); }
    .btn:focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }

    .btn-primary {
      background: var(--button-bg);
      color: var(--button-fg);
    }

    .btn-primary:hover { background: var(--button-hover); }

    .toggle-group { display: inline-flex; border: 1px solid var(--border-color); border-radius: 4px; overflow: hidden; }
    .toggle-group .btn { border-radius: 0; }
    .toggle-group .btn.active { background: var(--button-bg); color: var(--button-fg); }

    .merge-body {
      flex: 1;
      min-height: 0;
      display: grid;
    }

    .layout-3col {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr) minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
      grid-template-areas: "left center right";
    }

    .layout-2row {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) minmax(0, 1.1fr);
      grid-template-areas:
        "left right"
        "center center";
    }

    .pane-left { grid-area: left; }
    .pane-center { grid-area: center; }
    .pane-right { grid-area: right; }

    .layout-3col .pane-left,
    .layout-3col .pane-center,
    .layout-2row .pane-left { border-right: 1px solid var(--border-color); }
    .layout-2row .pane-center { border-top: 1px solid var(--border-color); }

    .editor-pane {
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--bg);
    }

    .pane-header {
      background: var(--header-bg);
      border-bottom: 1px solid var(--border-color);
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 650;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .pane-header .tag { color: var(--muted); font-weight: 500; }

    .pane-scroll {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: auto;
    }

    .block { width: 100%; }
    .block.active { outline: 1px solid var(--focus); outline-offset: -1px; }

    .hunk-actions {
      height: var(--action-h);
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 6px;
      border-bottom: 1px solid var(--border-color);
      background: var(--header-bg);
    }

    .hunk.conflict { background: var(--conflict-bg); }
    .hunk.diff-left { background: var(--ours-bg); }
    .hunk.diff-right { background: var(--theirs-bg); }
    .hunk.pickable { cursor: pointer; }
    .hunk.side-left.picked {
      background: var(--ours-bg);
      box-shadow: inset 0 0 0 2px var(--ours, var(--focus));
    }
    .hunk.side-right.picked {
      background: var(--theirs-bg);
      box-shadow: inset 0 0 0 2px var(--theirs, var(--focus));
    }
    .hunk.dimmed { opacity: 0.55; }
    .hunk-actions .btn.active {
      background: var(--button-bg);
      color: var(--button-fg);
      box-shadow: inset 0 0 0 1px var(--focus);
    }

    .code-line, .result-area, #lineProbe {
      font-family: var(--font-code);
      font-size: var(--font-size);
      line-height: var(--row-h);
      font-variant-ligatures: none;
      font-feature-settings: "liga" 0, "calt" 0;
    }

    .code-line {
      height: var(--row-h);
      white-space: pre;
      padding: 0 8px;
      overflow: hidden;
    }

    .code-line span { line-height: inherit; }

    .code-line.pad { color: var(--muted); }

    .result-editor {
      position: relative;
      width: 100%;
      overflow: hidden;
    }

    .result-hl, .result-area {
      display: block;
      width: 100%;
      margin: 0;
      border: 0;
      tab-size: 2;
      overflow: hidden;
    }

    .result-hl {
      position: absolute;
      inset: 0;
      padding: 0;
      pointer-events: none;
      color: var(--fg);
    }

    .result-area {
      position: absolute;
      inset: 0;
      padding: 0 8px;
      white-space: pre;
      resize: none;
      background: transparent;
      color: transparent;
      caret-color: var(--fg);
    }

    .result-area:focus { outline: none; }

    .result-area::selection {
      background: var(--vscode-editor-selectionBackground);
      color: transparent;
    }

    .fold-btn {
      display: block;
      width: 100%;
      height: var(--row-h);
      line-height: var(--row-h);
      text-align: center;
      background: var(--header-bg);
      color: var(--muted);
      border: 0;
      border-top: 1px solid var(--border-color);
      border-bottom: 1px solid var(--border-color);
      cursor: pointer;
      font-size: 11px;
    }

    .tok-keyword { color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-textLink-foreground)); }
    .tok-string { color: var(--vscode-debugTokenExpression-string, var(--vscode-charts-orange)); }
    .tok-number { color: var(--vscode-debugTokenExpression-number, var(--vscode-charts-green)); }
    .tok-comment { color: var(--vscode-descriptionForeground); }
    .tok-sentinel { color: var(--vscode-editorWarning-foreground); }

    .status-bar {
      border-top: 1px solid var(--border-color);
      background: var(--toolbar-bg);
      color: var(--muted);
      padding: 4px 12px;
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    kbd {
      font-family: var(--font-code);
      border: 1px solid var(--border-color);
      padding: 0 4px;
      border-radius: 3px;
    }

    #lineProbe {
      position: absolute;
      visibility: hidden;
      white-space: pre;
      height: auto;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div id="lineProbe">x</div>
  <div id="banner" class="banner" hidden></div>
  <div class="toolbar">
    <div class="toolbar-left">
      <div class="file-badge" id="lblFileName">${fileName}</div>
      <div id="statusBadge" class="status-badge has-conflicts">Checking conflicts</div>
      <div class="toggle-group">
        <button id="btnPrevConflict" class="btn" type="button" title="Previous unresolved conflict">Prev</button>
        <button id="btnNextConflict" class="btn" type="button" title="Next unresolved conflict">Next</button>
      </div>
    </div>
    <div class="toolbar-center">
      <button id="btnMagicWand" class="btn" type="button" title="Re-apply every one-sided change">Apply non-conflicts</button>
      <button id="btnAcceptAllLeft" class="btn" type="button">Accept all ours</button>
      <button id="btnAcceptAllRight" class="btn" type="button">Accept all theirs</button>
      <button id="btnShowBase" class="btn" type="button" title="Show the common ancestor inside each change">Base</button>
    </div>
    <div class="toolbar-right">
      <div class="toggle-group">
        <button id="btnLayout3Col" class="btn active" type="button">3 columns</button>
        <button id="btnLayout2Row" class="btn" type="button">2 rows</button>
      </div>
      <button id="btnToggleSyncScroll" class="btn active" type="button">Sync scroll</button>
      <button id="btnSaveStage" class="btn btn-primary" type="button">Apply and stage</button>
    </div>
  </div>
  <div id="mergeBody" class="merge-body layout-3col">
    <section class="editor-pane pane-left">
      <div class="pane-header"><span id="titleLeft">${leftTitle}</span><span class="tag">Ours</span></div>
      <div class="pane-scroll" id="scrollLeft"></div>
    </section>
    <section class="editor-pane pane-center">
      <div class="pane-header"><span>Result</span><span class="tag">${baseTitle}</span></div>
      <div class="pane-scroll" id="scrollCenter"></div>
    </section>
    <section class="editor-pane pane-right">
      <div class="pane-header"><span id="titleRight">${rightTitle}</span><span class="tag">Theirs</span></div>
      <div class="pane-scroll" id="scrollRight"></div>
    </section>
  </div>
  <div class="status-bar">
    <div><kbd>F7</kbd> next <kbd>Shift+F7</kbd> previous <kbd>Alt+1</kbd> ours <kbd>Alt+2</kbd> theirs <kbd>Alt+3</kbd> both <kbd>Alt+4</kbd> base <kbd>Ctrl+S</kbd> stage</div>
    <div>${escapeHtml(sourceLabel)}</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const rawData = ${rawDataJson};
    const ACTION = 28;
    const FOLD_AT = 12;
    const FOLD_EDGE = 3;
    const LINE_WINDOW = 80;
    const HIGHLIGHT_MAX = 800;
    const lang = ${JSON.stringify(languageFromFileName(data.fileName))};
    const highlightLine = ${highlightLine.toString()};

    const state = {
      chunks: rawData.chunks || [],
      blocks: rawData.blocks || [],
      eol: rawData.eol === '\\r\\n' ? '\\r\\n' : '\\n',
      trailingNewline: !!rawData.trailingNewline,
      syncScroll: true,
      showBase: false,
      currentId: ''
    };
    state.blocks.forEach(function (block) {
      if (block.kind === 'context' && block.lines.length > FOLD_AT) block.folded = true;
    });

    const mergeBody = document.getElementById('mergeBody');
    const scrollLeft = document.getElementById('scrollLeft');
    const scrollCenter = document.getElementById('scrollCenter');
    const scrollRight = document.getElementById('scrollRight');
    const statusBadge = document.getElementById('statusBadge');
    const banner = document.getElementById('banner');
    const btnLayout3Col = document.getElementById('btnLayout3Col');
    const btnLayout2Row = document.getElementById('btnLayout2Row');
    const btnToggleSyncScroll = document.getElementById('btnToggleSyncScroll');
    let rowH = 20;
    let isSyncing = false;

    function chunkById(id) {
      return state.chunks.find(function (chunk) { return chunk.id === id; });
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function isSentinelLine(line) {
      return /^<<<<<<< WMERGE \\S+ >>>>>>>$/.test(line);
    }

    function splitContent(text) {
      if (!text) return [];
      return String(text).split('\\n');
    }

    function linesOf(block) {
      if (block.kind === 'context') return block.lines;
      const chunk = chunkById(block.chunkId);
      return chunk ? chunk.resultLines : [];
    }

    function highlightText(text) {
      const lines = String(text || '').split('\\n');
      const color = lines.length <= HIGHLIGHT_MAX;
      return lines.map(function (line) {
        const body = color ? highlightLine(line, lang) : escapeHtml(line || ' ');
        return '<div class="code-line">' + body + '</div>';
      }).join('');
    }

    function chunkOf(block) {
      return block && block.chunkId ? chunkById(block.chunkId) : null;
    }

    function isFoldable(block) {
      return block.kind === 'context' && block.lines.length > FOLD_AT;
    }

    function contentRows(block) {
      if (block.kind === 'context') {
        if (block.folded && isFoldable(block)) return FOLD_EDGE * 2;
        return Math.max(block.lines.length, 1);
      }
      const chunk = chunkOf(block);
      if (!chunk) return 1;
      return Math.max(
        splitContent(chunk.leftContent).length,
        splitContent(chunk.rightContent).length,
        chunk.resultLines.length,
        1
      );
    }

    function baseSectionRows(block) {
      if (!state.showBase || block.kind !== 'hunk') return 0;
      const chunk = chunkOf(block);
      const count = chunk ? splitContent(chunk.baseContent).length : 0;
      return 1 + Math.max(count, 1);
    }

    function blockPixelHeight(block) {
      let rows = contentRows(block) + baseSectionRows(block);
      if (isFoldable(block)) rows += 1;
      const action = block.kind === 'hunk' ? ACTION : 0;
      return action + rows * rowH;
    }

    function linesTop(block, blockTop) {
      let top = blockTop;
      if (block.kind === 'hunk') top += ACTION + baseSectionRows(block) * rowH;
      if (isFoldable(block) && !(block.folded)) top += rowH;
      return top;
    }

    function collectLines() {
      const lines = [];
      state.blocks.forEach(function (block) {
        lines.push.apply(lines, linesOf(block));
      });
      return lines;
    }

    function hasGitMarkers(lines) {
      let start = false;
      let middle = false;
      let end = false;
      lines.forEach(function (line) {
        if (isSentinelLine(line)) return;
        if (/^<{7} /.test(line)) start = true;
        else if (/^={7}$/.test(line)) middle = true;
        else if (/^>{7} /.test(line)) end = true;
      });
      return start && middle && end;
    }

    function unresolvedIds() {
      return state.chunks.filter(function (chunk) {
        return chunk.type === 'conflict' && chunk.resultLines.some(isSentinelLine);
      }).map(function (chunk) { return chunk.id; });
    }

    function updateConflictCount() {
      const open = unresolvedIds();
      const git = hasGitMarkers(collectLines());
      if (open.length === 0 && !git) {
        statusBadge.className = 'status-badge all-resolved';
        statusBadge.textContent = 'All conflicts resolved';
        document.getElementById('btnSaveStage').textContent = 'Apply and stage';
      } else if (open.length > 0) {
        statusBadge.className = 'status-badge has-conflicts';
        statusBadge.textContent = open.length + ' unresolved';
        document.getElementById('btnSaveStage').textContent = 'Apply and stage (' + open.length + ' left)';
      } else {
        statusBadge.className = 'status-badge has-conflicts';
        statusBadge.textContent = 'Git conflict markers remain';
        document.getElementById('btnSaveStage').textContent = 'Apply and stage';
      }
    }

    function sideLines(chunk, side) {
      if (side === 'left') return splitContent(chunk.leftContent);
      if (side === 'right') return splitContent(chunk.rightContent);
      return splitContent(chunk.baseContent);
    }

    function rowWindow(totalRows, blockTop, scrollTop, viewHeight) {
      const overscan = 30;
      const first = Math.floor((scrollTop - blockTop) / rowH) - overscan;
      const count = Math.ceil((viewHeight || rowH) / rowH) + overscan * 2;
      const start = Math.max(0, Math.min(totalRows, first));
      const end = Math.max(start, Math.min(totalRows, first + count));
      return {
        start: start,
        end: end,
        topPad: start * rowH,
        bottomPad: (totalRows - end) * rowH
      };
    }

    function renderPlainLines(lines, rows, emptyLabel, windowed, blockTop, scrollTop, viewHeight) {
      const total = Math.max(rows, 1);
      let start = 0;
      let end = total;
      let topPad = 0;
      let bottomPad = 0;
      if (windowed && total > LINE_WINDOW && viewHeight) {
        const win = rowWindow(total, blockTop, scrollTop, viewHeight);
        start = win.start;
        end = win.end;
        topPad = win.topPad;
        bottomPad = win.bottomPad;
      }
      let html = topPad ? '<div style="height:' + topPad + 'px"></div>' : '';
      for (let i = start; i < end; i++) {
        if (i < lines.length) {
          html += '<div class="code-line">' + highlightLine(lines[i].length ? lines[i] : ' ', lang) + '</div>';
        } else if (i === 0 && lines.length === 0) {
          html += '<div class="code-line pad">' + escapeHtml(emptyLabel) + '</div>';
        } else {
          html += '<div class="code-line"></div>';
        }
      }
      if (bottomPad) html += '<div style="height:' + bottomPad + 'px"></div>';
      return html;
    }

    function foldButton(block, index) {
      if (!isFoldable(block)) return '';
      const hidden = block.lines.length - FOLD_EDGE * 2;
      const label = block.folded ? ('Show ' + hidden + ' unchanged lines') : 'Collapse unchanged lines';
      return '<button type="button" class="fold-btn" data-fold="' + index + '">' + label + '</button>';
    }

    function baseSection(block, scrollTop, viewHeight, blockTop) {
      if (!baseSectionRows(block)) return '';
      const chunk = chunkOf(block);
      const lines = chunk ? splitContent(chunk.baseContent) : [];
      const top = blockTop + (block.kind === 'hunk' ? ACTION : 0);
      return '<div class="code-line pad">Base</div>' +
        renderPlainLines(lines, Math.max(lines.length, 1), 'no base', true, top + rowH, scrollTop, viewHeight);
    }

    function hunkClass(chunk) {
      return 'block hunk ' + (chunk ? chunk.type : 'conflict') + (chunk && state.currentId === chunk.id ? ' active' : '');
    }

    function resultBox(index, text, height) {
      const rows = textareaToLines(text).length;
      return '<div class="result-editor" data-block="' + index + '" style="height:' + height + 'px">' +
        '<div class="result-hl">' + highlightText(text) + '</div>' +
        '<textarea class="result-area" data-block="' + index + '" data-rows="' + rows + '" spellcheck="false">' +
        escapeHtml(text) + '</textarea></div>';
    }

    function contextBody(block, index, scrollTop, viewHeight, blockTop, editable) {
      if (block.folded && isFoldable(block)) {
        const top = block.lines.slice(0, FOLD_EDGE);
        const bottom = block.lines.slice(block.lines.length - FOLD_EDGE);
        return renderPlainLines(top, FOLD_EDGE, '', false, 0, 0, 0) +
          foldButton(block, index) +
          renderPlainLines(bottom, FOLD_EDGE, '', false, 0, 0, 0);
      }
      const lineTop = linesTop(block, blockTop);
      const linesHtml = '<div class="line-window" data-block="' + index + '" data-side="context">' +
        renderPlainLines(block.lines, contentRows(block), '', true, lineTop, scrollTop, viewHeight) +
        '</div>';
      if (!editable) {
        return foldButton(block, index) + linesHtml;
      }
      return foldButton(block, index) + resultBox(index, block.lines.join('\\n'), contentRows(block) * rowH);
    }

    function isSidePicked(chunk, side) {
      if (!chunk) return false;
      if (chunk.chosen === 'both') return true;
      return chunk.chosen === side;
    }

    function sideMark(chunk, side) {
      if (!chunk || chunk.chosen === 'none' || chunk.chosen === 'custom') return '';
      return isSidePicked(chunk, side) ? ' picked' : ' dimmed';
    }

    function choiceButton(label, act, id, on) {
      return '<button type="button" class="btn' + (on ? ' active' : '') + '" data-act="' + act + '" data-id="' + id + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + label + '</button>';
    }

    function renderSideBlock(side, block, index, scrollTop, viewHeight, blockTop) {
      const height = blockPixelHeight(block);
      if (block.kind === 'context') {
        return '<div class="block" data-block="' + index + '" style="height:' + height + 'px">' +
          contextBody(block, index, scrollTop, viewHeight, blockTop, false) + '</div>';
      }
      const chunk = chunkOf(block);
      const lines = chunk ? sideLines(chunk, side) : [];
      const label = side === 'left' ? 'Ours' : 'Theirs';
      const act = side === 'left' ? 'left' : 'right';
      const id = chunk ? chunk.id : '';
      const lineTop = linesTop(block, blockTop);
      const sideClass = side === 'left' ? ' side-left' : ' side-right';
      return '<div class="' + hunkClass(chunk) + sideClass + sideMark(chunk, side) + ' pickable" data-act="' + act + '" data-id="' + id + '" data-block="' + index + '" data-chunk="' + id + '" style="height:' + height + 'px">' +
        '<div class="hunk-actions">' + choiceButton(label, act, id, isSidePicked(chunk, side)) + '</div>' +
        baseSection(block, scrollTop, viewHeight, blockTop) +
        '<div class="line-window" data-block="' + index + '" data-side="' + side + '">' +
        renderPlainLines(lines, contentRows(block), 'no lines', true, lineTop, scrollTop, viewHeight) +
        '</div></div>';
    }

    function renderCenterBlock(block, index, scrollTop, viewHeight, blockTop) {
      const height = blockPixelHeight(block);
      if (block.kind === 'context') {
        return '<div class="block" data-block="' + index + '" style="height:' + height + 'px">' +
          contextBody(block, index, scrollTop, viewHeight, blockTop, true) + '</div>';
      }
      const chunk = chunkOf(block);
      if (!chunk) {
        return '<div class="block" data-block="' + index + '" style="height:' + height + 'px"></div>';
      }
      return '<div class="' + hunkClass(chunk) + '" data-block="' + index + '" data-chunk="' + chunk.id + '" style="height:' + height + 'px">' +
        '<div class="hunk-actions">' +
        choiceButton('Both', 'both', chunk.id, chunk.chosen === 'both') +
        choiceButton('Base', 'base', chunk.id, chunk.chosen === 'base') +
        '</div>' +
        baseSection(block, scrollTop, viewHeight, blockTop) +
        resultBox(index, chunk.resultLines.join('\\n'), contentRows(block) * rowH) +
        '</div>';
    }

    function measureLayout() {
      const boxes = [];
      let top = 0;
      for (let i = 0; i < state.blocks.length; i++) {
        const height = blockPixelHeight(state.blocks[i]);
        boxes.push({ index: i, top: top, height: height });
        top += height;
      }
      return { boxes: boxes, total: top };
    }

    function blockRange(scrollTop, viewHeight, layout) {
      if (!viewHeight || layout.total <= viewHeight + 1200) {
        return { start: 0, end: layout.boxes.length, topSpacer: 0, bottomSpacer: 0 };
      }
      const y0 = Math.max(0, scrollTop - 600);
      const y1 = scrollTop + viewHeight + 600;
      let start = 0;
      let end = layout.boxes.length;
      for (let i = 0; i < layout.boxes.length; i++) {
        const box = layout.boxes[i];
        if (box.top + box.height < y0) start = i + 1;
        if (box.top > y1) {
          end = i;
          break;
        }
      }
      if (start > end) start = end;
      const topSpacer = start < layout.boxes.length ? layout.boxes[start].top : layout.total;
      const bottomSpacer = end > 0
        ? layout.total - (layout.boxes[end - 1].top + layout.boxes[end - 1].height)
        : 0;
      return { start: start, end: end, topSpacer: topSpacer, bottomSpacer: bottomSpacer };
    }

    function renderPane(side, scroller, layout) {
      const view = scroller.clientHeight || 0;
      const range = blockRange(scroller.scrollTop, view, layout);
      let html = '<div class="spacer" style="height:' + range.topSpacer + 'px"></div>';
      for (let i = range.start; i < range.end; i++) {
        const box = layout.boxes[i];
        const block = state.blocks[box.index];
        html += side === 'center'
          ? renderCenterBlock(block, box.index, scroller.scrollTop, view, box.top)
          : renderSideBlock(side, block, box.index, scroller.scrollTop, view, box.top);
      }
      html += '<div class="spacer" style="height:' + range.bottomSpacer + 'px"></div>';
      return html;
    }

    function rangeKey(scroller, layout) {
      const range = blockRange(scroller.scrollTop, scroller.clientHeight || 0, layout);
      return range.start + ':' + range.end;
    }

    function captureFocus() {
      const active = document.activeElement;
      if (!active || !active.getAttribute || !active.classList || !active.classList.contains('result-area')) return null;
      return {
        block: active.getAttribute('data-block'),
        start: active.selectionStart,
        end: active.selectionEnd
      };
    }

    function restoreFocus(saved) {
      if (!saved) return;
      const area = scrollCenter.querySelector('textarea[data-block="' + saved.block + '"]');
      if (!area) return;
      area.focus();
      area.selectionStart = saved.start;
      area.selectionEnd = saved.end;
    }

    let builtRange = '';

    function refreshLineWindows() {
      const layout = measureLayout();
      document.querySelectorAll('.line-window').forEach(function (el) {
        const index = Number(el.getAttribute('data-block'));
        const side = el.getAttribute('data-side');
        const pane = el.closest('.pane-scroll');
        const box = layout.boxes[index];
        const block = state.blocks[index];
        if (!pane || !box || !block) return;
        let lines = block.lines;
        if (side === 'left' || side === 'right') {
          const chunk = chunkOf(block);
          lines = chunk ? sideLines(chunk, side) : [];
        }
        el.innerHTML = renderPlainLines(
          lines,
          contentRows(block),
          side === 'context' ? '' : 'no lines',
          true,
          linesTop(block, box.top),
          pane.scrollTop,
          pane.clientHeight || 0
        );
      });
    }

    function render() {
      const focus = captureFocus();
      const layout = measureLayout();
      const tops = [scrollLeft.scrollTop, scrollCenter.scrollTop, scrollRight.scrollTop];
      isSyncing = true;
      scrollLeft.innerHTML = renderPane('left', scrollLeft, layout);
      scrollRight.innerHTML = renderPane('right', scrollRight, layout);
      scrollCenter.innerHTML = renderPane('center', scrollCenter, layout);
      scrollLeft.scrollTop = tops[0];
      scrollCenter.scrollTop = tops[1];
      scrollRight.scrollTop = tops[2];
      isSyncing = false;
      builtRange = rangeKey(scrollLeft, layout) + '|' + rangeKey(scrollCenter, layout) + '|' + rangeKey(scrollRight, layout);
      restoreFocus(focus);
      updateConflictCount();
    }

    function renderIfRangeChanged() {
      const layout = measureLayout();
      const key = rangeKey(scrollLeft, layout) + '|' + rangeKey(scrollCenter, layout) + '|' + rangeKey(scrollRight, layout);
      if (key === builtRange) {
        refreshLineWindows();
        return;
      }
      render();
    }

    function textareaToLines(value) {
      if (value === '') return [];
      return value.split('\\n');
    }

    function currentConflictId() {
      if (state.currentId && unresolvedIds().indexOf(state.currentId) >= 0) return state.currentId;
      const open = unresolvedIds();
      return open.length ? open[0] : (state.chunks[0] ? state.chunks[0].id : '');
    }

    function resolveChunk(id, choice) {
      const chunk = chunkById(id);
      if (!chunk || !choice) return;
      if (choice === 'left') chunk.resultLines = splitContent(chunk.leftContent);
      else if (choice === 'right') chunk.resultLines = splitContent(chunk.rightContent);
      else if (choice === 'both') chunk.resultLines = splitContent(chunk.leftContent).concat(splitContent(chunk.rightContent));
      else if (choice === 'base') chunk.resultLines = splitContent(chunk.baseContent);
      else return;
      chunk.resolved = !chunk.resultLines.some(isSentinelLine);
      chunk.chosen = choice;
      state.currentId = id;
      render();
    }

    function applyNonConflicts() {
      let count = 0;
      state.chunks.forEach(function (chunk) {
        if (chunk.type === 'diff-left') {
          chunk.resultLines = splitContent(chunk.leftContent);
          chunk.resolved = true;
          chunk.chosen = 'left';
          count++;
        } else if (chunk.type === 'diff-right') {
          chunk.resultLines = splitContent(chunk.rightContent);
          chunk.resolved = true;
          chunk.chosen = 'right';
          count++;
        }
      });
      render();
      vscode.postMessage({
        command: 'info',
        text: 'Applied ' + count + ' non-conflicting change(s). ' + unresolvedIds().length + ' conflict(s) still need a choice.'
      });
    }

    function acceptAll(side) {
      state.chunks.forEach(function (chunk) {
        chunk.resultLines = splitContent(side === 'left' ? chunk.leftContent : chunk.rightContent);
        chunk.resolved = !chunk.resultLines.some(isSentinelLine);
        chunk.chosen = side;
      });
      render();
    }

    function jump(delta) {
      const ids = unresolvedIds();
      if (ids.length === 0) return;
      let index = ids.indexOf(state.currentId);
      if (index < 0) index = delta > 0 ? -1 : 0;
      index = (index + delta + ids.length) % ids.length;
      state.currentId = ids[index];
      const blockIndex = state.blocks.findIndex(function (block) { return block.chunkId === state.currentId; });
      const layout = measureLayout();
      const top = layout.boxes[blockIndex] ? layout.boxes[blockIndex].top : 0;
      isSyncing = true;
      scrollLeft.scrollTop = top;
      scrollCenter.scrollTop = top;
      scrollRight.scrollTop = top;
      isSyncing = false;
      render();
    }

    function save() {
      vscode.postMessage({
        command: 'saveAndStage',
        blocks: state.blocks,
        chunks: state.chunks.map(function (chunk) {
          return { id: chunk.id, resultLines: chunk.resultLines };
        })
      });
    }

    function bindScroll(source, targets) {
      source.addEventListener('scroll', function () {
        if (isSyncing) return;
        if (state.syncScroll) {
          isSyncing = true;
          targets.forEach(function (target) { target.scrollTop = source.scrollTop; });
          isSyncing = false;
        }
        renderIfRangeChanged();
      });
    }

    function init() {
      const probe = document.getElementById('lineProbe');
      const measured = Math.round(probe.getBoundingClientRect().height);
      if (measured > 0) {
        rowH = measured;
        document.documentElement.style.setProperty('--row-h', rowH + 'px');
      }
      if (rawData.parseError) {
        banner.hidden = false;
        banner.textContent = rawData.parseError;
      } else if (rawData.manualResolution) {
        banner.hidden = false;
        banner.textContent = 'The working tree has edits without conflict markers. Saving asks before overwrite.';
      }
      render();
      if (window.requestAnimationFrame) {
        window.requestAnimationFrame(function () { render(); });
      }
      bindScroll(scrollLeft, [scrollCenter, scrollRight]);
      bindScroll(scrollRight, [scrollLeft, scrollCenter]);
      bindScroll(scrollCenter, [scrollLeft, scrollRight]);

      document.body.addEventListener('click', function (event) {
        const target = event.target;
        if (!target || !target.closest) return;
        const fold = target.closest('[data-fold]');
        if (fold) {
          const index = Number(fold.getAttribute('data-fold'));
          const block = state.blocks[index];
          if (block) block.folded = !block.folded;
          render();
          return;
        }
        const button = target.closest('[data-act]');
        if (!button) return;
        resolveChunk(button.getAttribute('data-id'), button.getAttribute('data-act'));
      });

      scrollCenter.addEventListener('input', function (event) {
        const area = event.target;
        if (!area || !area.classList || !area.classList.contains('result-area')) return;
        const index = Number(area.getAttribute('data-block'));
        const block = state.blocks[index];
        if (!block) return;
        const nextLines = textareaToLines(area.value);
        if (block.kind === 'context') {
          block.lines = nextLines;
        } else {
          const chunk = chunkById(block.chunkId);
          if (!chunk) return;
          chunk.resultLines = nextLines;
          chunk.resolved = !nextLines.some(isSentinelLine);
          if (chunk.resolved) chunk.chosen = 'custom';
          else chunk.chosen = 'none';
        }
        const pre = area.parentElement && area.parentElement.querySelector('.result-hl');
        if (pre) pre.innerHTML = highlightText(area.value);
        const prevRows = Number(area.getAttribute('data-rows'));
        if (nextLines.length !== prevRows) {
          const focus = { block: String(index), start: area.selectionStart, end: area.selectionEnd };
          render();
          restoreFocus(focus);
        } else {
          updateConflictCount();
        }
      });

      btnLayout3Col.addEventListener('click', function () {
        mergeBody.className = 'merge-body layout-3col';
        btnLayout3Col.classList.add('active');
        btnLayout2Row.classList.remove('active');
      });
      btnLayout2Row.addEventListener('click', function () {
        mergeBody.className = 'merge-body layout-2row';
        btnLayout2Row.classList.add('active');
        btnLayout3Col.classList.remove('active');
      });
      btnToggleSyncScroll.addEventListener('click', function () {
        state.syncScroll = !state.syncScroll;
        btnToggleSyncScroll.classList.toggle('active', state.syncScroll);
      });
      document.getElementById('btnMagicWand').addEventListener('click', applyNonConflicts);
      document.getElementById('btnAcceptAllLeft').addEventListener('click', function () { acceptAll('left'); });
      document.getElementById('btnAcceptAllRight').addEventListener('click', function () { acceptAll('right'); });
      document.getElementById('btnPrevConflict').addEventListener('click', function () { jump(-1); });
      document.getElementById('btnNextConflict').addEventListener('click', function () { jump(1); });
      document.getElementById('btnSaveStage').addEventListener('click', save);
      document.getElementById('btnShowBase').addEventListener('click', function () {
        state.showBase = !state.showBase;
        document.getElementById('btnShowBase').classList.toggle('active', state.showBase);
        render();
      });

      window.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 's') {
          event.preventDefault();
          save();
          return;
        }
        if (event.key === 'Tab' && event.target && event.target.classList && event.target.classList.contains('result-area')) {
          event.preventDefault();
          const area = event.target;
          const start = area.selectionStart;
          const end = area.selectionEnd;
          area.setRangeText('  ', start, end, 'end');
          area.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        if (event.altKey && !event.ctrlKey && !event.metaKey && ['1', '2', '3', '4'].indexOf(event.key) >= 0) {
          const choice = { '1': 'left', '2': 'right', '3': 'both', '4': 'base' }[event.key];
          const id = currentConflictId();
          if (id && choice) {
            event.preventDefault();
            resolveChunk(id, choice);
          }
          return;
        }
        if (event.key === 'F7') {
          event.preventDefault();
          jump(event.shiftKey ? -1 : 1);
        } else if (event.altKey && event.key === 'ArrowDown') {
          event.preventDefault();
          jump(1);
        } else if (event.altKey && event.key === 'ArrowUp') {
          event.preventDefault();
          jump(-1);
        }
      });
    }

    init();
  </script>
</body>
</html>`;
  }
}
