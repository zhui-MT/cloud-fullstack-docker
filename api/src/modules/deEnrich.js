const { makeDemoPayload } = require('../demoDataset');
const { runRDeEnrich } = require('../rRunner');

const SUPPORTED_ENGINES = ['limma', 'DEqMS', 'MSstats', 'SAM', 'RankProd'];

function buildModuleRunners() {
  return {
    de: runDeModule,
    enrichment: runEnrichmentModule,
    'de-enrich': runDeEnrichModule,
  };
}

async function runDeModule(payload, appendLog, context) {
  maybeThrowCanceled(context);
  const prepared = makeDemoPayload(payload);
  validateEngine(prepared.engine);

  if (prepared.engine !== 'limma') {
    throw makeNotImplementedEngineError(prepared.engine);
  }

  try {
    appendLog('info', 'Trying limma via R runtime');
    const result = await runRDeEnrich({ mode: 'de', payload: prepared }, appendLog, context);
    result.runtime = { backend: 'R', deEngine: 'limma' };
    return {
      module: 'de',
      engine: prepared.engine,
      ...result,
    };
  } catch (error) {
    if (isCanceledError(error)) throw error;
    appendLog('warn', `R limma unavailable, fallback to JS: ${error.message}`);
    const result = runJsDe(prepared, context);
    result.runtime = { backend: 'JS_FALLBACK', deEngine: 'limma-approx' };
    return {
      module: 'de',
      engine: prepared.engine,
      ...result,
    };
  }
}

async function runEnrichmentModule(payload, appendLog, context) {
  maybeThrowCanceled(context);
  const prepared = makeDemoPayload(payload);
  validateEngine(prepared.engine);

  if (prepared.engine !== 'limma') {
    throw makeNotImplementedEngineError(prepared.engine);
  }

  try {
    appendLog('info', 'Running enrichment via R runtime (clusterProfiler)');
    const result = await runRDeEnrich({ mode: 'enrichment', payload: prepared }, appendLog, context);
    result.runtime = { backend: 'R', enrichmentEngine: 'clusterProfiler' };
    return {
      module: 'enrichment',
      engine: prepared.engine,
      ...result,
    };
  } catch (error) {
    if (isCanceledError(error)) throw error;
    appendLog('warn', `R enrichment unavailable, fallback to JS: ${error.message}`);
    const deResult = runJsDe(prepared, context);
    const enrich = runJsEnrichment(deResult.significantGenes, context);
    return {
      module: 'enrichment',
      engine: prepared.engine,
      de: deResult.de,
      significantGenes: deResult.significantGenes,
      enrichment: enrich,
      runtime: { backend: 'JS_FALLBACK', enrichmentEngine: 'hypergeom-lite' },
    };
  }
}

async function runDeEnrichModule(payload, appendLog, context) {
  maybeThrowCanceled(context);
  const prepared = makeDemoPayload(payload);
  validateEngine(prepared.engine);

  if (prepared.engine !== 'limma') {
    throw makeNotImplementedEngineError(prepared.engine);
  }

  try {
    appendLog('info', 'Running limma + clusterProfiler via R runtime');
    const result = await runRDeEnrich({ mode: 'de-enrich', payload: prepared }, appendLog, context);
    result.runtime = { backend: 'R', deEngine: 'limma', enrichmentEngine: 'clusterProfiler' };
    return {
      module: 'de-enrich',
      engine: prepared.engine,
      ...result,
    };
  } catch (error) {
    if (isCanceledError(error)) throw error;
    appendLog('warn', `R chain unavailable, fallback to JS: ${error.message}`);
    const deResult = runJsDe(prepared, context);
    const enrichment = runJsEnrichment(deResult.significantGenes, context);
    return {
      module: 'de-enrich',
      engine: prepared.engine,
      de: deResult.de,
      significantGenes: deResult.significantGenes,
      enrichment,
      runtime: { backend: 'JS_FALLBACK', deEngine: 'limma-approx', enrichmentEngine: 'hypergeom-lite' },
    };
  }
}

function validateEngine(engine) {
  if (!SUPPORTED_ENGINES.includes(engine)) {
    const err = new Error(`engine must be one of: ${SUPPORTED_ENGINES.join(', ')}`);
    err.code = 'UNSUPPORTED_ENGINE';
    throw err;
  }
}

function makeNotImplementedEngineError(engine) {
  const err = new Error(`engine '${engine}' entry is available but not implemented yet; currently only limma is wired`);
  err.code = 'ENGINE_NOT_IMPLEMENTED';
  return err;
}

