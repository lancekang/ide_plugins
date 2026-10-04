import * as Diff from 'diff';
import { ConflictChunk } from './types.js';

interface MarkerParseResult {
  baseContent: string;
  leftContent: string;
  rightContent: string;
  initialResult: string;
  leftTitle?: string;
  rightTitle?: string;
  baseTitle?: string;
  chunks: ConflictChunk[];
}

/**
 * Parses Git conflict markers (<<<<<<<, |||||||, =======, >>>>>>>)
 */
export function parseConflictMarkers(content: string): MarkerParseResult {
  const lines = content.split(/\r?\n/);
  
  let leftLines: string[] = [];
  let rightLines: string[] = [];
  let baseLines: string[] = [];
  let resultLines: string[] = [];

  const chunks: ConflictChunk[] = [];

  let inConflict = false;
  let inBase = false;
  let inTheirs = false;

  let currentChunkId = 0;
  let currentLeft: string[] = [];
  let currentBase: string[] = [];
  let currentRight: string[] = [];

  let detectedLeftTitle: string | undefined;
  let detectedRightTitle: string | undefined;
  let detectedBaseTitle: string | undefined;

  let leftLineStart = 1;
  let rightLineStart = 1;
  let baseLineStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      inBase = false;
      inTheirs = false;
      currentChunkId++;
      detectedLeftTitle = line.replace(/^<<<<<<<\s*/, '').trim() || detectedLeftTitle;
      currentLeft = [];
      currentBase = [];
      currentRight = [];
      leftLineStart = leftLines.length + 1;
      rightLineStart = rightLines.length + 1;
      baseLineStart = baseLines.length + 1;
      continue;
    }

    if (inConflict && line.startsWith('|||||||')) {
      inBase = true;
      inTheirs = false;
      detectedBaseTitle = line.replace(/^\|\|\|\|\|\|\s*/, '').trim() || detectedBaseTitle;
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

      const chunk: ConflictChunk = {
        id: `chunk-${currentChunkId}`,
        type: 'conflict',
        baseStartLine: baseLineStart,
        baseEndLine: baseLineStart + currentBase.length - 1,
        leftStartLine: leftLineStart,
        leftEndLine: leftLineStart + currentLeft.length - 1,
        rightStartLine: rightLineStart,
        rightEndLine: rightLineStart + currentRight.length - 1,
        baseContent: currentBase.join('\n'),
        leftContent: currentLeft.join('\n'),
        rightContent: currentRight.join('\n'),
        resolved: false,
        chosen: 'none',
        resultContent: ''
      };

      chunks.push(chunk);

      // Append to individual branch reconstructed buffers
      leftLines.push(...currentLeft);
      baseLines.push(...currentBase);
      rightLines.push(...currentRight);

      // Result placeholder for conflict (or default to empty conflict gap)
      resultLines.push(`/* CONFLICT #${currentChunkId}: Choose Left (») or Right («) */`);
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
      leftLines.push(line);
      rightLines.push(line);
      baseLines.push(line);
      resultLines.push(line);
    }
  }

  return {
    baseContent: baseLines.join('\n'),
    leftContent: leftLines.join('\n'),
    rightContent: rightLines.join('\n'),
    initialResult: resultLines.join('\n'),
    leftTitle: detectedLeftTitle,
    rightTitle: detectedRightTitle,
    baseTitle: detectedBaseTitle,
    chunks
  };
}

/**
 * 3-Way diff analysis when git index stages (Base, Ours, Theirs) are present
 */
