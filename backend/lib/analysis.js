function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  return function rng() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function createRng(configRev, scope) {
  return mulberry32(hashString(`${configRev}:${scope}`));
}

function buildPca(configRev) {
  const rng = createRng(configRev, 'pca');
  const groups = ['Control', 'Treat-A', 'Treat-B'];
  const points = [];

  for (let i = 0; i < 36; i += 1) {
    const group = groups[i % groups.length];
    const cx = group === 'Control' ? -2.6 : group === 'Treat-A' ? 0.4 : 2.9;
    const cy = group === 'Control' ? 0.5 : group === 'Treat-A' ? 2.8 : -2.1;
    const pc1 = round(cx + (rng() - 0.5) * 1.8, 3);
    const pc2 = round(cy + (rng() - 0.5) * 1.6, 3);
    const loading = round(0.6 + rng() * 0.35, 3);

    points.push({
      sample_id: `S${String(i + 1).padStart(2, '0')}`,
      group,
      pc1,
      pc2,
      loading,
    });
  }

  return {
    explained_variance: { pc1: 43.1, pc2: 24.7 },
    points,
  };
}

function buildCorrelation(configRev) {
  const rng = createRng(configRev, 'correlation');
  const labels = Array.from({ length: 10 }, (_unused, i) => `S${String(i + 1).padStart(2, '0')}`);
  const matrix = labels.map(() => Array.from({ length: labels.length }, () => 0));

  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i; j < labels.length; j += 1) {
      let value;
      if (i === j) {
        value = 1;
      } else {
        const distance = Math.abs(i - j);
        const baseline = Math.max(0.35, 0.96 - distance * 0.06);
        value = round(baseline - rng() * 0.09, 3);
      }
      matrix[i][j] = value;
      matrix[j][i] = value;
    }
  }

  return { labels, matrix };
}

function buildVolcano(configRev) {
  const rng = createRng(configRev, 'volcano');
  const points = [];

  for (let i = 0; i < 400; i += 1) {
    const log2fc = round((rng() - 0.5) * 8, 3);
    const significance = Math.max(0.0001, rng() ** 3);
    const pAdj = round(significance, 6);
    const negLog10PAdj = round(-Math.log10(significance), 3);
    const category = pAdj < 0.05 && Math.abs(log2fc) >= 1 ? (log2fc > 0 ? 'up' : 'down') : 'ns';

    points.push({
      id: `P${String(i + 1).padStart(4, '0')}`,
      log2fc,
      p_adj: pAdj,
      neg_log10_p_adj: negLog10PAdj,
      category,
    });
  }

  return {
    threshold: {
      p_adj: 0.05,
      abs_log2fc: 1,
    },
    points,
  };
}

function buildEnrichment(configRev) {
  const rng = createRng(configRev, 'enrichment');
  const terms = [
    'Ribosome biogenesis',
    'RNA processing',
    'Oxidative phosphorylation',
    'Cell cycle checkpoint',
    'Proteasome complex',
    'Translation initiation',
    'Mitochondrial transport',
    'Response to stress',
    'Autophagy regulation',
    'DNA repair',
    'Vesicle trafficking',
    'Immune signaling',
  ];

  return {
    entries: terms.map((term, idx) => {
      const nes = round(1.4 + rng() * 2.3, 3);
      const pAdj = round(Math.max(0.0002, rng() * 0.045), 5);
      return {
        rank: idx + 1,
        term,
        nes,
        p_adj: pAdj,
        gene_count: 12 + Math.floor(rng() * 90),
      };
    }),
  };
}

