import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  analyze3WayDifferences,
  describeUnresolved,
  hasGitConflictMarkers,
  parseConflictMarkers,
  serializeMerge
} from '../src/diffEngine.js';
import { GitService, parseConflictedPaths } from '../src/gitService.js';

function mainLines(analysis: { initialResult: string }): string {
  return analysis.initialResult;
}

const sampleMarker = `function calculateTotal(items) {
<<<<<<< HEAD (Current Branch)
  const tax = 0.1;
  return items.reduce((acc, x) => acc + x.price * (1 + tax), 0);
=======
  const taxRate = 0.08;
  const discount = 5;
  return items.reduce((acc, x) => acc + x.price * (1 + taxRate), 0) - discount;
>>>>>>> feature/new-pricing
}
`;

const parsed = parseConflictMarkers(sampleMarker);
assert.equal(parsed.leftTitle, 'HEAD (Current Branch)');
assert.equal(parsed.rightTitle, 'feature/new-pricing');
assert.equal(parsed.chunks.length, 1);
assert.equal(parsed.chunks[0].type, 'conflict');
assert.ok(parsed.leftContent.includes('const tax = 0.1;'));
assert.ok(parsed.rightContent.includes('const taxRate = 0.08;'));
assert.ok(parsed.initialResult.includes('<<<<<<< WMERGE chunk-1 >>>>>>>'));
assert.equal(describeUnresolved(parsed.initialResult), 'Unresolved merge hunks remain in the result.');
assert.equal(serializeMerge(parsed.blocks, parsed.chunks, parsed.eol, parsed.trailingNewline), parsed.initialResult);

const base = 'a\nb\nc\nd\n';
const ours = 'a\nb_ours\nc\nd_ours\n';
const theirs = 'a\nb\nc\nd_theirs\n';
const mixed = analyze3WayDifferences(base, ours, theirs);
assert.deepEqual(mixed.chunks.map(chunk => chunk.type), ['diff-left', 'conflict']);
assert.equal(mixed.chunks[0].leftContent, 'b_ours');
assert.equal(mixed.chunks[0].resolved, true);
assert.equal(mixed.chunks[1].baseContent, 'd');
assert.equal(mixed.chunks[1].baseContent.length > 0, true);
assert.equal(mainLines(mixed), 'a\nb_ours\nc\n<<<<<<< WMERGE chunk-2 >>>>>>>\n');
assert.equal(serializeMerge(mixed.blocks, mixed.chunks, mixed.eol, mixed.trailingNewline), mixed.initialResult);

mixed.chunks[1].resultLines = mixed.chunks[1].leftContent.split('\n');
assert.equal(serializeMerge(mixed.blocks, mixed.chunks, mixed.eol, mixed.trailingNewline), 'a\nb_ours\nc\nd_ours\n');
assert.equal(describeUnresolved('a\nb_ours\nc\nd_ours\n'), null);

assert.equal(analyze3WayDifferences('a\nb\n', 'a\nb2\n', 'a\nb\n').chunks[0].type, 'diff-left');
assert.equal(analyze3WayDifferences('a\nb\n', 'a\nb2\n', 'a\nb\n').initialResult, 'a\nb2\n');
assert.equal(analyze3WayDifferences('a\nb\n', 'a\nb\n', 'a\nb2\n').chunks[0].type, 'diff-right');
assert.equal(analyze3WayDifferences('a\nb\n', 'a\nb\n', 'a\nb2\n').initialResult, 'a\nb2\n');
assert.equal(analyze3WayDifferences('a\nb\n', 'a\nx\nb\n', 'a\nb\n').initialResult, 'a\nx\nb\n');
assert.equal(analyze3WayDifferences('a\nb\n', 'a\nb\n', 'a\ny\nb\n').chunks[0].type, 'diff-right');
assert.equal(analyze3WayDifferences('a\nb\n', 'a\nb\n', 'a\ny\nb\n').initialResult, 'a\ny\nb\n');

const same = analyze3WayDifferences('a\nb\n', 'a\nb2\n', 'a\nb2\n');
assert.equal(same.chunks[0].type, 'identical');
assert.equal(same.initialResult, 'a\nb2\n');
assert.equal(describeUnresolved(same.initialResult), null);

const both = analyze3WayDifferences('a\nb\n', 'a\nL\n', 'a\nR\n');
assert.equal(both.chunks[0].type, 'conflict');
assert.equal(both.chunks[0].baseContent, 'b');

const deleted = analyze3WayDifferences('a\nb\nc\n', 'a\nc\n', 'a\nb\nc\n');
assert.equal(deleted.chunks[0].type, 'diff-left');
assert.equal(deleted.chunks[0].leftEmpty, true);
assert.equal(deleted.chunks[0].leftEndLine, deleted.chunks[0].leftStartLine - 1);
assert.equal(deleted.initialResult, 'a\nc\n');

const crlf = analyze3WayDifferences('a\r\nb\r\n', 'a\r\nbL\r\n', 'a\r\nb\r\n');
assert.equal(crlf.eol, '\r\n');
assert.equal(crlf.initialResult, 'a\r\nbL\r\n');

const unchanged = analyze3WayDifferences('a\n', 'a\n', 'a\n');
assert.equal(unchanged.chunks.length, 0);
assert.equal(unchanged.initialResult, 'a\n');

const noTrailing = analyze3WayDifferences('a\nb', 'a\nL', 'a\nR');
assert.equal(noTrailing.trailingNewline, false);
assert.equal(noTrailing.initialResult.endsWith('\n'), false);