export function analyze3WayDifferences(
  base: string,
  left: string,
  right: string
): { chunks: ConflictChunk[]; initialResult: string } {
  // If base is empty or identical to one, fallback to simplified diff
  if (!base && left && right) {
    return analyze2WayDiff(left, right);
  }

  const diffOurs = Diff.diffLines(base, left);
  const diffTheirs = Diff.diffLines(base, right);

  // We align differences relative to base
  // For a reliable UI merge editor experience, we generate chunks where:
  // - diff-left: only Left changed relative to Base (can be auto-applied)
  // - diff-right: only Right changed relative to Base (can be auto-applied)
  // - identical: neither changed or both changed to identical text
  // - conflict: both changed differently

  const chunks: ConflictChunk[] = [];
  const resultLines: string[] = [];

  const baseLines = base.split(/\r?\n/);
  const leftLines = left.split(/\r?\n/);
  const rightLines = right.split(/\r?\n/);

  // Fallback to pairwise alignment
  const diffBoth = Diff.diffLines(left, right);

  let currentLeftLine = 1;
  let currentRightLine = 1;
  let chunkIdx = 0;

  for (let i = 0; i < diffBoth.length; i++) {
    const part = diffBoth[i];
    const partLines = (part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value).split(/\r?\n/);
    const lineCount = partLines.length;

    if (part.added) {
      // Line added in right or changed
      const nextPart = diffBoth[i + 1];
      chunkIdx++;
      const chunk: ConflictChunk = {
        id: `chunk-${chunkIdx}`,
        type: 'conflict',
        baseStartLine: 0,
        baseEndLine: 0,
        leftStartLine: currentLeftLine,
        leftEndLine: currentLeftLine,
        rightStartLine: currentRightLine,
        rightEndLine: currentRightLine + lineCount - 1,
        baseContent: '',
        leftContent: '',
        rightContent: part.value,
        resolved: false,
        chosen: 'none',
        resultContent: ''
      };
      chunks.push(chunk);
      currentRightLine += lineCount;
      resultLines.push(`/* CONFLICT #${chunkIdx}: Choose Left (») or Right («) */`);
    } else if (part.removed) {
      // Line present in left only
      const nextPart = diffBoth[i + 1];
      if (nextPart && nextPart.added) {
        // Left replaced by Right -> CONFLICT
        i++; // skip nextPart
        const nextLines = (nextPart.value.endsWith('\n') ? nextPart.value.slice(0, -1) : nextPart.value).split(/\r?\n/);
        chunkIdx++;
        const chunk: ConflictChunk = {
          id: `chunk-${chunkIdx}`,
          type: 'conflict',
          baseStartLine: 0,
          baseEndLine: 0,
          leftStartLine: currentLeftLine,
          leftEndLine: currentLeftLine + lineCount - 1,
          rightStartLine: currentRightLine,
          rightEndLine: currentRightLine + nextLines.length - 1,
          baseContent: '',
          leftContent: part.value,
          rightContent: nextPart.value,
          resolved: false,
          chosen: 'none',
          resultContent: ''
        };
        chunks.push(chunk);
        currentLeftLine += lineCount;
        currentRightLine += nextLines.length;
        resultLines.push(`/* CONFLICT #${chunkIdx}: Choose Left (») or Right («) */`);
      } else {
        // Left only modification
        chunkIdx++;
        const chunk: ConflictChunk = {
          id: `chunk-${chunkIdx}`,
          type: 'diff-left',
          baseStartLine: 0,
          baseEndLine: 0,
          leftStartLine: currentLeftLine,
          leftEndLine: currentLeftLine + lineCount - 1,
          rightStartLine: currentRightLine,
          rightEndLine: currentRightLine,
          baseContent: '',
          leftContent: part.value,
          rightContent: '',
          resolved: false,
          chosen: 'none',
          resultContent: ''
        };
        chunks.push(chunk);
        currentLeftLine += lineCount;
        resultLines.push(part.value.trimEnd());
      }
    } else {
      // Unchanged lines
      currentLeftLine += lineCount;
      currentRightLine += lineCount;
      resultLines.push(...partLines);
    }
  }

  return {
    chunks,
    initialResult: resultLines.join('\n')
  };
}

function analyze2WayDiff(left: string, right: string): { chunks: ConflictChunk[]; initialResult: string } {
  const diff = Diff.diffLines(left, right);
  const chunks: ConflictChunk[] = [];
  const resultLines: string[] = [];

  let chunkIdx = 0;
  let leftLine = 1;
  let rightLine = 1;

  for (let i = 0; i < diff.length; i++) {
    const part = diff[i];
    const lines = (part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value).split(/\r?\n/);
    const count = lines.length;

    if (part.removed) {
      const next = diff[i + 1];
      if (next && next.added) {
        i++;
        const nextLines = (next.value.endsWith('\n') ? next.value.slice(0, -1) : next.value).split(/\r?\n/);
        chunkIdx++;
        chunks.push({
          id: `chunk-${chunkIdx}`,
          type: 'conflict',
          baseStartLine: 0,
          baseEndLine: 0,
          leftStartLine: leftLine,
          leftEndLine: leftLine + count - 1,
          rightStartLine: rightLine,
          rightEndLine: rightLine + nextLines.length - 1,
          baseContent: '',
          leftContent: part.value,
          rightContent: next.value,
          resolved: false,
          chosen: 'none',
          resultContent: ''
        });
        leftLine += count;
        rightLine += nextLines.length;
        resultLines.push(`/* CONFLICT #${chunkIdx}: Choose Left (») or Right («) */`);
      } else {
        chunkIdx++;
        chunks.push({
          id: `chunk-${chunkIdx}`,
          type: 'diff-left',
          baseStartLine: 0,
          baseEndLine: 0,
          leftStartLine: leftLine,
          leftEndLine: leftLine + count - 1,
          rightStartLine: rightLine,
          rightEndLine: rightLine,
          baseContent: '',
          leftContent: part.value,
          rightContent: '',
          resolved: false,
          chosen: 'none'
        });
        leftLine += count;
        resultLines.push(part.value.trimEnd());
      }
    } else if (part.added) {
      chunkIdx++;
      chunks.push({
        id: `chunk-${chunkIdx}`,
        type: 'diff-right',
        baseStartLine: 0,
        baseEndLine: 0,
        leftStartLine: leftLine,
        leftEndLine: leftLine,
        rightStartLine: rightLine,
        rightEndLine: rightLine + count - 1,
        baseContent: '',
        leftContent: '',
        rightContent: part.value,
        resolved: false,
        chosen: 'none'
      });
      rightLine += count;
      resultLines.push(part.value.trimEnd());
    } else {
      leftLine += count;
      rightLine += count;
      resultLines.push(...lines);
    }
  }

  return {
    chunks,
    initialResult: resultLines.join('\n')
  };
}
