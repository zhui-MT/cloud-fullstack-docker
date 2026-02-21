const crypto = require('crypto');

function stableCanonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(stableCanonicalize);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    const out = {};
    for (const [key, nested] of entries) {
      out[key] = stableCanonicalize(nested);
    }
    return out;
  }
  return value;
}

function computeConfigHash(config) {
  const canonical = stableCanonicalize(config);
  const payload = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function reproducibilityToken(configHash, seed) {
  const hashPrefix = configHash.slice(0, 8);
  const hashInt = Number.parseInt(hashPrefix, 16);
  const mixedSeed = (hashInt ^ seed) >>> 0;
  const rnd = mulberry32(mixedSeed);
  return Number(rnd().toFixed(12));
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  computeConfigHash,
  reproducibilityToken,
};
