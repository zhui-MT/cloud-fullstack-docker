function makeDemoPayload(input = {}) {
  if (input && input.matrix && input.samples) {
    return input;
  }

  const genes = [
    'TP53', 'EGFR', 'MYC', 'AKT1', 'MTOR', 'STAT3', 'JUN', 'FOS', 'CDK1', 'CCNB1',
    'GAPDH', 'ACTB', 'HIF1A', 'NFKB1', 'MAPK1', 'KRAS', 'PIK3CA', 'VEGFA', 'IL6', 'TNF',
  ];

  const samples = [
    { sample: 'A1', group: 'A' },
    { sample: 'A2', group: 'A' },
    { sample: 'A3', group: 'A' },
    { sample: 'B1', group: 'B' },
    { sample: 'B2', group: 'B' },
    { sample: 'B3', group: 'B' },
  ];

  const baseline = [
    9.2, 8.6, 8.9, 8.4, 8.7, 8.1, 7.9, 7.8, 8.0, 8.2,
    10.1, 9.8, 7.5, 8.3, 8.5, 8.1, 7.7, 7.6, 7.2, 7.1,
  ];

  const delta = [
    1.1, 0.8, 0.7, 0.6, 0.9, 1.2, 1.0, 0.9, 0.5, 0.6,
    0.0, 0.0, 0.7, 0.8, 0.4, 0.3, 0.6, 0.5, 1.3, 1.4,
  ];

  const matrix = genes.map((gene, idx) => {
    const a = [
      baseline[idx] + 0.05,
      baseline[idx] - 0.06,
      baseline[idx] + 0.01,
    ];
    const b = [
      baseline[idx] + delta[idx] + 0.04,
      baseline[idx] + delta[idx] - 0.05,
      baseline[idx] + delta[idx] + 0.02,
    ];

    return {
      gene,
      values: [...a, ...b],
    };
  });

  return {
    engine: input.engine || 'limma',
    de: {
      groupA: input?.de?.groupA || 'A',
      groupB: input?.de?.groupB || 'B',
      log2fcThreshold: Number(input?.de?.log2fcThreshold ?? 0.58),
      padjThreshold: Number(input?.de?.padjThreshold ?? 0.05),
    },
    enrichment: {
      species: input?.enrichment?.species || 'human',
      pvalueCutoff: Number(input?.enrichment?.pvalueCutoff ?? 0.05),
      qvalueCutoff: Number(input?.enrichment?.qvalueCutoff ?? 0.2),
    },
    genes,
    samples,
    matrix,
  };
}

module.exports = {
  makeDemoPayload,
};
