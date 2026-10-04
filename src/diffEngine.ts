import { diffArrays } from 'diff';
import { ConflictChunk, MergeBlock } from './types.js';

export interface DocumentParts {
  lines: string[];
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
}

export interface MergeAnalysis {
  chunks: ConflictChunk[];
  blocks: MergeBlock[];
  initialResult: string;
  leftContent: string;
  rightContent: string;
  baseContent: string;
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
}

interface Edit {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

interface Cluster {
  baseStart: number;
  baseEnd: number;
  left: Edit[];
  right: Edit[];
}

export function conflictSentinel(chunkId: string): string {
  return `<<<<<<< WMERGE ${chunkId} >>>>>>>`;
}

export function isSentinelLine(line: string): boolean {
  return /^<<<<<<< WMERGE \S+ >>>>>>>$/.test(line);
}

/**
 * True when a line is a real Git conflict marker, not our own sentinel.
 * A bare `=======` line is included only together with both sides.
 */
export function hasGitConflictMarkers(content: string): boolean {
  let start = false;
  let middle = false;
  let end = false;
  for (const line of content.split(/\r?\n/)) {
    if (isSentinelLine(line)) {
      continue;
    }
    if (/^<{7} /.test(line)) {
      start = true;
    } else if (/^={7}$/.test(line)) {
      middle = true;
    } else if (/^>{7} /.test(line)) {
      end = true;
    }
    if (start && middle && end) {
      return true;
    }
  }
  return false;
}

/** Reason to refuse git add, or null when the text can be staged. */
export function describeUnresolved(content: string): string | null {
  const lines = content.split(/\r?\n/);
  if (lines.some(isSentinelLine)) {
    return 'Unresolved merge hunks remain in the result.';
  }
  if (hasGitConflictMarkers(content)) {
    return 'Git conflict markers remain in the result.';
  }
  return null;
}

export function detectEol(content: string): '\n' | '\r\n' {
  const crlf = content.split('\r\n').length - 1;
  const lf = content.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function splitDocument(content: string): DocumentParts {
  if (content.length === 0) {
    return { lines: [], eol: '\n', trailingNewline: false };
  }
  const eol = detectEol(content);
  const trailingNewline = content.endsWith('\n');
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, eol, trailingNewline };
}

export function joinDocument(lines: string[], eol: '\n' | '\r\n', trailingNewline: boolean): string {
  if (lines.length === 0) {
    return trailingNewline ? eol : '';
  }
  const body = lines.join(eol);
  return trailingNewline ? body + eol : body;
}

export function serializeMerge(
  blocks: MergeBlock[],
  chunks: ConflictChunk[],
  eol: '\n' | '\r\n',
  trailingNewline: boolean
): string {
  const byId = new Map(chunks.map(chunk => [chunk.id, chunk]));
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'context') {
      lines.push(...block.lines);
      continue;
    }
    const chunk = block.chunkId ? byId.get(block.chunkId) : undefined;
    if (!chunk) {
      throw new Error(`Missing merge hunk ${block.chunkId ?? ''}`);
    }
    lines.push(...chunk.resultLines);
  }
  return joinDocument(lines, eol, trailingNewline);
}

function voteDocument(parts: string[]): { eol: '\n' | '\r\n'; trailingNewline: boolean } {
  let crlf = 0;
  let lf = 0;
  let trailing = 0;
  let present = 0;
  for (const part of parts) {
    if (!part) {
      continue;
    }
    present++;
    const parsed = splitDocument(part);
    if (parsed.eol === '\r\n') {
      crlf++;
    } else {
      lf++;
    }
    if (parsed.trailingNewline) {
      trailing++;
    }
  }
  if (present === 0) {
    return { eol: '\n', trailingNewline: false };
  }
  return {
    eol: crlf > lf ? '\r\n' : '\n',
    trailingNewline: trailing * 2 >= present
  };
}

function sameLines(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}

