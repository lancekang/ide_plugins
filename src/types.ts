export type ConflictStatus = 'conflict' | 'ours-only' | 'theirs-only' | 'both-identical';

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
  // Resolution state
  resolved: boolean;
  chosen: 'left' | 'right' | 'both' | 'custom' | 'base' | 'none';
  resultContent?: string;
}

export interface MergeFileData {
  filePath: string;
  fileName: string;
  relativeFilePath: string;
  leftTitle: string;    // e.g. "Current Branch (HEAD / main)"
  rightTitle: string;   // e.g. "Incoming Branch (feature/xyz)"
  baseTitle: string;    // e.g. "Base / Common Ancestor"
  baseContent: string;
  leftContent: string;
  rightContent: string;
  initialResultContent: string;
  chunks: ConflictChunk[];
  sourceType: 'git-index' | 'marker-parsing';
}

export interface ConflictFileInfo {
  fsPath: string;
  relPath: string;
  fileName: string;
}
