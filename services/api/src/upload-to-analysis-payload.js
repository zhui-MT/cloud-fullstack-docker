const CONTROL_KEYWORDS = ['control', 'ctrl', 'vehicle', 'mock', 'wt', 'normal', 'untreated', 'untreat', 'blank', 'sham'];
const TREATMENT_KEYWORDS = ['treat', 'treatment', 'trt', 'drug', 'case', 'disease', 'ko', 'kd', 'mut', 'stim', 'tumor', 'patient'];

class AnalysisPayloadValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'AnalysisPayloadValidationError';
    this.code = 'UPLOAD_ANALYSIS_PAYLOAD_INVALID';
    this.details = details;
  }
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function includesKeyword(value, keywords) {
  const normalized = normalizeText(value);
  return keywords.some((keyword) => normalized.includes(keyword));
}

function inferGroupFromSampleName(sampleName) {
  if (includesKeyword(sampleName, CONTROL_KEYWORDS)) {
    return 'Control';
  }
  if (includesKeyword(sampleName, TREATMENT_KEYWORDS)) {
    return 'Treatment';
  }
  return 'Unassigned';
}

function toFiniteOrNull(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function pickEntityId(row = {}) {
  if (row.entityType === 'protein' && row.accession) {
    return String(row.accession).trim();
  }
  if (row.entityType === 'peptide' && row.modifiedSequence) {
    return String(row.modifiedSequence).trim();
  }
  const fallback = row.accession || row.modifiedSequence || row.sequence || row.gene || row.proteinGroup;
  if (!fallback) {
    return '';
  }
  return String(fallback).trim();
}

function resolveSampleGroups(sampleColumns, providedSampleGroups = {}) {
  const resolved = {};
  for (const sample of sampleColumns) {
    const explicit = typeof providedSampleGroups[sample] === 'string' ? providedSampleGroups[sample].trim() : '';
    resolved[sample] = explicit || inferGroupFromSampleName(sample);
  }
  return resolved;
}

function normalizeDe(de = {}) {
  const groupA = typeof de.groupA === 'string' && de.groupA.trim() ? de.groupA.trim() : 'Control';
  const groupB = typeof de.groupB === 'string' && de.groupB.trim() ? de.groupB.trim() : 'Treatment';
  const log2fcThreshold = Number.isFinite(Number(de.log2fcThreshold)) ? Number(de.log2fcThreshold) : 1;
  const padjThreshold = Number.isFinite(Number(de.padjThreshold)) ? Number(de.padjThreshold) : 0.05;
  return { groupA, groupB, log2fcThreshold, padjThreshold };
}

function normalizeEnrichment(enrichment = {}) {
  const species = typeof enrichment.species === 'string' && enrichment.species.trim() ? enrichment.species.trim() : 'human';
  const pvalueCutoff = Number.isFinite(Number(enrichment.pvalueCutoff)) ? Number(enrichment.pvalueCutoff) : 0.05;
  const qvalueCutoff = Number.isFinite(Number(enrichment.qvalueCutoff)) ? Number(enrichment.qvalueCutoff) : 0.2;
  return { species, pvalueCutoff, qvalueCutoff };
}

function uploadToAnalysisPayload(input = {}) {
  const mappedRows = Array.isArray(input.mappedRows) ? input.mappedRows : [];
  const sampleColumns = Array.isArray(input.sampleColumns)
    ? input.sampleColumns.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const de = normalizeDe(input.de || {});
  const enrichment = normalizeEnrichment(input.enrichment || {});
  const engine = typeof input.engine === 'string' && input.engine.trim() ? input.engine.trim() : 'limma';
  const resolvedSampleGroups = resolveSampleGroups(sampleColumns, input.sampleGroups || {});
  const details = [];

  if (sampleColumns.length === 0) {
    details.push('upload summary is missing sample columns');
  }

  const selectedSamples = sampleColumns.filter((sample) => {
    const group = resolvedSampleGroups[sample];
    return group === de.groupA || group === de.groupB;
  });

  const groupASize = selectedSamples.filter((sample) => resolvedSampleGroups[sample] === de.groupA).length;
  const groupBSize = selectedSamples.filter((sample) => resolvedSampleGroups[sample] === de.groupB).length;

  if (groupASize === 0 || groupBSize === 0) {
    details.push(`both DE groups must contain samples (groupA=${groupASize}, groupB=${groupBSize})`);
  }

  const entityMap = new Map();
  for (const row of mappedRows) {
    const entityId = pickEntityId(row);
    if (!entityId) {
      continue;
    }
    if (!entityMap.has(entityId)) {
      entityMap.set(entityId, {
        sums: Array(selectedSamples.length).fill(0),
        counts: Array(selectedSamples.length).fill(0),
      });
    }
    const agg = entityMap.get(entityId);
    const quantities = row && row.quantities && typeof row.quantities === 'object' ? row.quantities : {};
    for (let index = 0; index < selectedSamples.length; index += 1) {
      const sample = selectedSamples[index];
      const value = toFiniteOrNull(quantities[sample]);
      if (value === null) {
        continue;
      }
      agg.sums[index] += value;
      agg.counts[index] += 1;
    }
  }

  const matrix = [];
  for (const [entityId, agg] of entityMap.entries()) {
    const values = agg.sums.map((sum, index) => {
      if (agg.counts[index] === 0) {
        return null;
      }
      return sum / agg.counts[index];
    });
    if (!values.some((value) => Number.isFinite(value))) {
      continue;
    }
    matrix.push({
      gene: entityId,
      values,
    });
  }

  if (matrix.length === 0) {
    details.push('analysis matrix is empty after filtering and aggregation');
  }

  if (details.length > 0) {
    throw new AnalysisPayloadValidationError('failed to build analysis payload from upload', details);
  }

  return {
    engine,
    de,
    enrichment,
    samples: selectedSamples.map((sample) => ({
      sample,
      group: resolvedSampleGroups[sample],
    })),
    matrix,
    resolvedSampleGroups,
    selectedSamples,
  };
}

module.exports = {
  AnalysisPayloadValidationError,
  inferGroupFromSampleName,
  uploadToAnalysisPayload,
};