const unclosed = parseConflictMarkers('keep\n<<<<<<< HEAD\nours line\n');
assert.ok(unclosed.parseError);
assert.equal(unclosed.chunks.length, 0);
assert.equal(unclosed.initialResult, 'keep\n<<<<<<< HEAD\nours line\n');
assert.ok(unclosed.blocks[0].lines.includes('ours line'));

const marked = parseConflictMarkers('a\r\n<<<<<<< H\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> T\r\nb\r\n');
assert.equal(marked.eol, '\r\n');
assert.equal(marked.chunks.length, 1);
assert.equal(marked.chunks[0].leftContent, 'ours');
assert.equal(marked.chunks[0].rightContent, 'theirs');
assert.ok(marked.initialResult.startsWith('a\r\n<<<<<<< WMERGE chunk-1 >>>>>>>\r\nb\r\n'));

const emptyOurs = parseConflictMarkers('a\n<<<<<<< H\n=======\nonly theirs\n>>>>>>> T\nb\n');
assert.equal(emptyOurs.chunks[0].leftEmpty, true);
assert.equal(emptyOurs.chunks[0].leftEndLine, emptyOurs.chunks[0].leftStartLine - 1);
assert.equal(emptyOurs.chunks[0].rightContent, 'only theirs');

assert.equal(hasGitConflictMarkers('just =======\n'), false);
assert.equal(describeUnresolved('just =======\n'), null);
assert.equal(describeUnresolved('all good\n'), null);
assert.ok(describeUnresolved('<<<<<<< WMERGE chunk-1 >>>>>>>'));
assert.ok(describeUnresolved('<<<<<<< HEAD\n=======\n>>>>>>> feature\n'));
assert.equal(hasGitConflictMarkers('code with <<<<<<< inside a sentence\n'), false);

assert.deepEqual(parseConflictedPaths('UU my file.txt\0'), ['my file.txt']);
assert.deepEqual(parseConflictedPaths('R  old\0new\0'), []);
assert.deepEqual(parseConflictedPaths('UU a.txt\0 M b.txt\0'), ['a.txt']);

async function gitChecks() {
  const outside = mkdtempSync(join(tmpdir(), 'wsm-plain-'));
  const plain = join(outside, 'a.txt');
  writeFileSync(plain, 'keep\n');
  const refused = await GitService.saveAndStage(plain, '<<<<<<< WMERGE chunk-1 >>>>>>>\n');
  assert.equal(refused.success, false);
  assert.equal(readFileSync(plain, 'utf8'), 'keep\n');
  rmSync(outside, { recursive: true, force: true });

  const root = mkdtempSync(join(tmpdir(), 'wsm-git-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'probe@example.com']);
  git(['config', 'user.name', 'probe']);
  git(['config', 'core.autocrlf', 'false']);

  const file = join(root, 'sample.txt');
  const spaced = join(root, 'my file.txt');
  writeFileSync(file, 'a\nb\nc\nd\n');
  writeFileSync(spaced, 'one\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  git(['checkout', '-b', 'feature']);
  writeFileSync(file, 'a\nb\nc\nd_theirs\n');
  writeFileSync(spaced, 'one theirs\n');
  git(['commit', '-am', 'theirs']);
  git(['checkout', 'main']);
  writeFileSync(file, 'a\nb_ours\nc\nd_ours\n');
  writeFileSync(spaced, 'one ours\n');
  git(['commit', '-am', 'ours']);
  try {
    git(['merge', 'feature']);
  } catch {
    // Conflicting merges exit non-zero.
  }

  const found = await GitService.findGitRoot(join(root, 'missing.txt'));
  assert.ok(found);
  assert.equal(resolve(found), resolve(root));

  const conflicts = await GitService.getConflictedFiles(root);
  assert.ok(conflicts.some(item => item.relPath === 'my file.txt'));
  assert.ok(conflicts.some(item => item.relPath === 'sample.txt'));

  const spacedData = await GitService.loadMergeData(spaced);
  assert.equal(spacedData.chunks[0].type, 'conflict');
  assert.equal(spacedData.chunks[0].baseContent, 'one');

  const data = await GitService.loadMergeData(file);
  assert.equal(data.sourceType, 'git-index');
  assert.equal(data.rightTitle, 'Incoming (feature)');
  assert.deepEqual(data.chunks.map(chunk => chunk.type), ['diff-left', 'conflict']);
  assert.equal(data.manualResolution, false);
  const blocked = await GitService.saveAndStage(file, data.initialResultContent);
  assert.equal(blocked.success, false);
  assert.ok(readFileSync(file, 'utf8').includes('<<<<<<<'));

  writeFileSync(file, 'a\nb_ours\nc\nd_ours\n');
  const manual = await GitService.loadMergeData(file);
  assert.equal(manual.manualResolution, true);

  const clean = manual.initialResultContent.split('<<<<<<< WMERGE chunk-2 >>>>>>>').join('d_ours');
  assert.equal(describeUnresolved(clean), null);
  const saved = await GitService.saveAndStage(file, clean);
  assert.equal(saved.success, true);
  assert.equal(readFileSync(file, 'utf8'), clean);
  const stillUnmerged = git(['ls-files', '-u', '--', 'sample.txt']);
  assert.equal(stillUnmerged.trim(), '');

  rmSync(root, { recursive: true, force: true });
}

gitChecks().then(() => {
  console.log('All merge tests passed.');
}).catch(err => {
  console.error(err);
  process.exit(1);
});