function toCsvRows(header, rows) {
  const escapeCell = (value) => {
    const raw = value === null || value === undefined ? '' : String(value);
    if (/[,\n"]/g.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };

  const csv = [header.join(',')];
  for (const row of rows) {
    csv.push(header.map((key) => escapeCell(row[key])).join(','));
  }
  return `${csv.join('\n')}\n`;
}

function encodeDataUri(text) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

function buildPcaSvg(payload, configRev) {
  const width = 860;
  const height = 520;
  const margin = 60;
  const xMin = -5;
  const xMax = 5;
  const yMin = -5;
  const yMax = 5;
  const colorMap = { Control: '#0b5fa5', 'Treat-A': '#e85d04', 'Treat-B': '#52b788' };
  const x = (v) => margin + ((v - xMin) / (xMax - xMin)) * (width - margin * 2);
  const y = (v) => height - margin - ((v - yMin) / (yMax - yMin)) * (height - margin * 2);

  const circles = payload.points
    .map(
      (p) =>
        `<circle cx="${x(p.pc1).toFixed(2)}" cy="${y(p.pc2).toFixed(2)}" r="5.8" fill="${colorMap[p.group]}" fill-opacity="0.85"><title>${p.sample_id} ${p.group} PC1=${p.pc1} PC2=${p.pc2}</title></circle>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f9fafb"/>
  <text x="30" y="36" font-size="22" font-family="Arial, sans-serif" fill="#111827">PCA Score Plot · config_rev=${configRev}</text>
  <line x1="${margin}" y1="${height / 2}" x2="${width - margin}" y2="${height / 2}" stroke="#9ca3af" stroke-dasharray="4 4"/>
  <line x1="${width / 2}" y1="${margin}" x2="${width / 2}" y2="${height - margin}" stroke="#9ca3af" stroke-dasharray="4 4"/>
  ${circles}
</svg>`;
}

function buildCorrelationSvg(payload, configRev) {
  const width = 860;
  const height = 580;
  const startX = 150;
  const startY = 80;
  const cell = 36;

  const colorFor = (v) => {
    const t = Math.max(0, Math.min(1, (v + 1) / 2));
    const r = Math.round(245 - t * 180);
    const g = Math.round(248 - t * 120);
    const b = Math.round(252 - t * 220);
    return `rgb(${r},${g},${b})`;
  };

  const labels = payload.labels
    .map((label, idx) => `<text x="${startX - 12}" y="${startY + idx * cell + 24}" text-anchor="end" font-size="12" font-family="Arial">${label}</text>`)
    .join('');

  const topLabels = payload.labels
    .map((label, idx) => `<text x="${startX + idx * cell + 12}" y="${startY - 12}" transform="rotate(-45 ${startX + idx * cell + 12} ${startY - 12})" text-anchor="end" font-size="12" font-family="Arial">${label}</text>`)
    .join('');

  const cells = payload.matrix
    .flatMap((row, i) =>
      row.map((value, j) => {
        const x = startX + j * cell;
        const y = startY + i * cell;
        return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${colorFor(value)}" stroke="#d1d5db"><title>${payload.labels[i]} vs ${payload.labels[j]} r=${value}</title></rect>`;
      })
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="24" y="36" font-size="22" font-family="Arial">Correlation Heatmap · config_rev=${configRev}</text>
  ${labels}
  ${topLabels}
  ${cells}
</svg>`;
}

function buildVolcanoSvg(payload, configRev) {
  const width = 860;
  const height = 520;
  const margin = 60;
  const xMin = -4;
  const xMax = 4;
  const yMin = 0;
  const yMax = 6;
  const colorMap = { up: '#d00000', down: '#0077b6', ns: '#9ca3af' };
  const x = (v) => margin + ((v - xMin) / (xMax - xMin)) * (width - margin * 2);
  const y = (v) => height - margin - ((v - yMin) / (yMax - yMin)) * (height - margin * 2);

  const dots = payload.points
    .map((p) => `<circle cx="${x(p.log2fc).toFixed(2)}" cy="${y(Math.min(yMax, p.neg_log10_p_adj)).toFixed(2)}" r="2.8" fill="${colorMap[p.category]}" fill-opacity="0.7"><title>${p.id} log2FC=${p.log2fc} -log10(padj)=${p.neg_log10_p_adj}</title></circle>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <text x="30" y="36" font-size="22" font-family="Arial">Volcano Plot · config_rev=${configRev}</text>
  <line x1="${x(0)}" y1="${margin}" x2="${x(0)}" y2="${height - margin}" stroke="#64748b" stroke-dasharray="4 4"/>
  <line x1="${margin}" y1="${y(-Math.log10(payload.threshold.p_adj))}" x2="${width - margin}" y2="${y(-Math.log10(payload.threshold.p_adj))}" stroke="#64748b" stroke-dasharray="4 4"/>
  ${dots}
</svg>`;
}

function buildEnrichmentSvg(payload, configRev) {
  const width = 980;
  const height = 560;
  const marginTop = 70;
  const marginLeft = 320;
  const barHeight = 30;
  const gap = 8;
  const maxNes = Math.max(...payload.entries.map((d) => d.nes));

  const bars = payload.entries
    .map((entry, idx) => {
      const y = marginTop + idx * (barHeight + gap);
      const w = ((entry.nes / maxNes) * 560).toFixed(2);
      const color = entry.p_adj < 0.01 ? '#0466c8' : '#48bfe3';
      return `
      <text x="${marginLeft - 12}" y="${y + 20}" text-anchor="end" font-size="12" font-family="Arial">${entry.term}</text>
      <rect x="${marginLeft}" y="${y}" width="${w}" height="${barHeight}" rx="4" fill="${color}"><title>${entry.term} NES=${entry.nes} padj=${entry.p_adj}</title></rect>
      <text x="${marginLeft + Number(w) + 8}" y="${y + 20}" font-size="12" font-family="Arial">NES ${entry.nes}</text>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="24" y="38" font-size="22" font-family="Arial">GO/KEGG Enrichment · config_rev=${configRev}</text>
  ${bars}
</svg>`;
}

function buildArtifacts(kind, configRev, payload) {
  let csv;
  let svg;

  if (kind === 'pca') {
    csv = toCsvRows(['sample_id', 'group', 'pc1', 'pc2', 'loading'], payload.points);
    svg = buildPcaSvg(payload, configRev);
  } else if (kind === 'correlation') {
    const rows = payload.matrix.flatMap((row, i) => row.map((value, j) => ({ sample_i: payload.labels[i], sample_j: payload.labels[j], correlation: value })));
    csv = toCsvRows(['sample_i', 'sample_j', 'correlation'], rows);
    svg = buildCorrelationSvg(payload, configRev);
  } else if (kind === 'volcano') {
    csv = toCsvRows(['id', 'log2fc', 'p_adj', 'neg_log10_p_adj', 'category'], payload.points);
    svg = buildVolcanoSvg(payload, configRev);
  } else {
    csv = toCsvRows(['rank', 'term', 'nes', 'p_adj', 'gene_count'], payload.entries);
    svg = buildEnrichmentSvg(payload, configRev);
  }

  return { csv, svg, png_source_svg: svg, svg_data_uri: encodeDataUri(svg) };
}

function createAnalysisBundle(configRev) {
  return {
    config_rev: configRev,
    generated_at: new Date().toISOString(),
    views: {
      pca: buildPca(configRev),
      correlation: buildCorrelation(configRev),
      volcano: buildVolcano(configRev),
      enrichment: buildEnrichment(configRev),
    },
  };
}

module.exports = {
  buildArtifacts,
  createAnalysisBundle,
  hashString,
};
