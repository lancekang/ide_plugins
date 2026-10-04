import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ConflictFileInfo, MergeFileData } from './types.js';
import {
  analyze3WayDifferences,
  describeUnresolved,
  hasGitConflictMarkers,
  parseConflictMarkers
} from './diffEngine.js';

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function execGit(gitBin: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    cp.execFile(gitBin, args, { cwd, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0)
      });
    });
  });
}

function isBinary(content: string): boolean {
  return content.includes('\0');
}

/**
 * Parse `git status --porcelain -z`.
 * Rename records are `XY ORIG\0PATH\0`. Conflict paths keep the path Git reports.
 */
export function parseConflictedPaths(porcelainZ: string): string[] {
  const records = porcelainZ.split('\0');
  const paths: string[] = [];
  let i = 0;
  while (i < records.length) {
    const rec = records[i];
    if (!rec) {
      i++;
      continue;
    }
    if (rec.length < 4) {
      i++;
      continue;
    }
    const code = rec.slice(0, 2);
    const firstPath = rec.slice(3);
    const renamed = code.includes('R') || code.includes('C');
    let finalPath = firstPath;
    if (renamed) {
      finalPath = records[i + 1] || firstPath;
      i += 2;
    } else {
      i += 1;
    }
    if (CONFLICT_CODES.has(code)) {
      paths.push(finalPath);
    }
  }
  return paths;
}

function incomingLabel(message: string): string | undefined {
  const first = message.split('\n')[0]?.trim();
  if (!first) {
    return undefined;
  }
  let label = first.replace(/^Merge (remote-tracking )?branch /i, '').replace(/^Merge commit /i, '');
  label = label.replace(/ into .+$/, '').replace(/^'+|'+$/g, '').trim();
  return label || undefined;
}

export class GitService {
  private static gitExecutable = 'git';

  public static setGitExecutable(bin: string | undefined): void {
    if (typeof bin === 'string' && bin.trim().length > 0) {
      this.gitExecutable = bin.trim();
    }
  }

  public static async findGitRoot(filePath: string): Promise<string | null> {
    let start = filePath;
    if (fs.existsSync(filePath)) {
      start = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
    } else {
      start = path.dirname(filePath);
    }
    if (!fs.existsSync(start)) {
      return null;
    }
    const res = await execGit(this.gitExecutable, ['rev-parse', '--show-toplevel'], start);
    if (res.exitCode === 0 && res.stdout.trim().length > 0) {
      return path.normalize(res.stdout.trim());
    }
    return null;
  }

  public static async getConflictedFiles(gitRoot: string): Promise<ConflictFileInfo[]> {
    const res = await execGit(this.gitExecutable, ['status', '--porcelain', '-z'], gitRoot);
    if (res.exitCode !== 0) {
      return [];
    }
    return parseConflictedPaths(res.stdout).map(relPath => {
      const fullPath = path.join(gitRoot, relPath);
      return {
        fsPath: fullPath,
        relPath: relPath.replace(/\\/g, '/'),
        fileName: path.basename(fullPath)
      };
    });
  }

  public static async loadMergeData(filePath: string): Promise<MergeFileData> {
    const fileName = path.basename(filePath);
    const disk = this.readDisk(filePath);
    const gitRoot = await this.findGitRoot(filePath);

    if (!gitRoot) {
      if (!disk.existed) {
        throw new Error('File not found.');
      }
      return this.fallbackParseMarkers(filePath, fileName, '', disk);
    }

    const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');
    const titles = await this.branchTitles(gitRoot);
    const lsFilesRes = await execGit(this.gitExecutable, ['ls-files', '-u', '-z', '--', relPath], gitRoot);
    const hasUnmergedStages = lsFilesRes.exitCode === 0 && lsFilesRes.stdout.length > 0;

    if (hasUnmergedStages) {
      const baseContent = await this.showStage(gitRoot, 1, relPath);
      const leftContent = await this.showStage(gitRoot, 2, relPath);
      const rightContent = await this.showStage(gitRoot, 3, relPath);
      const stages = [baseContent, leftContent, rightContent, disk.text ?? ''];
      if (stages.some(isBinary)) {
        throw new Error('Binary files cannot be opened in the text merge view.');
      }

      const analysis = analyze3WayDifferences(baseContent, leftContent, rightContent);
      const manualResolution = disk.existed && disk.text !== undefined && !hasGitConflictMarkers(disk.text);
      return {
        filePath,
        fileName,
        relativeFilePath: relPath,
        leftTitle: titles.ours,
        rightTitle: titles.theirs,
        baseTitle: 'Base / Common Ancestor',
        baseContent: analysis.baseContent,
        leftContent: analysis.leftContent,
        rightContent: analysis.rightContent,
        initialResultContent: analysis.initialResult,
        chunks: analysis.chunks,
        blocks: analysis.blocks,
        sourceType: 'git-index',
        eol: analysis.eol,
        trailingNewline: analysis.trailingNewline,
        manualResolution,
        diskExisted: disk.existed,
        diskSnapshot: disk.text
      };
    }

    if (!disk.existed) {
      throw new Error('File not found.');
    }
    return this.fallbackParseMarkers(filePath, fileName, relPath, disk, titles.ours, titles.theirs);
  }

