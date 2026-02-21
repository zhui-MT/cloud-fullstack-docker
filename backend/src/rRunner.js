const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function spawnProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function runRDeEnrich(payload, appendLog) {
  const scriptPath = path.resolve(__dirname, '../r/de_enrich.R');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'de-enrich-'));
  const inputPath = path.join(tempDir, 'input.json');
  const outputPath = path.join(tempDir, 'output.json');

  await fs.writeFile(inputPath, JSON.stringify(payload), 'utf8');
  appendLog('info', `R runner input prepared: ${inputPath}`);

  const result = await spawnProcess('Rscript', [scriptPath, inputPath, outputPath]);

  if (result.stdout.trim()) {
    appendLog('info', `[R stdout] ${result.stdout.trim()}`);
  }
  if (result.stderr.trim()) {
    appendLog('warn', `[R stderr] ${result.stderr.trim()}`);
  }

  if (result.code !== 0) {
    const err = new Error(`Rscript exited with code ${result.code}`);
    err.code = 'R_EXEC_FAILED';
    throw err;
  }

  const outputRaw = await fs.readFile(outputPath, 'utf8');
  const parsed = JSON.parse(outputRaw);
  appendLog('info', 'R runner completed');
  return parsed;
}

module.exports = {
  runRDeEnrich,
};
