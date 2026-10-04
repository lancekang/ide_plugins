import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ConflictFileInfo, MergeFileData } from './types.js';
import { analyze3WayDifferences, parseConflictMarkers } from './diffEngine.js';

function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    cp.execFile('git', args, { cwd, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0)
      });
    });
  });
}

export class GitService {
  /**
   * Find Git root directory for a given path
   */
  public static async findGitRoot(filePath: string): Promise<string | null> {
    const dir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
    const res = await execGit(['rev-parse', '--show-toplevel'], dir);
    if (res.exitCode === 0 && res.stdout.trim().length > 0) {
      return path.normalize(res.stdout.trim());
    }
    return null;
  }

  /**
   * List all conflicted files in the repository
   */
  public static async getConflictedFiles(gitRoot: string): Promise<ConflictFileInfo[]> {
    const res = await execGit(['status', '--porcelain'], gitRoot);
    if (res.exitCode !== 0) {
      return [];
    }

    const lines = res.stdout.split('\n');
    const conflicts: ConflictFileInfo[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.length < 4) {
        continue;
      }
      const code = line.substring(0, 2);
      // Conflicted status codes in git: UU, AA, DD, AU, UD, UA, DU
      const isConflict = ['UU', 'AA', 'DD', 'AU', 'UD', 'UA', 'DU'].includes(code);
      if (isConflict) {
        const relPath = line.substring(3).trim();
        const fullPath = path.join(gitRoot, relPath);
        conflicts.push({
          fsPath: fullPath,
          relPath: relPath.replace(/\\/g, '/'),
          fileName: path.basename(fullPath)
        });
      }
    }

    return conflicts;
  }

  /**
   * Get 3-way merge content (Base, Ours, Theirs) for a given file
   */
  public static async loadMergeData(filePath: string): Promise<MergeFileData> {
    const gitRoot = await this.findGitRoot(filePath);
    const fileName = path.basename(filePath);

    if (!gitRoot) {
      // Not a git repo, attempt file marker parsing fallback
      return this.fallbackParseMarkers(filePath, fileName, '');
    }

    const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');

    // 1. Check if git index has unmerged stages (1 = base, 2 = ours, 3 = theirs)
    const lsFilesRes = await execGit(['ls-files', '-u', relPath], gitRoot);
    const hasUnmergedStages = lsFilesRes.exitCode === 0 && lsFilesRes.stdout.trim().length > 0;

    let branchOurs = 'Current Branch (Ours)';
    let branchTheirs = 'Incoming Branch (Theirs)';

    // Get current branch name
    const branchRes = await execGit(['branch', '--show-current'], gitRoot);
    if (branchRes.exitCode === 0 && branchRes.stdout.trim().length > 0) {
      branchOurs = `Local: ${branchRes.stdout.trim()}`;
    }

    // Attempt to inspect MERGE_MSG or MERGE_HEAD
    const mergeMsgPath = path.join(gitRoot, '.git', 'MERGE_MSG');
    if (fs.existsSync(mergeMsgPath)) {
      try {
        const msg = fs.readFileSync(mergeMsgPath, 'utf8').split('\n')[0];
        if (msg) {
          branchTheirs = `Incoming (${msg.replace(/^Merge (branch|commit) /i, '')})`;
        }
      } catch {
        // ignore
      }
    }

    if (hasUnmergedStages) {
      const baseRes = await execGit(['show', `:1:${relPath}`], gitRoot);
      const oursRes = await execGit(['show', `:2:${relPath}`], gitRoot);
      const theirsRes = await execGit(['show', `:3:${relPath}`], gitRoot);

      const baseContent = baseRes.exitCode === 0 ? baseRes.stdout : '';
      const leftContent = oursRes.exitCode === 0 ? oursRes.stdout : '';
      const rightContent = theirsRes.exitCode === 0 ? theirsRes.stdout : '';

      const { chunks, initialResult } = analyze3WayDifferences(baseContent, leftContent, rightContent);

      return {
        filePath,
        fileName,
        relativeFilePath: relPath,
        leftTitle: branchOurs,
        rightTitle: branchTheirs,
        baseTitle: 'Base / Common Ancestor',
        baseContent,
        leftContent,
        rightContent,
        initialResultContent: initialResult,
        chunks,
        sourceType: 'git-index'
      };
    }

    // 2. Fallback to marker parsing in working directory file
    return this.fallbackParseMarkers(filePath, fileName, relPath, branchOurs, branchTheirs);
  }

  private static fallbackParseMarkers(
    filePath: string,
    fileName: string,
    relPath: string,
    defaultLeftTitle?: string,
    defaultRightTitle?: string
  ): MergeFileData {
    let fileContent = '';
    try {
      fileContent = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      fileContent = '';
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
      sourceType: 'marker-parsing'
    };
  }

  /**
   * Save resolved result and git add file
   */
  public static async saveAndStage(filePath: string, resolvedContent: string): Promise<{ success: boolean; message: string; remainingConflicts: number }> {
    try {
      fs.writeFileSync(filePath, resolvedContent, 'utf8');

      const gitRoot = await this.findGitRoot(filePath);
      let remaining = 0;

      if (gitRoot) {
        const relPath = path.relative(gitRoot, filePath).replace(/\\/g, '/');
        const addRes = await execGit(['add', relPath], gitRoot);
        if (addRes.exitCode !== 0) {
          return {
            success: false,
            message: `Saved file, but 'git add' failed: ${addRes.stderr}`,
            remainingConflicts: 0
          };
        }

        const conflictList = await this.getConflictedFiles(gitRoot);
        remaining = conflictList.length;
      }

      return {
        success: true,
        message: 'Conflict resolved and staged successfully with git add!',
        remainingConflicts: remaining
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to save file: ${err?.message || err}`,
        remainingConflicts: 0
      };
    }
  }
}
