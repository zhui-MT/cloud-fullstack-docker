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

async function runDeModule(payload, appendLog, executionContext = {}) {
  const prepared = prepareExecutionInput(makeDemoPayload(payload), executionContext, appendLog);
  validateEngine(prepared.engine);

  if (prepared.engine !== 'limma') {
    throw makeNotImplementedEngineError(prepared.engine);
  }

  let result;
  try {
    appendLog('info', 'Trying limma via R runtime');
    result = await runRDeEnrich({ mode: 'de', payload: prepared }, appendLog);
    result.runtime = { backend: 'R', deEngine: 'limma' };
  } catch (error) {
    appendLog('warn', `R limma unavailable, fallback to JS: ${error.message}`);
    result = runJsDe(prepared);
    result.runtime = { backend: 'JS_FALLBACK', deEngine: 'limma-approx' };
  }

  return {
    module: 'de',
    engine: prepared.engine,
    ...result,
  };
}

async function runEnrichmentModule(payload, appendLog, executionContext = {}) {
  const prepared = prepareExecutionInput(makeDemoPayload(payload), executionContext, appendLog);
  validateEngine(prepared.engine);

  let deResult;
  if (prepared.engine !== 'limma') {
    throw makeNotImplementedEngineError(prepared.engine);
  }

  try {
    appendLog('info', 'Running enrichment via R runtime (clusterProfiler)');
    const rResult = await runRDeEnrich({ mode: 'enrichment', payload: prepared }, appendLog);
    rResult.runtime = { backend: 'R', enrichmentEngine: 'clusterProfiler' };
    return {
      module: 'enrichment',
      engine: prepared.engine,
      ...rResult,
    };
  } catch (error) {
    appendLog('warn', `R enrichment unavailable, fallback to JS: ${error.message}`);
    deResult = runJsDe(prepared);
    const enrich = runJsEnrichment(deResult.significantGenes);
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

async function runDeEnrichModule(payload, appendLog, executionContext = {}) {
  const prepared = prepareExecutionInput(makeDemoPayload(payload), executionContext, appendLog);
  validateEngine(prepared.engine);

  if (prepared.engine !== 'limma') {
    throw makeNotImplementedEngineError(prepared.engine);
  }

  try {
    appendLog('info', 'Running limma + clusterProfiler via R runtime');
    const rResult = await runRDeEnrich({ mode: 'de-enrich', payload: prepared }, appendLog);
    rResult.runtime = { backend: 'R', deEngine: 'limma', enrichmentEngine: 'clusterProfiler' };
    return {
      module: 'de-enrich',
      engine: prepared.engine,
      ...rResult,
    };
  } catch (error) {
    appendLog('warn', `R chain unavailable, fallback to JS: ${error.message}`);
    const deResult = runJsDe(prepared);
    const enrichment = runJsEnrichment(deResult.significantGenes);

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

function prepareExecutionInput(prepared, executionContext, appendLog) {
  const config = executionContext && executionContext.config ? executionContext.config : null;
  if (!config) {
    return prepared;
  }

  appendLog('info', `Applying preprocessing config rev=${executionContext.configTrace?.config_rev || 'unknown'}`);
  return applyPreprocessingConfig(prepared, config, appendLog);
}

function applyPreprocessingConfig(prepared, config, appendLog) {
  const next = {
    ...prepared,
    matrix: prepared.matrix.map((row) => ({
      ...row,
      values: row.values.slice(),
    })),
  };
  const preprocessingSummary = {
    config_seed: config.seed,
  };
  next.preprocessing_config = normalizePreprocessingConfig(config);

  const beforeRows = next.matrix.length;
  applyFiltering(next, config);
  const filteredOut = beforeRows - next.matrix.length;
  preprocessingSummary.filtering = {
    algorithm: config.filtering?.algorithm || 'rule-based',
    removed_rows: filteredOut,
  };
  if (filteredOut > 0) {
    appendLog('info', `Filtering removed ${filteredOut} rows`);
  }

  preprocessingSummary.imputation = applyImputation(next, config);
  preprocessingSummary.normalization = applyNormalization(next, config);
  preprocessingSummary.batch_correction = applyBatchCorrection(next, config, appendLog);
  next.preprocessing = preprocessingSummary;
  appendLog(
    'info',
    `Preprocessing summary: ${JSON.stringify({
      filtering: preprocessingSummary.filtering,
      imputation: preprocessingSummary.imputation,
      normalization: preprocessingSummary.normalization,
      batch_correction: preprocessingSummary.batch_correction,
    })}`
  );

  return next;
}

function applyFiltering(prepared, config) {
  const filtering = config.filtering || {};
  const algorithm = filtering.algorithm || 'rule-based';
  const params = filtering.params || {};
  if (algorithm !== 'rule-based') {
    return;
  }

  if (params.low_variance_filter) {
    const threshold = Number(params.variance_threshold || 0);
    prepared.matrix = prepared.matrix.filter((row) => {
      const numeric = row.values.filter((value) => Number.isFinite(value));
      if (numeric.length <= 1) return false;
      return variance(numeric, mean(numeric)) >= threshold;
    });
  }
}

function applyImputation(prepared, config) {
  const imputation = config.imputation || {};
  const algorithm = imputation.algorithm || 'none';
  if (algorithm === 'none') {
    return { algorithm, imputed_count: 0 };
  }

  const params = imputation.params || {};
  const seed = Number.isInteger(config.seed) ? config.seed : 42;
  const imputedCount = imputeUsingAlgorithm(prepared, algorithm, params, seed);
  return { algorithm, imputed_count: imputedCount };
}

function applyNormalization(prepared, config) {
  const normalization = config.normalization || {};
  const algorithm = normalization.algorithm || 'no-normalization';
  const params = normalization.params || {};

  if (algorithm === 'no-normalization') {
    return { algorithm };
  }

  if (algorithm === 'median') {
    const medians = sampleMedians(prepared.matrix);
    const globalMedian = median(medians.filter((value) => Number.isFinite(value)));
    for (const row of prepared.matrix) {
      row.values = row.values.map((value, idx) =>
        Number.isFinite(value) && Number.isFinite(medians[idx]) ? value - medians[idx] + globalMedian : value
      );
    }
    return { algorithm };
  }

  if (algorithm === 'z-score') {
    const by = params.by || 'feature';
    if (by === 'feature') {
      for (const row of prepared.matrix) {
        const numeric = row.values.filter((value) => Number.isFinite(value));
        const mu = mean(numeric);
        const sd = Math.sqrt(Math.max(variance(numeric, mu), 1e-12));
        row.values = row.values.map((value) => (Number.isFinite(value) ? (value - mu) / sd : value));
      }
    } else {
      const sampleCount = prepared.samples.length;
      const sampleMeans = [];
      const sampleSds = [];
      for (let idx = 0; idx < sampleCount; idx += 1) {
        const numeric = prepared.matrix.map((row) => row.values[idx]).filter((value) => Number.isFinite(value));
        const mu = mean(numeric);
        const sd = Math.sqrt(Math.max(variance(numeric, mu), 1e-12));
        sampleMeans.push(mu);
        sampleSds.push(sd);
      }
      for (const row of prepared.matrix) {
        row.values = row.values.map((value, idx) =>
          Number.isFinite(value) ? (value - sampleMeans[idx]) / sampleSds[idx] : value
        );
      }
    }
  }

  return { algorithm };
}

function applyBatchCorrection(prepared, config, appendLog) {
  const batchCorrection = config.batch_correction || {};
  const algorithm = batchCorrection.algorithm || 'none';
  if (algorithm === 'none') {
    return { algorithm, corrected: false };
  }

  const batchField = (batchCorrection.params && batchCorrection.params.group_field) || 'batch';
  const batches = prepared.samples.map((sample) => sample && sample[batchField]);
  if (!batches.some(Boolean)) {
    appendLog('warn', `Batch correction skipped: no sample.${batchField} found`);
    return { algorithm, corrected: false, batch_field: batchField };
  }

  const batchGroups = {};
  batches.forEach((batch, idx) => {
    if (!batch) return;
    if (!batchGroups[batch]) batchGroups[batch] = [];
    batchGroups[batch].push(idx);
  });

  for (const row of prepared.matrix) {
    const globalMean = mean(row.values.filter((value) => Number.isFinite(value)));
    for (const indices of Object.values(batchGroups)) {
      const values = indices.map((idx) => row.values[idx]).filter((value) => Number.isFinite(value));
      if (values.length === 0) continue;
      const batchMean = mean(values);
      for (const idx of indices) {
        if (!Number.isFinite(row.values[idx])) continue;
        row.values[idx] = row.values[idx] - batchMean + globalMean;
      }
    }
  }

  return {
    algorithm,
    corrected: true,
    batch_field: batchField,
    batch_groups: Object.keys(batchGroups).length,
  };
}

function imputeUsingAlgorithm(prepared, algorithm, params, seed) {
  switch (algorithm) {
    case 'min-half':
      return imputeWithRowMinimumHalf(prepared);
    case 'left-shift-gaussian':
      return imputeWithLeftShiftGaussian(prepared, params, seed);
    case 'minprob':
      return imputeWithMinProb(prepared, params, seed);
    case 'QRILC':
      return imputeWithQrilcLike(prepared, params, seed);
    case 'KNN':
      return imputeWithKnn(prepared, params);
    case 'SVD':
      return imputeWithSvdLike(prepared, params);
    case 'BPCA':
      return imputeWithBpcaLike(prepared, params);
    case 'missForest':
      return imputeWithMissForestLike(prepared);
    case 'hybrid':
      return imputeWithHybrid(prepared, params, seed);
    default:
      return imputeWithRowMinimumHalf(prepared);
  }
}

function imputeWithRowMinimumHalf(prepared) {
  return replaceMissing(prepared, (context) => context.rowMin / 2);
}

function imputeWithLeftShiftGaussian(prepared, params, seed) {
  const downshift = Number(params.downshift ?? 1.8);
  const width = Number(params.width ?? 0.3);
  const rng = createDeterministicRng(seed ^ hashStringLite('left-shift-gaussian'));

  return replaceMissing(prepared, (context) => {
    const sd = Math.sqrt(Math.max(context.rowVariance, 1e-12));
    const center = context.rowMean - downshift * sd;
    const noise = nextGaussian(rng) * width * sd;
    return center + noise;
  });
}

function imputeWithMinProb(prepared, params, seed) {
  const q = Number(params.q ?? 0.01);
  const rng = createDeterministicRng(seed ^ hashStringLite('minprob'));
  const allFinite = collectFinite(prepared.matrix);
  const globalFloor = quantile(allFinite, clamp(q, 0.0001, 0.5));

  return replaceMissing(prepared, () => {
    const factor = 0.85 + rng() * 0.3;
    return globalFloor * factor;
  });
}

function imputeWithQrilcLike(prepared, params, seed) {
  const tuneSigma = Number(params.tune_sigma ?? 1);
  const rng = createDeterministicRng(seed ^ hashStringLite('QRILC'));
  const allFinite = collectFinite(prepared.matrix);
  const q1 = quantile(allFinite, 0.25);
  const q3 = quantile(allFinite, 0.75);
  const iqr = Math.max(q3 - q1, 1e-6);
  const center = q1 - tuneSigma * 0.25 * iqr;
  const spread = 0.15 * iqr;

  return replaceMissing(prepared, () => {
    const sampled = center + nextGaussian(rng) * spread;
    return Math.min(sampled, q1);
  });
}

function imputeWithKnn(prepared, params) {
  const k = Math.max(1, Number(params.k ?? 5));
  let imputed = 0;

  const sampleCount = prepared.samples.length;
  const columnFallback = computeColumnMeans(prepared.matrix, sampleCount);
  const globalMeanRaw = mean(collectFinite(prepared.matrix));
  const globalFallback = Number.isFinite(globalMeanRaw) ? globalMeanRaw : 0;

  for (let rowIdx = 0; rowIdx < prepared.matrix.length; rowIdx += 1) {
    const row = prepared.matrix[rowIdx];
    for (let colIdx = 0; colIdx < row.values.length; colIdx += 1) {
      if (Number.isFinite(row.values[colIdx])) continue;

      const neighbors = [];
      for (let otherIdx = 0; otherIdx < prepared.matrix.length; otherIdx += 1) {
        if (otherIdx === rowIdx) continue;
        const other = prepared.matrix[otherIdx];
        if (!Number.isFinite(other.values[colIdx])) continue;

        let distance = 0;
        let overlap = 0;
        for (let s = 0; s < sampleCount; s += 1) {
          if (s === colIdx) continue;
          const a = row.values[s];
          const b = other.values[s];
          if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
          distance += Math.abs(a - b);
          overlap += 1;
        }
        if (overlap === 0) continue;
        neighbors.push({ value: other.values[colIdx], distance: distance / overlap });
      }

      neighbors.sort((a, b) => a.distance - b.distance);
      const top = neighbors.slice(0, k).map((entry) => entry.value).filter((value) => Number.isFinite(value));
      const replacement = top.length
        ? mean(top)
        : Number.isFinite(columnFallback[colIdx])
        ? columnFallback[colIdx]
        : globalFallback;
      row.values[colIdx] = replacement;
      imputed += 1;
    }
  }

  return imputed;
}

function imputeWithSvdLike(prepared, params) {
  const rank = Math.max(1, Number(params.rank ?? 3));
  const sampleCount = prepared.samples.length;
  const columnMeans = computeColumnMeans(prepared.matrix, sampleCount);
  const globalMeanRaw = mean(collectFinite(prepared.matrix));
  const globalMean = Number.isFinite(globalMeanRaw) ? globalMeanRaw : 0;
  let imputed = 0;

  for (const row of prepared.matrix) {
    const rowFinite = row.values.filter((value) => Number.isFinite(value));
    const rowMean = rowFinite.length ? mean(rowFinite) : globalMean;
    for (let colIdx = 0; colIdx < row.values.length; colIdx += 1) {
      if (Number.isFinite(row.values[colIdx])) continue;
      const colMean = Number.isFinite(columnMeans[colIdx]) ? columnMeans[colIdx] : globalMean;
      row.values[colIdx] = (rank * colMean + rowMean) / (rank + 1);
      imputed += 1;
    }
  }

  return imputed;
}

function imputeWithBpcaLike(prepared, params) {
  const maxIter = Math.min(Math.max(1, Number(params.max_iter ?? 200)), 20);
  const sampleCount = prepared.samples.length;
  const missingMask = prepared.matrix.map((row) => row.values.map((value) => !Number.isFinite(value)));
  const initialMeans = computeColumnMeans(prepared.matrix, sampleCount);
  const globalMeanRaw = mean(collectFinite(prepared.matrix));
  const globalMean = Number.isFinite(globalMeanRaw) ? globalMeanRaw : 0;

  for (const row of prepared.matrix) {
    for (let colIdx = 0; colIdx < row.values.length; colIdx += 1) {
      if (!Number.isFinite(row.values[colIdx])) {
        row.values[colIdx] = Number.isFinite(initialMeans[colIdx]) ? initialMeans[colIdx] : globalMean;
      }
    }
  }

  for (let iter = 0; iter < maxIter; iter += 1) {
    const columnMeans = computeColumnMeans(prepared.matrix, sampleCount);
    for (let rowIdx = 0; rowIdx < prepared.matrix.length; rowIdx += 1) {
      const row = prepared.matrix[rowIdx];
      const rowMean = mean(row.values.filter((value) => Number.isFinite(value)));
      for (let colIdx = 0; colIdx < row.values.length; colIdx += 1) {
        const colMean = Number.isFinite(columnMeans[colIdx]) ? columnMeans[colIdx] : globalMean;
        if (missingMask[rowIdx][colIdx]) {
          row.values[colIdx] = 0.6 * colMean + 0.4 * rowMean;
        }
      }
    }
  }

  let imputed = 0;
  for (let i = 0; i < prepared.matrix.length; i += 1) {
    for (let j = 0; j < prepared.matrix[i].values.length; j += 1) {
      if (missingMask[i][j]) {
        imputed += 1;
      }
    }
  }
  return imputed;
}

function imputeWithMissForestLike(prepared) {
  const sampleCount = prepared.samples.length;
  const columnMedians = computeColumnMedians(prepared.matrix, sampleCount);
  const globalMedianRaw = median(collectFinite(prepared.matrix));
  const globalMedian = Number.isFinite(globalMedianRaw) ? globalMedianRaw : 0;
  let imputed = 0;

  for (const row of prepared.matrix) {
    for (let colIdx = 0; colIdx < row.values.length; colIdx += 1) {
      if (Number.isFinite(row.values[colIdx])) continue;
      row.values[colIdx] = Number.isFinite(columnMedians[colIdx]) ? columnMedians[colIdx] : globalMedian;
      imputed += 1;
    }
  }

  return imputed;
}

function imputeWithHybrid(prepared, params, seed) {
  const marMethod = params.mar_method || 'KNN';
  const mnarMethod = params.mnar_method || 'left-shift-gaussian';
  const originalMissingMask = prepared.matrix.map((row) => row.values.map((value) => !Number.isFinite(value)));
  const rowMissingRatios = prepared.matrix.map((row) => {
    const missingCount = row.values.filter((value) => !Number.isFinite(value)).length;
    return row.values.length === 0 ? 0 : missingCount / row.values.length;
  });

  const marClone = clonePrepared(prepared);
  const mnarClone = clonePrepared(prepared);
  imputeUsingAlgorithm(marClone, marMethod, {}, seed ^ hashStringLite('hybrid-mar'));
  imputeUsingAlgorithm(mnarClone, mnarMethod, {}, seed ^ hashStringLite('hybrid-mnar'));

  let imputed = 0;
  for (let i = 0; i < prepared.matrix.length; i += 1) {
    for (let j = 0; j < prepared.matrix[i].values.length; j += 1) {
      if (!originalMissingMask[i][j]) continue;
      const useMnar = rowMissingRatios[i] >= 0.4;
      prepared.matrix[i].values[j] = useMnar ? mnarClone.matrix[i].values[j] : marClone.matrix[i].values[j];
      imputed += 1;
    }
  }

  return imputed;
}

function replaceMissing(prepared, replacer) {
  let imputed = 0;
  for (const row of prepared.matrix) {
    const finite = row.values.filter((value) => Number.isFinite(value));
    const rowMin = finite.length ? Math.min(...finite) : 0;
    const rowMean = finite.length ? mean(finite) : 0;
    const rowVariance = finite.length > 1 ? variance(finite, rowMean) : 0;
    for (let idx = 0; idx < row.values.length; idx += 1) {
      if (Number.isFinite(row.values[idx])) continue;
      const filled = replacer({
        row,
        rowMin,
        rowMean,
        rowVariance,
        sampleIndex: idx,
      });
      row.values[idx] = Number.isFinite(filled) ? filled : rowMean;
      imputed += 1;
    }
  }
  return imputed;
}

function clonePrepared(prepared) {
  return {
    ...prepared,
    matrix: prepared.matrix.map((row) => ({
      ...row,
      values: row.values.slice(),
    })),
  };
}

function normalizePreprocessingConfig(config) {
  return {
    seed: config.seed,
    filtering: config.filtering || null,
    imputation: config.imputation || null,
    normalization: config.normalization || null,
    batch_correction: config.batch_correction || null,
  };
}

function createDeterministicRng(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nextGaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function hashStringLite(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function collectFinite(matrix) {
  return matrix.flatMap((row) => row.values).filter((value) => Number.isFinite(value));
}

function computeColumnMeans(matrix, sampleCount) {
  const out = new Array(sampleCount).fill(NaN);
  for (let idx = 0; idx < sampleCount; idx += 1) {
    const values = matrix.map((row) => row.values[idx]).filter((value) => Number.isFinite(value));
    out[idx] = values.length ? mean(values) : NaN;
  }
  return out;
}

function computeColumnMedians(matrix, sampleCount) {
  const out = new Array(sampleCount).fill(NaN);
  for (let idx = 0; idx < sampleCount; idx += 1) {
    const values = matrix.map((row) => row.values[idx]).filter((value) => Number.isFinite(value));
    out[idx] = values.length ? median(values) : NaN;
  }
  return out;
}

function quantile(values, q) {
  if (!values || values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = (sorted.length - 1) * clamp(q, 0, 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function runJsDe(prepared) {
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

  const rows = prepared.matrix.map((row) => {
    const nonNumericIndex = row.values.findIndex((value) => !Number.isFinite(value));
    if (nonNumericIndex >= 0) {
      const err = new Error(`non-numeric value found at gene=${row.gene}, sampleIndex=${nonNumericIndex}`);
      err.code = 'INVALID_NUMERIC_MATRIX';
      throw err;
    }

    const a = indexA.map((idx) => row.values[idx]);
    const b = indexB.map((idx) => row.values[idx]);
    const meanA = mean(a);
    const meanB = mean(b);
    const logFC = meanB - meanA;
    const t = welchT(a, b);
    const pvalue = twoTailPFromZ(Math.abs(t));

    return {
      gene: row.gene,
      logFC: round(logFC),
      pvalue,
    };
  });

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

function runJsEnrichment(genes) {
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
    .map((set) => {
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
  if (!arr || arr.length === 0) return NaN;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function median(arr) {
  if (!arr || arr.length === 0) return NaN;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function sampleMedians(matrix) {
  if (!matrix || matrix.length === 0) return [];
  const sampleCount = matrix[0].values.length;
  const out = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const numeric = matrix.map((row) => row.values[i]).filter((value) => Number.isFinite(value));
    out.push(median(numeric));
  }
  return out;
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

module.exports = {
  buildModuleRunners,
  SUPPORTED_ENGINES,
};
