const METADATA_COLUMNS = {
  fragpipe: {
    protein: ['protein id', 'protein', 'entry name', 'gene', 'genes', 'protein probability', 'peptides', 'unique peptides'],
    peptide: ['peptide sequence', 'modified peptide', 'protein id', 'protein', 'gene', 'genes', 'charge'],
  },
  diann: {
    protein: ['protein.group', 'protein.ids', 'protein.names', 'genes', 'first.protein.description'],
    peptide: ['precursor.id', 'stripped.sequence', 'modified.sequence', 'protein.group', 'protein.ids', 'protein.names', 'genes', 'charge'],
  },
  maxquant: {
    protein: ['protein ids', 'majority protein ids', 'gene names', 'fasta headers', 'peptide counts (all)', 'peptide counts (razor+unique)'],
    peptide: ['sequence', 'modified sequence', 'leading proteins', 'leading razor protein', 'gene names', 'missed cleavages', 'charge'],
  },
};

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function detectDelimiter(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] || '';
  const tabCount = (first.match(/\t/g) || []).length;
  const commaCount = (first.match(/,/g) || []).length;
  if (tabCount > 0 && tabCount >= commaCount) {
    return '\t';
  }
  return ',';
}

function parseDelimitedLine(line, delimiter) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (c === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }

    cur += c;
  }

  out.push(cur.trim());
  return out;
}

function parseTable(content) {
  const warnings = [];
  const delimiter = detectDelimiter(content);
  const allLines = content.split(/\r?\n/).filter((line) => line.trim() !== '');

  if (allLines.length < 2) {
    throw new Error('文件内容不足，至少需要表头+1行数据');
  }

  const headers = parseDelimitedLine(allLines[0], delimiter);
  const rows = [];

  for (let i = 1; i < allLines.length; i += 1) {
    const values = parseDelimitedLine(allLines[i], delimiter);
    if (values.length !== headers.length) {
      warnings.push(`第 ${i + 1} 行列数(${values.length})与表头(${headers.length})不一致，已按最小列数截断`);
    }

    const len = Math.min(values.length, headers.length);
    const row = {};
    for (let j = 0; j < len; j += 1) {
      row[headers[j]] = values[j];
    }
    rows.push(row);
  }

  return { headers, rows, delimiter, warnings };
}

function hasHeader(normalizedHeaders, header) {
  return normalizedHeaders.includes(normalizeHeader(header));
}

function detectSourceAndEntity(headers) {
  const h = headers.map(normalizeHeader);

  if (hasHeader(h, 'precursor.id') || hasHeader(h, 'stripped.sequence')) {
    return { sourceTool: 'DIA-NN', entityType: 'peptide' };
  }

  if (hasHeader(h, 'protein.group') || hasHeader(h, 'protein.ids')) {
    return { sourceTool: 'DIA-NN', entityType: 'protein' };
  }

  if (hasHeader(h, 'protein id') && (hasHeader(h, 'protein probability') || hasHeader(h, 'unique peptides'))) {
    return { sourceTool: 'FragPipe', entityType: 'protein' };
  }

  if (hasHeader(h, 'peptide sequence') && hasHeader(h, 'protein id')) {
    return { sourceTool: 'FragPipe', entityType: 'peptide' };
  }

  if (hasHeader(h, 'protein ids') && (h.some((v) => v.startsWith('lfq intensity ')) || hasHeader(h, 'majority protein ids'))) {
    return { sourceTool: 'MaxQuant', entityType: 'protein' };
  }

  if (hasHeader(h, 'modified sequence') && (hasHeader(h, 'leading proteins') || hasHeader(h, 'leading razor protein'))) {
    return { sourceTool: 'MaxQuant', entityType: 'peptide' };
  }

  throw new Error('未识别文件来源/层级，当前仅支持 FragPipe / DIA-NN / MaxQuant 的 protein/peptide 结果表');
}

function parseNumeric(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function inferQuantColumns(headers, rows, metadataColumns) {
  const metaSet = new Set(metadataColumns.map(normalizeHeader));
  const candidates = headers.filter((h) => !metaSet.has(normalizeHeader(h)));
  const quantColumns = [];

  for (const col of candidates) {
    let total = 0;
    let numeric = 0;
    for (let i = 0; i < Math.min(rows.length, 50); i += 1) {
      const v = rows[i][col];
      if (v === undefined || v === null || v === '') {
        continue;
      }
      total += 1;
      if (parseNumeric(v) !== null) {
        numeric += 1;
      }
    }

    if (total > 0 && numeric / total >= 0.7) {
      quantColumns.push(col);
    }
  }

  return quantColumns;
}

function normalizeRowKeys(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[normalizeHeader(key)] = value;
  }
  return normalized;
}