function editsAgainstBase(base: string[], other: string[]): Edit[] {
  const changes = diffArrays(base, other);
  const edits: Edit[] = [];
  let baseIndex = 0;
  for (let i = 0; i < changes.length; i++) {
    const part = changes[i];
    if (!part.added && !part.removed) {
      baseIndex += part.value.length;
      continue;
    }
    if (part.removed) {
      const removed = part.value.length;
      const next = changes[i + 1];
      if (next?.added) {
        edits.push({
          baseStart: baseIndex,
          baseEnd: baseIndex + removed,
          lines: next.value.slice()
        });
        baseIndex += removed;
        i++;
      } else {
        edits.push({
          baseStart: baseIndex,
          baseEnd: baseIndex + removed,
          lines: []
        });
        baseIndex += removed;
      }
      continue;
    }
    edits.push({
      baseStart: baseIndex,
      baseEnd: baseIndex,
      lines: part.value.slice()
    });
  }
  return edits;
}

function overlaps(edit: Edit, cluster: Cluster): boolean {
  const zero = edit.baseStart === edit.baseEnd;
  const clusterZero = cluster.baseStart === cluster.baseEnd;
  if (zero && clusterZero) {
    return edit.baseStart === cluster.baseStart;
  }
  if (zero) {
    return edit.baseStart >= cluster.baseStart && edit.baseStart < cluster.baseEnd;
  }
  return edit.baseStart < cluster.baseEnd && edit.baseEnd > cluster.baseStart;
}

function clusterEdits(left: Edit[], right: Edit[]): Cluster[] {
  const tagged = [
    ...left.map(edit => ({ side: 'left' as const, edit })),
    ...right.map(edit => ({ side: 'right' as const, edit }))
  ].sort((a, b) => a.edit.baseStart - b.edit.baseStart || a.edit.baseEnd - b.edit.baseEnd);

  const clusters: Cluster[] = [];
  for (const item of tagged) {
    const last = clusters[clusters.length - 1];
    if (!last || !overlaps(item.edit, last)) {
      clusters.push({
        baseStart: item.edit.baseStart,
        baseEnd: item.edit.baseEnd,
        left: item.side === 'left' ? [item.edit] : [],
        right: item.side === 'right' ? [item.edit] : []
      });
      continue;
    }
    last.baseStart = Math.min(last.baseStart, item.edit.baseStart);
    last.baseEnd = Math.max(last.baseEnd, item.edit.baseEnd);
    last[item.side].push(item.edit);
  }
  return clusters;
}

function materialize(base: string[], edits: Edit[], start: number, end: number): string[] {
  const relevant = edits
    .filter(edit => {
      const zero = edit.baseStart === edit.baseEnd;
      if (zero) {
        return edit.baseStart >= start && edit.baseStart <= end;
      }
      return edit.baseStart < end && edit.baseEnd > start;
    })
    .sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);

  const result: string[] = [];
  let cursor = start;
  for (const edit of relevant) {
    if (edit.baseStart > cursor) {
      result.push(...base.slice(cursor, edit.baseStart));
    }
    result.push(...edit.lines);
    cursor = Math.max(cursor, edit.baseEnd);
  }
  if (cursor < end) {
    result.push(...base.slice(cursor, end));
  }
  return result;
}

function lineRange(start: number, count: number): { startLine: number; endLine: number; empty: boolean } {
  if (count === 0) {
    return { startLine: start, endLine: start - 1, empty: true };
  }
  return { startLine: start, endLine: start + count - 1, empty: false };
}

/**
 * Classify hunks against the common ancestor.
 * One-sided edits are applied. Both-sided identical edits are applied.
 * Both-sided differences stay as unsaved sentinels.
 */