function runJsDe(prepared, context) {
  maybeThrowCanceled(context);
  const groupA = prepared.de.groupA;
  const groupB = prepared.de.groupB;
  const sampleGroups = prepared.samples.map((s) => s.group);

  const indexA = [];
  const indexB = [];

  sampleGroups.forEach((group, idx) => {
    if (group === groupA) indexA.push(idx);
    if (group === groupB) indexB.push(idx);
  });

  if (indexA.length < 2 || indexB.length < 2) {
    const err = new Error('need at least 2 replicates per group for DE fallback');
    err.code = 'INVALID_DESIGN';
    throw err;
  }

  const rows = [];
  for (let idx = 0; idx < prepared.matrix.length; idx += 1) {
    if (idx % 4 === 0) {
      maybeThrowCanceled(context);
    }
    const row = prepared.matrix[idx];
    const a = indexA.map((idx) => row.values[idx]);
    const b = indexB.map((idx) => row.values[idx]);
    const meanA = mean(a);
    const meanB = mean(b);
    const logFC = meanB - meanA;
    const t = welchT(a, b);
    const pvalue = twoTailPFromZ(Math.abs(t));

    rows.push({
      gene: row.gene,
      logFC: round(logFC),
      pvalue,
    });
  }

  const padj = bhAdjust(rows.map((x) => x.pvalue));
  const withAdj = rows.map((row, idx) => ({ ...row, adjPValue: padj[idx] }));
  withAdj.sort((a, b) => a.adjPValue - b.adjPValue);

  const sig = withAdj
    .filter((row) => row.adjPValue <= prepared.de.padjThreshold && Math.abs(row.logFC) >= prepared.de.log2fcThreshold)
    .map((row) => row.gene);

  return {
    de: {
      summary: {
        totalGenes: withAdj.length,
        significantGenes: sig.length,
        thresholds: {
          log2fc: prepared.de.log2fcThreshold,
          padj: prepared.de.padjThreshold,
        },
      },
      topTable: withAdj.slice(0, 20),
    },
    significantGenes: sig,
  };
}

function runJsEnrichment(genes, context) {
  maybeThrowCanceled(context);
  const uniqueGenes = Array.from(new Set(genes));
  const sets = [
    {
      db: 'GO',
      id: 'GO:0006954',
      description: 'inflammatory response',
      genes: ['IL6', 'TNF', 'NFKB1', 'STAT3', 'TP53'],
    },
    {
      db: 'GO',
      id: 'GO:0008283',
      description: 'cell population proliferation',
      genes: ['MYC', 'EGFR', 'AKT1', 'MTOR', 'CDK1', 'CCNB1'],
    },
    {
      db: 'KEGG',
      id: 'hsa04151',
      description: 'PI3K-Akt signaling pathway',
      genes: ['AKT1', 'PIK3CA', 'MTOR', 'EGFR', 'KRAS'],
    },
    {
      db: 'KEGG',
      id: 'hsa04010',
      description: 'MAPK signaling pathway',
      genes: ['MAPK1', 'KRAS', 'JUN', 'FOS', 'EGFR'],
    },
  ];

  const bgSize = 20000;
  const q = uniqueGenes.length;

  const rows = sets
    .map((set, idx) => {
      if (idx % 2 === 0) {
        maybeThrowCanceled(context);
      }
      const overlap = set.genes.filter((g) => uniqueGenes.includes(g));
      const k = overlap.length;
      if (k === 0) return null;

      const pvalue = fisherRightTailApprox(k, set.genes.length, bgSize, q);
      return {
        db: set.db,
        id: set.id,
        description: set.description,
        geneRatio: `${k}/${q}`,
        bgRatio: `${set.genes.length}/${bgSize}`,
        pvalue,
        genes: overlap,
      };
    })
    .filter(Boolean);

  const padj = bhAdjust(rows.map((x) => x.pvalue));
  const withAdj = rows.map((row, idx) => ({ ...row, qvalue: padj[idx] }));
  const go = withAdj.filter((x) => x.db === 'GO').sort((a, b) => a.qvalue - b.qvalue);
  const kegg = withAdj.filter((x) => x.db === 'KEGG').sort((a, b) => a.qvalue - b.qvalue);

  return {
    go: go.slice(0, 10),
    kegg: kegg.slice(0, 10),
  };
}

function mean(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function variance(arr, arrMean) {
  if (arr.length <= 1) return 0;
  const sum = arr.reduce((s, x) => s + (x - arrMean) ** 2, 0);
  return sum / (arr.length - 1);
}

function welchT(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a, ma);
  const vb = variance(b, mb);

  const denom = Math.sqrt(va / a.length + vb / b.length);
  if (denom === 0) return 0;
  return (mb - ma) / denom;
}

function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function twoTailPFromZ(zAbs) {
  const p = 2 * (1 - normalCdf(zAbs));
  return clamp01(round(Math.max(p, 1e-12)));
}

function bhAdjust(pvalues) {
  const m = pvalues.length;
  if (m === 0) return [];

  const indexed = pvalues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array(m);
  let prev = 1;

  for (let rank = m; rank >= 1; rank -= 1) {
    const entry = indexed[rank - 1];
    const raw = (entry.p * m) / rank;
    prev = Math.min(prev, raw);
    adjusted[entry.i] = clamp01(round(prev));
  }

  return adjusted;
}

function fisherRightTailApprox(k, m, n, q) {
  const expected = (m * q) / n;
  if (expected <= 0) return 1;
  const z = (k - expected) / Math.sqrt(expected);
  const p = 1 - normalCdf(z);
  return clamp01(round(Math.max(p, 1e-12)));
}

function round(num) {
  return Number(num.toFixed(6));
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function maybeThrowCanceled(context) {
  if (context && typeof context.throwIfCanceled === 'function') {
    context.throwIfCanceled();
  }
}

function isCanceledError(error) {
  if (!error) return false;
  return error.code === 'JOB_CANCELED' || error.name === 'AbortError';
}

module.exports = {
  buildModuleRunners,
  SUPPORTED_ENGINES,
};