  public static async saveAndStage(
    filePath: string,
    resolvedContent: string
  ): Promise<{ success: boolean; message: string; remainingConflicts: number }> {
    const unresolved = describeUnresolved(resolvedContent);
    if (unresolved) {
      return {
        success: false,
        message: unresolved,
        remainingConflicts: await this.countConflicts(filePath)
      };
    }
    if (isBinary(resolvedContent)) {
      return {
        success: false,
        message: 'Refusing to write binary content from the text merge view.',
        remainingConflicts: await this.countConflicts(filePath)
      };
    }

    try {
      fs.writeFileSync(filePath, resolvedContent, 'utf8');
      const gitRoot = await this.findGitRoot(filePath);
      if (!gitRoot) {
        return {
          success: true,
          message: 'Saved file. No Git repository was found, so it was not staged.',
          remainingConflicts: 0
        };
      }

      const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');
      const addRes = await execGit(this.gitExecutable, ['add', '--', relPath], gitRoot);
      if (addRes.exitCode !== 0) {
        return {
          success: false,
          message: `Saved file, but git add failed: ${addRes.stderr || addRes.stdout}`,
          remainingConflicts: await this.countConflicts(filePath)
        };
      }

      const remaining = (await this.getConflictedFiles(gitRoot)).length;
      return {
        success: true,
        message: 'Conflict resolved and staged with git add.',
        remainingConflicts: remaining
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to save file: ${message}`,
        remainingConflicts: 0
      };
    }
  }

  private static readDisk(filePath: string): { existed: boolean; text?: string } {
    if (!fs.existsSync(filePath)) {
      return { existed: false };
    }
    try {
      return { existed: true, text: fs.readFileSync(filePath, 'utf8') };
    } catch {
      return { existed: true };
    }
  }

  private static async showStage(gitRoot: string, stage: 1 | 2 | 3, relPath: string): Promise<string> {
    const res = await execGit(this.gitExecutable, ['show', `:${stage}:${relPath}`], gitRoot);
    return res.exitCode === 0 ? res.stdout : '';
  }

  private static async branchTitles(gitRoot: string): Promise<{ ours: string; theirs: string }> {
    let ours = 'Current Branch (Ours)';
    let theirs = 'Incoming Branch (Theirs)';
    const branchRes = await execGit(this.gitExecutable, ['branch', '--show-current'], gitRoot);
    if (branchRes.exitCode === 0 && branchRes.stdout.trim().length > 0) {
      ours = `Local: ${branchRes.stdout.trim()}`;
    }
    const mergeMsgPath = path.join(gitRoot, '.git', 'MERGE_MSG');
    if (fs.existsSync(mergeMsgPath)) {
      try {
        const label = incomingLabel(fs.readFileSync(mergeMsgPath, 'utf8'));
        if (label) {
          theirs = `Incoming (${label})`;
        }
      } catch {
        // Keep the default incoming label.
      }
    }
    return { ours, theirs };
  }

  private static async countConflicts(filePath: string): Promise<number> {
    const gitRoot = await this.findGitRoot(filePath);
    if (!gitRoot) {
      return 0;
    }
    return (await this.getConflictedFiles(gitRoot)).length;
  }

  private static fallbackParseMarkers(
    filePath: string,
    fileName: string,
    relPath: string,
    disk: { existed: boolean; text?: string },
    defaultLeftTitle?: string,
    defaultRightTitle?: string
  ): MergeFileData {
    const fileContent = disk.text ?? '';
    if (isBinary(fileContent)) {
      throw new Error('Binary files cannot be opened in the text merge view.');
    }
    const parsed = parseConflictMarkers(fileContent);
    return {
      filePath,
      fileName,
      relativeFilePath: relPath || fileName,
      leftTitle: parsed.leftTitle || defaultLeftTitle || 'Current Branch (Ours)',
      rightTitle: parsed.rightTitle || defaultRightTitle || 'Incoming Branch (Theirs)',
      baseTitle: parsed.baseTitle || 'Base / Common Ancestor',
      baseContent: parsed.baseContent,
      leftContent: parsed.leftContent,
      rightContent: parsed.rightContent,
      initialResultContent: parsed.initialResult,
      chunks: parsed.chunks,
      blocks: parsed.blocks,
      sourceType: 'marker-parsing',
      eol: parsed.eol,
      trailingNewline: parsed.trailingNewline,
      parseError: parsed.parseError,
      manualResolution: false,
      diskExisted: disk.existed,
      diskSnapshot: disk.text
    };
  }
}