export function analyze3WayDifferences(base: string, left: string, right: string): MergeAnalysis {
  const baseParts = splitDocument(base);
  const leftParts = splitDocument(left);
  const rightParts = splitDocument(right);
  const { eol, trailingNewline } = voteDocument([base, left, right]);
  const clusters = clusterEdits(
    editsAgainstBase(baseParts.lines, leftParts.lines),
    editsAgainstBase(baseParts.lines, rightParts.lines)
  );

  const chunks: ConflictChunk[] = [];
  const blocks: MergeBlock[] = [];
  const leftOut: string[] = [];
  const rightOut: string[] = [];
  let leftLine = 1;
  let rightLine = 1;
  let baseLine = 1;
  let cursor = 0;
  let chunkIdx = 0;

  const appendContext = (lines: string[]) => {
    if (lines.length === 0) {
      return;
    }
    blocks.push({ kind: 'context', lines: lines.slice() });
    leftOut.push(...lines);
    rightOut.push(...lines);
    leftLine += lines.length;
    rightLine += lines.length;
    baseLine += lines.length;
  };

  for (const cluster of clusters) {
    if (cluster.baseStart > cursor) {
      appendContext(baseParts.lines.slice(cursor, cluster.baseStart));
    }

    const leftHas = cluster.left.length > 0;
    const rightHas = cluster.right.length > 0;
    const leftPiece = leftHas
      ? materialize(baseParts.lines, cluster.left, cluster.baseStart, cluster.baseEnd)
      : baseParts.lines.slice(cluster.baseStart, cluster.baseEnd);
    const rightPiece = rightHas
      ? materialize(baseParts.lines, cluster.right, cluster.baseStart, cluster.baseEnd)
      : baseParts.lines.slice(cluster.baseStart, cluster.baseEnd);
    const basePiece = baseParts.lines.slice(cluster.baseStart, cluster.baseEnd);

    chunkIdx++;
    const id = `chunk-${chunkIdx}`;
    let type: ConflictChunk['type'];
    let resultLines: string[];
    let resolved: boolean;
    let chosen: ConflictChunk['chosen'];

    if (leftHas && rightHas) {
      if (sameLines(leftPiece, rightPiece)) {
        type = 'identical';
        resultLines = leftPiece.slice();
        resolved = true;
        chosen = 'both';
      } else {
        type = 'conflict';
        resultLines = [conflictSentinel(id)];
        resolved = false;
        chosen = 'none';
      }
    } else if (leftHas) {
      type = 'diff-left';
      resultLines = leftPiece.slice();
      resolved = true;
      chosen = 'left';
    } else {
      type = 'diff-right';
      resultLines = rightPiece.slice();
      resolved = true;
      chosen = 'right';
    }

    const leftRange = lineRange(leftLine, leftPiece.length);
    const rightRange = lineRange(rightLine, rightPiece.length);
    const baseRange = lineRange(baseLine, basePiece.length);
    chunks.push({
      id,
      type,
      baseStartLine: baseRange.startLine,
      baseEndLine: baseRange.endLine,
      leftStartLine: leftRange.startLine,
      leftEndLine: leftRange.endLine,
      rightStartLine: rightRange.startLine,
      rightEndLine: rightRange.endLine,
      baseContent: basePiece.join('\n'),
      leftContent: leftPiece.join('\n'),
      rightContent: rightPiece.join('\n'),
      resolved,
      chosen,
      resultLines,
      leftEmpty: leftRange.empty,
      rightEmpty: rightRange.empty
    });
    blocks.push({ kind: 'hunk', lines: [], chunkId: id });
    leftOut.push(...leftPiece);
    rightOut.push(...rightPiece);
    leftLine += leftPiece.length;
    rightLine += rightPiece.length;
    baseLine += basePiece.length;
    cursor = cluster.baseEnd;
  }

  if (cursor < baseParts.lines.length) {
    appendContext(baseParts.lines.slice(cursor));
  }

  const initialResult = serializeMerge(blocks, chunks, eol, trailingNewline);
  return {
    chunks,
    blocks,
    initialResult,
    leftContent: joinDocument(leftOut, eol, trailingNewline),
    rightContent: joinDocument(rightOut, eol, trailingNewline),
    baseContent: joinDocument(baseParts.lines, eol, trailingNewline),
    eol,
    trailingNewline
  };
}

export interface MarkerParseResult extends MergeAnalysis {
  leftTitle?: string;
  rightTitle?: string;
  baseTitle?: string;
  parseError?: string;
}

/**
 * Parse Git conflict markers. An unclosed marker keeps the original text.
 */
