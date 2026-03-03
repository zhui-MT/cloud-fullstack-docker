class AnalysisRunsRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async createQueuedRun(input) {
    const result = await this.pool.query(
      `INSERT INTO analysis_runs(
        session_id,
        upload_id,
        config_rev,
        config_tag,
        config_hash,
        status,
        engine,
        de_json,
        enrichment_json,
        sample_groups_json,
        request_hash,
        config_trace_json
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb
      )
      RETURNING *`,
      [
        input.sessionId,
        input.uploadId,
        input.configRev ?? null,
        input.configTag ?? null,
        input.configHash ?? null,
        input.status || 'queued',
        input.engine,
        JSON.stringify(input.de || {}),
        JSON.stringify(input.enrichment || {}),
        JSON.stringify(input.sampleGroups || {}),
        input.requestHash,
        JSON.stringify(input.configTrace || null),
      ]
    );
    return result.rows[0] || null;
  }

  async getById(runId) {
    const result = await this.pool.query('SELECT * FROM analysis_runs WHERE id = $1', [runId]);
    return result.rows[0] || null;
  }

  async setJobBinding(runId, payload) {
    const result = await this.pool.query(
      `UPDATE analysis_runs
      SET
        job_id = $2,
        status = $3,
        started_at = COALESCE($4, started_at),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [runId, payload.jobId || null, payload.status || 'running', payload.startedAt || null]
    );
    return result.rows[0] || null;
  }

  async syncStatus(runId, payload) {
    const result = await this.pool.query(
      `UPDATE analysis_runs
      SET
        status = COALESCE($2, status),
        started_at = COALESCE($3, started_at),
        finished_at = COALESCE($4, finished_at),
        runtime_json = COALESCE($5::jsonb, runtime_json),
        error_json = COALESCE($6::jsonb, error_json),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [
        runId,
        payload.status || null,
        payload.startedAt || null,
        payload.finishedAt || null,
        payload.runtime ? JSON.stringify(payload.runtime) : null,
        payload.error ? JSON.stringify(payload.error) : null,
      ]
    );
    return result.rows[0] || null;
  }

  async finalizeSucceeded(runId, payload) {
    const result = await this.pool.query(
      `UPDATE analysis_runs
      SET
        status = 'succeeded',
        runtime_json = COALESCE($2::jsonb, runtime_json),
        result_json = $3::jsonb,
        views_json = $4::jsonb,
        artifact_index = $5::jsonb,
        error_json = NULL,
        finished_at = COALESCE($6, finished_at, NOW()),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [
        runId,
        payload.runtime ? JSON.stringify(payload.runtime) : null,
        JSON.stringify(payload.result || {}),
        JSON.stringify(payload.views || {}),
        JSON.stringify(payload.artifactIndex || {}),
        payload.finishedAt || null,
      ]
    );
    return result.rows[0] || null;
  }

  async finalizeFailed(runId, payload) {
    const result = await this.pool.query(
      `UPDATE analysis_runs
      SET
        status = 'failed',
        runtime_json = COALESCE($2::jsonb, runtime_json),
        error_json = COALESCE($3::jsonb, error_json),
        finished_at = COALESCE($4, finished_at, NOW()),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [
        runId,
        payload.runtime ? JSON.stringify(payload.runtime) : null,
        payload.error ? JSON.stringify(payload.error) : null,
        payload.finishedAt || null,
      ]
    );
    return result.rows[0] || null;
  }
}

module.exports = {
  AnalysisRunsRepository,
};
