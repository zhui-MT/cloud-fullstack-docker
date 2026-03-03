const { ALGORITHM_REGISTRY } = require('./config-registry');

const STAGES = ['filtering', 'imputation', 'normalization', 'batch_correction'];

function validateAndNormalizeConfig(configInput) {
  const errors = [];

  if (!configInput || typeof configInput !== 'object' || Array.isArray(configInput)) {
    return { ok: false, errors: ['config must be an object'] };
  }

  const normalized = {
    seed: normalizeSeed(configInput.seed, errors),
  };

  for (const stage of STAGES) {
    const stageInput = configInput[stage];
    if (!stageInput || typeof stageInput !== 'object' || Array.isArray(stageInput)) {
      errors.push(`${stage} must be an object`);
      continue;
    }

    const algorithm = stageInput.algorithm;
    if (typeof algorithm !== 'string' || algorithm.trim() === '') {
      errors.push(`${stage}.algorithm is required`);
      continue;
    }

    const registry = ALGORITHM_REGISTRY[stage];
    const descriptor = registry[algorithm];
    if (!descriptor) {
      errors.push(`${stage}.algorithm "${algorithm}" is not supported`);
      continue;
    }

    if (stageInput.params !== undefined && (typeof stageInput.params !== 'object' || Array.isArray(stageInput.params))) {
      errors.push(`${stage}.params must be an object`);
      continue;
    }

    const validateParams =
      typeof descriptor === 'function' ? descriptor : descriptor && typeof descriptor.validateParams === 'function'
        ? descriptor.validateParams
        : null;
    if (!validateParams) {
      errors.push(`${stage}.algorithm "${algorithm}" is misconfigured on server`);
      continue;
    }

    let params;
    try {
      params = validateParams(stageInput.params || {});
    } catch (err) {
      errors.push(`${stage}.params invalid: ${err.message}`);
      continue;
    }

    normalized[stage] = {
      algorithm,
      params,
    };
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: normalized,
  };
}

function normalizeSeed(seedInput, errors) {
  const fallback = 42;
  const value = seedInput === undefined ? fallback : seedInput;
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
    errors.push('seed must be an integer in [1, 2147483647]');
    return fallback;
  }
  return value;
}

module.exports = {
  validateAndNormalizeConfig,
};
