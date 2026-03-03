const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseProteomicsFile } = require('../proteomicsParser');

function parseSample(fileName) {
  const p = path.join(__dirname, '..', 'samples', fileName);
  return parseProteomicsFile(fs.readFileSync(p, 'utf8'));
}

test('detects FragPipe protein table and maps summary fields', () => {
  const parsed = parseSample('fragpipe_protein.tsv');
  assert.equal(parsed.detected.sourceTool, 'FragPipe');
  assert.equal(parsed.detected.entityType, 'protein');
  assert.equal(parsed.summary.sampleCount, 2);
  assert.equal(parsed.summary.entityCount, 3);
});

test('detects DIA-NN peptide table and maps summary fields', () => {
  const parsed = parseSample('diann_peptide.tsv');
  assert.equal(parsed.detected.sourceTool, 'DIA-NN');
  assert.equal(parsed.detected.entityType, 'peptide');
  assert.equal(parsed.summary.sampleCount, 2);
  assert.equal(parsed.summary.entityCount, 2);
  assert.ok(parsed.summary.availableColumns.includes('modifiedSequence'));
});

test('detects MaxQuant protein table and maps summary fields', () => {
  const parsed = parseSample('maxquant_protein.txt');
  assert.equal(parsed.detected.sourceTool, 'MaxQuant');
  assert.equal(parsed.detected.entityType, 'protein');
  assert.equal(parsed.summary.sampleCount, 2);
  assert.equal(parsed.summary.entityCount, 2);
});

test('maps core fields with case-insensitive headers', () => {
  const content = [
    'protein ids,majority protein ids,gene names,LFQ intensity S1,LFQ intensity S2',
    'P12345;P67890,P12345,TP53,1000,900',
    'Q9Y261,Q9Y261,FOXO1,800,700',
  ].join('\n');

  const parsed = parseProteomicsFile(content);
  assert.equal(parsed.detected.sourceTool, 'MaxQuant');
  assert.equal(parsed.detected.entityType, 'protein');
  assert.equal(parsed.summary.sampleCount, 2);
  assert.equal(parsed.summary.entityCount, 2);
  assert.equal(parsed.preview[0].accession, 'P12345');
  assert.equal(parsed.preview[0].gene, 'TP53');
});
