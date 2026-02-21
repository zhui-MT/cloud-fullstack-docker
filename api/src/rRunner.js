async function runRDeEnrich(payload, appendLog) {
  const baseUrl = process.env.R_ENGINE_URL;
  if (!baseUrl) {
    const err = new Error('R_ENGINE_URL is not configured');
    err.code = 'R_ENGINE_URL_MISSING';
    throw err;
  }

  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/run/de-enrich`;

  appendLog('info', `Trying remote r-engine: ${base}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let parsed = null;

  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    const err = new Error(`r-engine returned non-json response (status ${response.status})`);
    err.code = 'R_ENGINE_BAD_RESPONSE';
    throw err;
  }

  if (!response.ok || !parsed.ok) {
    const err = new Error(parsed.error || `r-engine request failed with status ${response.status}`);
    err.code = 'R_ENGINE_FAILED';
    throw err;
  }

  if (parsed.meta) {
    appendLog('info', `[r-engine] ${JSON.stringify(parsed.meta)}`);
  }

  appendLog('info', 'Remote r-engine completed');
  return parsed.result;
}

module.exports = {
  runRDeEnrich,
};
