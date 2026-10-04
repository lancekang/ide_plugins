export type ChunkChoice = 'left' | 'right' | 'both' | 'custom' | 'base' | 'none';

export interface ConflictChunk {
  id: string;
  type: 'conflict' | 'diff-left' | 'diff-right' | 'identical';
  baseStartLine: number;
  baseEndLine: number;
  leftStartLine: number;
  leftEndLine: number;
  rightStartLine: number;
  rightEndLine: number;
  baseContent: string;
  leftContent: string;
  rightContent: string;
  resolved: boolean;
  chosen: ChunkChoice;
  /** Lines written for this hunk. Empty means a deletion, not a blank line. */
  resultLines: string[];
  leftEmpty: boolean;
  rightEmpty: boolean;
}

export interface MergeBlock {
  kind: 'context' | 'hunk';
  /** Context lines. Empty for hunks; hunk text lives on the chunk. */
  lines: string[];
  chunkId?: string;
}

export interface MergeFileData {
  filePath: string;
  fileName: string;
  relativeFilePath: string;
  leftTitle: string;
  rightTitle: string;
  baseTitle: string;
  baseContent: string;
  leftContent: string;
  rightContent: string;
  initialResultContent: string;
  chunks: ConflictChunk[];
  blocks: MergeBlock[];
  sourceType: 'git-index' | 'marker-parsing';
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
  /** Set when conflict markers are not closed. The original text is kept. */
  parseError?: string;
  /** Unmerged in the index, while the working tree has no conflict markers. */
  manualResolution: boolean;
  diskExisted: boolean;
  /** Working tree at the moment the view opened. Omitted from the webview. */
  diskSnapshot?: string;
}

export interface ConflictFileInfo {
  fsPath: string;
  relPath: string;
  fileName: string;
}
