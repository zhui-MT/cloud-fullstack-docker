const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function runRDeEnrich(payload, appendLog, context = {}) {
  const failures = [];
  const baseUrl = process.env.R_ENGINE_URL;
  const localDisabled = process.env.R_ENGINE_LOCAL_DISABLE === '1';

  throwIfCanceled(context);

  if (baseUrl) {
    try {
      return await runRemote(baseUrl, payload, appendLog, context);
    } catch (error) {
      if (isCanceledError(error)) throw error;
      failures.push(`remote=${error.message}`);
      appendLog('warn', `Remote r-engine failed: ${error.message}`);
    }
  } else {
    appendLog('info', 'R_ENGINE_URL is not configured, skipping remote r-engine');
  }

  if (!localDisabled) {
    try {
      return await runLocal(payload, appendLog, context);
    } catch (error) {
      if (isCanceledError(error)) throw error;
      failures.push(`local=${error.message}`);
      appendLog('warn', `Local Rscript runner failed: ${error.message}`);
    }
  }

  const err = new Error(
    failures.length > 0
      ? `R runtime unavailable: ${failures.join(' | ')}`
      : 'R runtime is not configured'
  );
  err.code = failures.length > 0 ? 'R_ENGINE_UNAVAILABLE' : 'R_ENGINE_NOT_CONFIGURED';
  throw err;
}

async function runRemote(baseUrl, payload, appendLog, context) {
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/run/de-enrich`;
  appendLog('info', `Trying remote r-engine: ${base}`);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: context?.signal || undefined,
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw makeCanceledError('job canceled while calling remote r-engine');
    }
    const err = new Error(`remote request failed: ${error.message}`);
    err.code = 'R_ENGINE_REMOTE_UNREACHABLE';
    throw err;
  }

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

async function runLocal(payload, appendLog, context) {
  const scriptPath = path.resolve(
    process.env.R_ENGINE_LOCAL_ENTRY || path.join(__dirname, '../r/local_de_enrich.R')
  );
  const analysisPath = path.resolve(
    process.env.R_ENGINE_ANALYSIS_SCRIPT || path.join(__dirname, '../../backend/r/analysis.R')
  );
  const rscriptBin = process.env.RSCRIPT_BIN || 'Rscript';

  if (!fs.existsSync(scriptPath)) {
    const err = new Error(`local runner script not found: ${scriptPath}`);
    err.code = 'R_ENGINE_LOCAL_SCRIPT_MISSING';
    throw err;
  }
  if (!fs.existsSync(analysisPath)) {
    const err = new Error(`analysis script not found: ${analysisPath}`);
    err.code = 'R_ENGINE_ANALYSIS_SCRIPT_MISSING';
    throw err;
  }

  appendLog('info', `Trying local Rscript runner: ${scriptPath}`);
  throwIfCanceled(context);

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(rscriptBin, [scriptPath, analysisPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finalize = (fn, value) => {
      if (settled) return;
      settled = true;
      if (context?.signal && typeof context.signal.removeEventListener === 'function') {
        context.signal.removeEventListener('abort', onAbort);
      }
      fn(value);
    };

    const onAbort = () => {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGTERM');
        const forceKillTimer = setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
        }, 250);
        forceKillTimer.unref();
      }
      finalize(reject, makeCanceledError('job canceled while running local Rscript'));
    };

    if (context?.signal && typeof context.signal.addEventListener === 'function') {
      context.signal.addEventListener('abort', onAbort, { once: true });
      if (context.signal.aborted) {
        onAbort();
        return;
      }
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finalize(reject, wrapLocalError(error));
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const err = new Error(
          `local Rscript exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`
        );
        err.code = 'R_ENGINE_LOCAL_FAILED';
        finalize(reject, err);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (_error) {
        const err = new Error(`local Rscript returned non-json output: ${stdout.slice(0, 200)}`);
        err.code = 'R_ENGINE_BAD_RESPONSE';
        finalize(reject, err);
        return;
      }

      if (!parsed.ok) {
        const err = new Error(parsed.error || 'local Rscript returned failure');
        err.code = 'R_ENGINE_LOCAL_FAILED';
        finalize(reject, err);
        return;
      }

      if (parsed.meta) {
        appendLog('info', `[local-r] ${JSON.stringify(parsed.meta)}`);
      }
      finalize(resolve, parsed.result);
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });

  appendLog('info', 'Local Rscript runner completed');
  return result;
}

function wrapLocalError(error) {
  if (error?.code === 'ENOENT') {
    const err = new Error('Rscript command not found');
    err.code = 'R_ENGINE_LOCAL_MISSING_RSCRIPT';
    return err;
  }
  const err = new Error(`failed to launch local Rscript: ${error.message}`);
  err.code = 'R_ENGINE_LOCAL_FAILED';
  return err;
}

function throwIfCanceled(context) {
  if (context && typeof context.throwIfCanceled === 'function') {
    context.throwIfCanceled();
  }
}

function makeCanceledError(message = 'job canceled during execution') {
  const err = new Error(message);
  err.code = 'JOB_CANCELED';
  return err;
}

function isAbortLikeError(error) {
  if (!error) return false;
  return error.name === 'AbortError' || error.code === 'ABORT_ERR';
}

function isCanceledError(error) {
  if (!error) return false;
  return error.code === 'JOB_CANCELED' || isAbortLikeError(error);
}

module.exports = {
  runRDeEnrich,
};
