const ALGORITHM_REGISTRY = {
  filtering: {
    'rule-based': {
      validateParams(params) {
        const safe = params || {};
        return {
          contaminant_filter: ensureBoolean(safe.contaminant_filter, true, 'contaminant_filter'),
          reverse_decoy_filter: ensureBoolean(safe.reverse_decoy_filter, true, 'reverse_decoy_filter'),
          low_coverage_filter: ensureBoolean(safe.low_coverage_filter, true, 'low_coverage_filter'),
          low_variance_filter: ensureBoolean(safe.low_variance_filter, false, 'low_variance_filter'),
          minimum_peptide_count_filter: ensureBoolean(
            safe.minimum_peptide_count_filter,
            false,
            'minimum_peptide_count_filter'
          ),
          min_coverage: ensureNumberInRange(safe.min_coverage, 0.5, 0, 1, 'min_coverage'),
          variance_threshold: ensureNumberInRange(
            safe.variance_threshold,
            0,
            0,
            Number.POSITIVE_INFINITY,
            'variance_threshold'
          ),
          min_peptide_count: ensureIntegerInRange(safe.min_peptide_count, 2, 1, 1000, 'min_peptide_count'),
        };
      },
    },
  },
  imputation: {
    none: noParamValidator,
    'min-half': noParamValidator,
    'left-shift-gaussian': {
      validateParams(params) {
        const safe = params || {};
        return {
          downshift: ensureNumberInRange(safe.downshift, 1.8, 0.01, 10, 'downshift'),
          width: ensureNumberInRange(safe.width, 0.3, 0.01, 5, 'width'),
        };
      },
    },
    minprob: {
      validateParams(params) {
        const safe = params || {};
        return {
          q: ensureNumberInRange(safe.q, 0.01, 0.0001, 0.5, 'q'),
        };
      },
    },
    QRILC: {
      validateParams(params) {
        const safe = params || {};
        return {
          tune_sigma: ensureNumberInRange(safe.tune_sigma, 1, 0.1, 5, 'tune_sigma'),
        };
      },
    },
    KNN: {
      validateParams(params) {
        const safe = params || {};
        return {
          k: ensureIntegerInRange(safe.k, 5, 1, 100, 'k'),
        };
      },
    },
    SVD: {
      validateParams(params) {
        const safe = params || {};
        return {
          rank: ensureIntegerInRange(safe.rank, 3, 1, 100, 'rank'),
        };
      },
    },
    BPCA: {
      validateParams(params) {
        const safe = params || {};
        return {
          max_iter: ensureIntegerInRange(safe.max_iter, 200, 10, 10000, 'max_iter'),
        };
      },
    },
    missForest: {
      validateParams(params) {
        const safe = params || {};
        return {
          max_trees: ensureIntegerInRange(safe.max_trees, 100, 10, 2000, 'max_trees'),
        };
      },
    },
    hybrid: {
      validateParams(params) {
        const safe = params || {};
        return {
          mar_method: ensureEnum(safe.mar_method, 'KNN', ['KNN', 'SVD', 'BPCA'], 'mar_method'),
          mnar_method: ensureEnum(
            safe.mnar_method,
            'left-shift-gaussian',
            ['min-half', 'left-shift-gaussian', 'minprob'],
            'mnar_method'
          ),
        };
      },
    },
  },
  normalization: {
    'no-normalization': noParamValidator,
    median: noParamValidator,
    quantile: noParamValidator,
    VSN: noParamValidator,
    'cyclic-loess': {
      validateParams(params) {
        const safe = params || {};
        return {
          iterations: ensureIntegerInRange(safe.iterations, 3, 1, 20, 'iterations'),
        };
      },
    },
    TIC: noParamValidator,
    'z-score': {
      validateParams(params) {
        const safe = params || {};
        return {
          by: ensureEnum(safe.by, 'feature', ['feature', 'sample'], 'by'),
        };
      },
    },
    RLR: {
      validateParams(params) {
        const safe = params || {};
        return {
          lambda: ensureNumberInRange(safe.lambda, 1, 0.0001, 1000, 'lambda'),
        };
      },
    },
  },
  batch_correction: {
    none: noParamValidator,
    ComBat: {
      validateParams(params) {
        const safe = params || {};
        return {
          parametric_prior: ensureBoolean(safe.parametric_prior, true, 'parametric_prior'),
        };
      },
    },
    'ComBat-seq': {
      validateParams(params) {
        const safe = params || {};
        return {
          group_field: ensureNonEmptyString(safe.group_field, 'condition', 'group_field'),
        };
      },
    },
    'limma removeBatchEffect': {
      validateParams(params) {
        const safe = params || {};
        return {
          design_terms: ensureStringArray(safe.design_terms, ['condition'], 'design_terms'),
        };
      },
    },
    'RUVg/RUVs': {
      validateParams(params) {
        const safe = params || {};
        return {
          mode: ensureEnum(safe.mode, 'RUVg', ['RUVg', 'RUVs'], 'mode'),
          k: ensureIntegerInRange(safe.k, 1, 1, 10, 'k'),
        };
      },
    },
  },
};

function noParamValidator(params) {
  const safe = params || {};
  if (Object.keys(safe).length !== 0) {
    throw new Error('this algorithm does not accept params');
  }
  return {};
}

function ensureBoolean(input, fallback, name) {
  const value = input === undefined ? fallback : input;
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be boolean`);
  }
  return value;
}

function ensureNumberInRange(input, fallback, min, max, name) {
  const value = input === undefined ? fallback : input;
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
    throw new Error(`${name} must be a number in [${min}, ${max}]`);
  }
  return value;
}

function ensureIntegerInRange(input, fallback, min, max, name) {
  const value = input === undefined ? fallback : input;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function ensureEnum(input, fallback, allowed, name) {
  const value = input === undefined ? fallback : input;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function ensureNonEmptyString(input, fallback, name) {
  const value = input === undefined ? fallback : input;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function ensureStringArray(input, fallback, name) {
  const value = input === undefined ? fallback : input;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value.map((item) => item.trim());
}

module.exports = {
  ALGORITHM_REGISTRY,
};
