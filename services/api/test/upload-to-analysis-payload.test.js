const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AnalysisPayloadValidationError,
  uploadToAnalysisPayload,
} = require('../src/upload-to-analysis-payload');

test('upload-to-analysis-payload maps rows, samples, and groups correctly', () => {
  const payload = uploadToAnalysisPayload({
    engine: 'limma',
    de: {
      groupA: 'Control',
      groupB: 'Treatment',
      log2fcThreshold: 0.58,
      padjThreshold: 0.05,
    },
    enrichment: {
      species: 'human',
      pvalueCutoff: 0.05,
      qvalueCutoff: 0.2,
    },
    sampleColumns: ['S_control_1', 'S_treat_1', 'S_unknown_1'],
    sampleGroups: {
      S_control_1: 'Control',
      S_treat_1: 'Treatment',
    },
    mappedRows: [
      {
        entityType: 'protein',
        accession: 'P12345',
        quantities: {
          S_control_1: 10,
          S_treat_1: 20,
          S_unknown_1: 999,
        },
      },
      {
        entityType: 'peptide',
        modifiedSequence: 'AAAAK(UniMod:35)',
        quantities: {
          S_control_1: 5,
          S_treat_1: 8,
          S_unknown_1: 100,
        },
      },
    ],
  });

  assert.equal(payload.samples.length, 2);
  assert.deepEqual(
    payload.samples.map((row) => row.sample),
    ['S_control_1', 'S_treat_1']
  );
  assert.deepEqual(payload.samples.map((row) => row.group), ['Control', 'Treatment']);
  assert.equal(payload.matrix.length, 2);
  assert.deepEqual(
    payload.matrix.map((row) => row.gene),
    ['P12345', 'AAAAK(UniMod:35)']
  );
  assert.deepEqual(payload.matrix[0].values, [10, 20]);
  assert.deepEqual(payload.matrix[1].values, [5, 8]);
});

test('upload-to-analysis-payload merges duplicated entities by per-sample mean', () => {
  const payload = uploadToAnalysisPayload({
    sampleColumns: ['S_control_1', 'S_treat_1'],
    sampleGroups: {
      S_control_1: 'Control',
      S_treat_1: 'Treatment',
    },
    de: { groupA: 'Control', groupB: 'Treatment' },
    mappedRows: [
      {
        entityType: 'protein',
        accession: 'P12345',
        quantities: { S_control_1: 1, S_treat_1: 5 },
      },
      {
        entityType: 'protein',
        accession: 'P12345',
        quantities: { S_control_1: 3, S_treat_1: 7 },
      },
      {
        entityType: 'protein',
        accession: 'Q9Y261',
        quantities: { S_control_1: 2, S_treat_1: 4 },
      },
    ],
  });

  assert.equal(payload.matrix.length, 2);
  assert.equal(payload.matrix[0].gene, 'P12345');
  assert.equal(payload.matrix[0].values[0], 2);
  assert.equal(payload.matrix[0].values[1], 6);
});

test('upload-to-analysis-payload throws readable validation errors for invalid inputs', () => {
  assert.throws(
    () =>
      uploadToAnalysisPayload({
        sampleColumns: [],
        mappedRows: [],
      }),
    (error) => {
      assert.equal(error instanceof AnalysisPayloadValidationError, true);
      assert.ok(error.details.some((item) => item.includes('sample columns')));
      return true;
    }
  );

  assert.throws(
    () =>
      uploadToAnalysisPayload({
        sampleColumns: ['Sample_1', 'Sample_2'],
        mappedRows: [
          {
            entityType: 'protein',
            accession: 'P1',
            quantities: { Sample_1: null, Sample_2: null },
          },
        ],
      }),
    (error) => {
      assert.equal(error instanceof AnalysisPayloadValidationError, true);
      assert.ok(error.details.some((item) => item.includes('both DE groups')));
      assert.ok(error.details.some((item) => item.includes('analysis matrix is empty')));
      return true;
    }
  );
});
