const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAnalysisRunViews } = require('../src/analysis-run-view-builder');

test('analysis-run-view-builder prioritizes R qc and maps de/enrichment views', () => {
  const built = buildAnalysisRunViews({
    runId: 7,
    configRev: 3,
    configTag: 'rev-0003',
    executionPayload: {
      samples: [
        { sample: 'S1', group: 'Control' },
        { sample: 'S2', group: 'Treatment' },
      ],
      matrix: [{ gene: 'P1', values: [1, 2] }],
    },
    result: {
      qc: {
        pca: {
          explained_variance: { pc1: 61.2, pc2: 18.3 },
          points: [
            { sample_id: 'S1', group: 'Control', pc1: -1.1, pc2: 0.2, loading: 1 },
            { sample_id: 'S2', group: 'Treatment', pc1: 1.1, pc2: -0.2, loading: 1 },
          ],
        },
        correlation: {
          labels: ['S1', 'S2'],
          matrix: [
            [1, 0.8],
            [0.8, 1],
          ],
        },
      },
      de: {
        summary: {
          thresholds: { log2fc: 1, padj: 0.05 },
        },
        topTable: [
          { gene: 'P1', logFC: 2, adjPValue: 0.001 },
          { gene: 'P2', logFC: -1.5, adjPValue: 0.01 },
          { gene: 'P3', logFC: 0.1, adjPValue: 0.8 },
        ],
      },
      enrichment: {
        go: [
          { id: 'GO:1', description: 'term-a', qvalue: 0.02, genes: ['P1', 'P2'] },
        ],
        kegg: [
          { id: 'hsa00010', description: 'term-b', qvalue: 0.01, genes: ['P3'] },
        ],
      },
    },
  });

  assert.equal(built.views.pca.points.length, 2);
  assert.equal(built.views.pca.explained_variance.pc1, 61.2);
  assert.deepEqual(built.views.correlation.labels, ['S1', 'S2']);
  assert.equal(built.views.volcano.points.length, 3);
  assert.equal(built.views.volcano.points[0].category, 'up');
  assert.equal(built.views.volcano.points[1].category, 'down');
  assert.equal(built.views.enrichment.entries.length, 2);
  assert.equal(built.views.enrichment.entries[0].id, 'hsa00010');
  assert.equal(built.artifactMeta.run_id, 7);
  assert.equal(built.artifactMeta.config_rev, 3);
  assert.equal(built.artifactMeta.config_tag, 'rev-0003');
  assert.equal(built.artifactMeta.figure_profile, 'journal-default');
});

test('analysis-run-view-builder falls back to JS qc when R qc is unavailable', () => {
  const built = buildAnalysisRunViews({
    runId: 9,
    executionPayload: {
      samples: [
        { sample: 'A', group: 'Control' },
        { sample: 'B', group: 'Treatment' },
      ],
      matrix: [
        { gene: 'P1', values: [1, 2] },
        { gene: 'P2', values: [4, 8] },
      ],
    },
    result: {
      de: { topTable: [] },
      enrichment: { go: [], kegg: [] },
    },
  });

  assert.equal(built.views.pca.points.length, 2);
  assert.equal(built.views.correlation.labels.length, 2);
  assert.equal(built.views.correlation.matrix.length, 2);
});
