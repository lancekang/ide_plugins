import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../src/gitService.js';

const testRepoDir = path.join(process.cwd(), 'demo_conflict_test');

function runGit(args: string[], cwd: string = testRepoDir): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function runRealGitConflictTest() {
  console.log('=== REAL GIT MERGE CONFLICT E2E TEST ===');

  // 1. Clean & create test git repo
  if (fs.existsSync(testRepoDir)) {
    fs.rmSync(testRepoDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testRepoDir, { recursive: true });

  console.log('1. Initializing test repository at:', testRepoDir);
  runGit(['init', '-b', 'main']);
  runGit(['config', 'user.name', 'Tester']);
  runGit(['config', 'user.email', 'tester@example.com']);

  // Base version
  const sampleFilePath = path.join(testRepoDir, 'calculator.js');
  const baseCode = `function calculate(a, b) {
  // Base version
  const op = 'add';
  return a + b;
}
module.exports = calculate;
`;
  fs.writeFileSync(sampleFilePath, baseCode, 'utf8');
  runGit(['add', 'calculator.js']);
  runGit(['commit', '-m', 'Initial base calculator']);

  // 2. Branch feature-multiply
  console.log('2. Creating feature-multiply branch and modifying calculator.js...');
  runGit(['checkout', '-b', 'feature-multiply']);
  const featureCode = `function calculate(a, b) {
  // Multiply feature by Alice
  const op = 'multiply';
  const scale = 2;
  return (a * b) * scale;
}
module.exports = calculate;
`;
  fs.writeFileSync(sampleFilePath, featureCode, 'utf8');
  runGit(['commit', '-am', 'feature: implement multiply with scale']);

  // 3. Switch back to main and make conflicting changes
  console.log('3. Switching to main branch and making conflicting changes...');
  runGit(['checkout', 'main']);
  const mainCode = `function calculate(a, b) {
  // Fast addition by Bob
  const op = 'fast-add';
  const precision = 0.01;
  return Number((a + b).toFixed(2));
}
module.exports = calculate;
`;
  fs.writeFileSync(sampleFilePath, mainCode, 'utf8');
  runGit(['commit', '-am', 'main: fast addition with precision']);

  // 4. Trigger merge conflict
  console.log('4. Merging feature-multiply into main (expecting CONFLICT)...');
  try {
    runGit(['merge', 'feature-multiply']);
  } catch (err: any) {
    console.log('✔ Git conflict successfully triggered!');
  }

  // 5. Test GitService conflict detection
  console.log('\n5. Testing GitService.getConflictedFiles()...');
  const conflicts = await GitService.getConflictedFiles(testRepoDir);
  console.log('Found conflicted files:', conflicts);
  if (conflicts.length !== 1 || conflicts[0].fileName !== 'calculator.js') {
    throw new Error('❌ Conflict detection failed!');
  }
  console.log('✔ GitService successfully detected 1 conflicted file: calculator.js');

  // 6. Test GitService.loadMergeData()
  console.log('\n6. Testing GitService.loadMergeData()...');
  const mergeData = await GitService.loadMergeData(sampleFilePath);
  console.log('Source Type:', mergeData.sourceType);
  console.log('Left Title (Ours):', mergeData.leftTitle);
  console.log('Right Title (Theirs):', mergeData.rightTitle);
  console.log('Base Title:', mergeData.baseTitle);
  console.log('Total Chunks:', mergeData.chunks.length);
  console.log('Base Content:\n' + mergeData.baseContent);
  console.log('Ours Content (Left):\n' + mergeData.leftContent);
  console.log('Theirs Content (Right):\n' + mergeData.rightContent);

  if (mergeData.sourceType !== 'git-index') {
    throw new Error('❌ Expected sourceType to be git-index!');
  }
  if (!mergeData.leftContent.includes('Fast addition by Bob') || !mergeData.rightContent.includes('Multiply feature by Alice')) {
    throw new Error('❌ Git index stage 2 or stage 3 content mismatch!');
  }
  console.log('✔ Git 3-Way Index extraction verified perfectly!');

  // 7. Test Save and Stage
  console.log('\n7. Testing resolving conflict and GitService.saveAndStage()...');
  const resolvedCode = `function calculate(a, b) {
  // Resolved: Fast addition with Alice scale
  const op = 'fast-add';
  const scale = 2;
  return Number(((a + b) * scale).toFixed(2));
}
module.exports = calculate;
`;
  const stageRes = await GitService.saveAndStage(sampleFilePath, resolvedCode);
  console.log('Save & Stage Result:', stageRes);

  if (!stageRes.success || stageRes.remainingConflicts !== 0) {
    throw new Error('❌ Save and stage failed!');
  }

  const statusAfter = runGit(['status', '--porcelain']);
  console.log('Git status after staging:', statusAfter);
  if (statusAfter.includes('UU')) {
    throw new Error('❌ File still marked as conflicted!');
  }

  console.log('✔ File is now cleanly staged! No remaining conflicts.');

  // 8. Commit the merge
  runGit(['commit', '-m', 'Merge branch feature-multiply resolved by WebStorm Merge GUI']);
  const log = runGit(['log', '--oneline', '-n', '3']);
  console.log('\nRecent git log after merge:\n' + log);

  console.log('\n🎉 ALL E2E TESTS PASSED SUCCESSFULLY! The extension works flawlessly with real Git repos!');

  // Cleanup
  fs.rmSync(testRepoDir, { recursive: true, force: true });
  console.log('Cleaned up demo_conflict_test directory.');
}

runRealGitConflictTest().catch((e) => {
  console.error(e);
  process.exit(1);
});