function firstOf(row, keys) {
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key);
    if (row[normalizedKey] !== undefined && row[normalizedKey] !== null && String(row[normalizedKey]).trim() !== '') {
      return String(row[normalizedKey]).trim();
    }
  }
  return null;
}

function mapRows(sourceTool, entityType, headers, rows) {
  const key = sourceTool.toLowerCase().replace('-', '');
  const metadataColumns = METADATA_COLUMNS[key][entityType];
  const quantColumns = inferQuantColumns(headers, rows, metadataColumns);

  const mappedRows = rows.map((row) => {
    const normalizedRow = normalizeRowKeys(row);
    const base = {
      entityType,
      sourceTool,
      accession: null,
      sequence: null,
      modifiedSequence: null,
      gene: null,
      proteinGroup: null,
      quantities: {},
    };

    if (sourceTool === 'FragPipe' && entityType === 'protein') {
      base.accession = firstOf(normalizedRow, ['protein id', 'protein']);
      base.gene = firstOf(normalizedRow, ['gene', 'genes']);
    }

    if (sourceTool === 'FragPipe' && entityType === 'peptide') {
      base.sequence = firstOf(normalizedRow, ['peptide sequence']);
      base.modifiedSequence = firstOf(normalizedRow, ['modified peptide']) || base.sequence;
      base.accession = firstOf(normalizedRow, ['protein id', 'protein']);
      base.gene = firstOf(normalizedRow, ['gene', 'genes']);
    }

    if (sourceTool === 'DIA-NN' && entityType === 'protein') {
      base.proteinGroup = firstOf(normalizedRow, ['protein.group']);
      base.accession = firstOf(normalizedRow, ['protein.ids', 'protein.group']);
      base.gene = firstOf(normalizedRow, ['genes']);
    }

    if (sourceTool === 'DIA-NN' && entityType === 'peptide') {
      base.sequence = firstOf(normalizedRow, ['stripped.sequence']);
      base.modifiedSequence = firstOf(normalizedRow, ['modified.sequence']) || base.sequence;
      base.proteinGroup = firstOf(normalizedRow, ['protein.group']);
      base.accession = firstOf(normalizedRow, ['protein.ids', 'protein.group']);
      base.gene = firstOf(normalizedRow, ['genes']);
    }

    if (sourceTool === 'MaxQuant' && entityType === 'protein') {
      base.accession = firstOf(normalizedRow, ['majority protein ids', 'protein ids']);
      base.gene = firstOf(normalizedRow, ['gene names']);
    }

    if (sourceTool === 'MaxQuant' && entityType === 'peptide') {
      base.sequence = firstOf(normalizedRow, ['sequence']);
      base.modifiedSequence = firstOf(normalizedRow, ['modified sequence']) || base.sequence;
      base.accession = firstOf(normalizedRow, ['leading razor protein', 'leading proteins']);
      base.gene = firstOf(normalizedRow, ['gene names']);
    }

    for (const sampleCol of quantColumns) {
      base.quantities[sampleCol] = parseNumeric(row[sampleCol]);
    }

    return base;
  });

  return { mappedRows, quantColumns };
}

function summarizeMapped(mappedRows, quantColumns, headers) {
  const warnings = [];
  if (quantColumns.length === 0) {
    warnings.push('未识别到定量样本列，后续分析可能不可用');
  }

  const entitySet = new Set();
  for (const row of mappedRows) {
    const id = row.entityType === 'protein'
      ? row.accession
      : (row.modifiedSequence || row.sequence);
    if (id) {
      entitySet.add(id);
    }
  }

  const availableColumns = ['entityType', 'sourceTool'];
  const maybeColumns = ['accession', 'sequence', 'modifiedSequence', 'gene', 'proteinGroup'];
  for (const col of maybeColumns) {
    if (mappedRows.some((row) => row[col])) {
      availableColumns.push(col);
    }
  }
  if (quantColumns.length > 0) {
    availableColumns.push('quantities');
  }

  return {
    sampleCount: quantColumns.length,
    entityCount: entitySet.size,
    availableColumns,
    sourceColumns: headers,
    warnings,
  };
}

function parseProteomicsFile(content) {
  const parsed = parseTable(content);
  const detected = detectSourceAndEntity(parsed.headers);
  const mapped = mapRows(detected.sourceTool, detected.entityType, parsed.headers, parsed.rows);
  const summary = summarizeMapped(mapped.mappedRows, mapped.quantColumns, parsed.headers);

  return {
    detected,
    delimiter: parsed.delimiter === '\t' ? 'tab' : 'comma',
    rowCount: parsed.rows.length,
    summary: {
      ...summary,
      warnings: [...parsed.warnings, ...summary.warnings],
    },
    sampleColumns: mapped.quantColumns,
    mappedRows: mapped.mappedRows,
    preview: mapped.mappedRows.slice(0, 3),
  };
}

module.exports = {
  parseProteomicsFile,
};
