const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('r-engine docker build uses services/api/r/analysis.R as single analysis source', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const dockerfilePath = path.join(repoRoot, 'services', 'r-engine', 'Dockerfile');
  const composePath = path.join(repoRoot, 'docker-compose.yml');
  const dockerignorePath = path.join(repoRoot, '.dockerignore');
  const legacyPath = path.join(repoRoot, 'services', 'r-engine', 'analysis.R');

  const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  assert.match(dockerfile, /COPY\s+services\/api\/r\/analysis\.R\s+\/app\/analysis\.R/);

  const compose = fs.readFileSync(composePath, 'utf8');
  assert.match(compose, /r-engine:\s*[\s\S]*context:\s*\.\s*[\s\S]*dockerfile:\s*services\/r-engine\/Dockerfile/);

  const dockerignore = fs.readFileSync(dockerignorePath, 'utf8');
  assert.match(dockerignore, /^\*\*$/m);
  assert.match(dockerignore, /!services\/r-engine\/app\.R/);
  assert.match(dockerignore, /!services\/api\/r\/analysis\.R/);

  assert.equal(fs.existsSync(legacyPath), false);
});
