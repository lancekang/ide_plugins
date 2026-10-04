import { parseConflictMarkers, analyze3WayDifferences } from '../src/diffEngine.js';

console.log('--- Testing Conflict Marker Parsing ---');

const sampleMarkerContent = `function calculateTotal(items) {
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

const parsed = parseConflictMarkers(sampleMarkerContent);
console.log('Left Title:', parsed.leftTitle);
console.log('Right Title:', parsed.rightTitle);
console.log('Chunks count:', parsed.chunks.length);
console.log('Left Content:\n' + parsed.leftContent);
console.log('Right Content:\n' + parsed.rightContent);

if (parsed.chunks.length === 1 && parsed.chunks[0].type === 'conflict') {
  console.log('✔ Marker parsing verified successfully!');
} else {
  console.error('❌ Marker parsing failed!');
  process.exit(1);
}

console.log('\n--- Testing 3-Way Diff Analysis ---');
const base = `line1\nline2\nline3\n`;
const ours = `line1\nline2_modified_by_ours\nline3\n`;
const theirs = `line1\nline2_modified_by_theirs\nline3\n`;

const diffResult = analyze3WayDifferences(base, ours, theirs);
console.log('Diff chunks count:', diffResult.chunks.length);
if (diffResult.chunks.length > 0) {
  console.log('✔ 3-Way diff verified successfully!');
} else {
  console.error('❌ 3-Way diff analysis failed!');
  process.exit(1);
}

console.log('\nAll tests passed successfully!');