export function parseConflictMarkers(content: string): MarkerParseResult {
  const parts = splitDocument(content);
  const lines = parts.lines;
  let inConflict = false;
  let inBase = false;
  let inTheirs = false;
  let currentLeft: string[] = [];
  let currentBase: string[] = [];
  let currentRight: string[] = [];
  let detectedLeftTitle: string | undefined;
  let detectedRightTitle: string | undefined;
  let detectedBaseTitle: string | undefined;
  let chunkIdx = 0;

  const chunks: ConflictChunk[] = [];
  const blocks: MergeBlock[] = [];
  const leftOut: string[] = [];
  const rightOut: string[] = [];
  const baseOut: string[] = [];
  let context: string[] = [];
  let leftLine = 1;
  let rightLine = 1;
  let baseLine = 1;

  const flushContext = () => {
    if (context.length === 0) {
      return;
    }
    blocks.push({ kind: 'context', lines: context.slice() });
    leftOut.push(...context);
    rightOut.push(...context);
    baseOut.push(...context);
    leftLine += context.length;
    rightLine += context.length;
    baseLine += context.length;
    context = [];
  };

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      flushContext();
      inConflict = true;
      inBase = false;
      inTheirs = false;
      currentLeft = [];
      currentBase = [];
      currentRight = [];
      detectedLeftTitle = line.replace(/^<<<<<<<\s*/, '').trim() || detectedLeftTitle;
      continue;
    }

    if (inConflict && line.startsWith('|||||||')) {
      inBase = true;
      inTheirs = false;
      detectedBaseTitle = line.replace(/^\|{7}\s*/, '').trim() || detectedBaseTitle;
      continue;
    }

    if (inConflict && line.startsWith('=======')) {
      inBase = false;
      inTheirs = true;
      continue;
    }

    if (inConflict && line.startsWith('>>>>>>>')) {
      inConflict = false;
      inBase = false;
      inTheirs = false;
      detectedRightTitle = line.replace(/^>>>>>>>\s*/, '').trim() || detectedRightTitle;
      chunkIdx++;
      const id = `chunk-${chunkIdx}`;
      const leftRange = lineRange(leftLine, currentLeft.length);
      const rightRange = lineRange(rightLine, currentRight.length);
      const baseRange = lineRange(baseLine, currentBase.length);
      chunks.push({
        id,
        type: 'conflict',
        baseStartLine: baseRange.startLine,
        baseEndLine: baseRange.endLine,
        leftStartLine: leftRange.startLine,
        leftEndLine: leftRange.endLine,
        rightStartLine: rightRange.startLine,
        rightEndLine: rightRange.endLine,
        baseContent: currentBase.join('\n'),
        leftContent: currentLeft.join('\n'),
        rightContent: currentRight.join('\n'),
        resolved: false,
        chosen: 'none',
        resultLines: [conflictSentinel(id)],
        leftEmpty: leftRange.empty,
        rightEmpty: rightRange.empty
      });
      blocks.push({ kind: 'hunk', lines: [], chunkId: id });
      leftOut.push(...currentLeft);
      rightOut.push(...currentRight);
      baseOut.push(...currentBase);
      leftLine += currentLeft.length;
      rightLine += currentRight.length;
      baseLine += currentBase.length;
      continue;
    }

    if (inConflict) {
      if (inTheirs) {
        currentRight.push(line);
      } else if (inBase) {
        currentBase.push(line);
      } else {
        currentLeft.push(line);
      }
    } else {
      context.push(line);
    }
  }

  if (inConflict) {
    return {
      chunks: [],
      blocks: [{ kind: 'context', lines: parts.lines.slice() }],
      initialResult: content,
      leftContent: '',
      rightContent: '',
      baseContent: '',
      leftTitle: detectedLeftTitle,
      rightTitle: detectedRightTitle,
      baseTitle: detectedBaseTitle,
      eol: parts.eol,
      trailingNewline: parts.trailingNewline,
      parseError: 'Unclosed conflict marker. The original file text was kept.'
    };
  }

  flushContext();
  return {
    chunks,
    blocks,
    initialResult: serializeMerge(blocks, chunks, parts.eol, parts.trailingNewline),
    leftContent: joinDocument(leftOut, parts.eol, parts.trailingNewline),
    rightContent: joinDocument(rightOut, parts.eol, parts.trailingNewline),
    baseContent: joinDocument(baseOut, parts.eol, parts.trailingNewline),
    leftTitle: detectedLeftTitle,
    rightTitle: detectedRightTitle,
    baseTitle: detectedBaseTitle,
    eol: parts.eol,
    trailingNewline: parts.trailingNewline
  };
}
