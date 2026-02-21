class ConfigRepository {
  async saveConfig(_sessionId, _config, _configHash) {
    throw new Error('saveConfig not implemented');
  }

  async getLatestConfig(_sessionId) {
    throw new Error('getLatestConfig not implemented');
  }

  async listRevisions(_sessionId) {
    throw new Error('listRevisions not implemented');
  }

  async getConfigByRevision(_sessionId, _configRev) {
    throw new Error('getConfigByRevision not implemented');
  }

  async getConfigByHash(_sessionId, _configHash) {
    throw new Error('getConfigByHash not implemented');
  }
}

class PgConfigRepository extends ConfigRepository {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  async saveConfig(sessionId, config, configHash) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `
          INSERT INTO sessions(id, name)
          VALUES($1, $2)
          ON CONFLICT (id) DO NOTHING
        `,
        [sessionId, `auto-${sessionId}`]
      );

      const latest = await client.query(
        `
          SELECT session_id, config_rev, config_hash, config_json, created_at
          FROM session_configs
          WHERE session_id = $1
          ORDER BY config_rev DESC
          LIMIT 1
        `,
        [sessionId]
      );

      let row;
      let reused = false;

      if (latest.rows[0] && latest.rows[0].config_hash === configHash) {
        row = latest.rows[0];
        reused = true;
      } else {
        const nextRev = latest.rows[0] ? Number(latest.rows[0].config_rev) + 1 : 1;
        const inserted = await client.query(
          `
            INSERT INTO session_configs(session_id, config_rev, config_hash, config_json)
            VALUES($1, $2, $3, $4::jsonb)
            RETURNING session_id, config_rev, config_hash, config_json, created_at
          `,
          [sessionId, nextRev, configHash, JSON.stringify(config)]
        );
        row = inserted.rows[0];
      }

      await client.query('COMMIT');
      return {
        session_id: row.session_id,
        config_rev: Number(row.config_rev),
        config_hash: row.config_hash,
        config: row.config_json,
        created_at: row.created_at,
        reused,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getLatestConfig(sessionId) {
    const result = await this.pool.query(
      `
        SELECT session_id, config_rev, config_hash, config_json, created_at
        FROM session_configs
        WHERE session_id = $1
        ORDER BY config_rev DESC
        LIMIT 1
      `,
      [sessionId]
    );
    if (!result.rows[0]) {
      return null;
    }
    return {
      session_id: result.rows[0].session_id,
      config_rev: Number(result.rows[0].config_rev),
      config_hash: result.rows[0].config_hash,
      config: result.rows[0].config_json,
      created_at: result.rows[0].created_at,
    };
  }

  async listRevisions(sessionId) {
    const result = await this.pool.query(
      `
        SELECT session_id, config_rev, config_hash, config_json, created_at
        FROM session_configs
        WHERE session_id = $1
        ORDER BY config_rev ASC
      `,
      [sessionId]
    );

    return result.rows.map((row) => ({
      session_id: row.session_id,
      config_rev: Number(row.config_rev),
      config_hash: row.config_hash,
      config: row.config_json,
      created_at: row.created_at,
    }));
  }

  async getConfigByRevision(sessionId, configRev) {
    const result = await this.pool.query(
      `
        SELECT session_id, config_rev, config_hash, config_json, created_at
        FROM session_configs
        WHERE session_id = $1 AND config_rev = $2
        LIMIT 1
      `,
      [sessionId, configRev]
    );

    if (!result.rows[0]) {
      return null;
    }

    return {
      session_id: result.rows[0].session_id,
      config_rev: Number(result.rows[0].config_rev),
      config_hash: result.rows[0].config_hash,
      config: result.rows[0].config_json,
      created_at: result.rows[0].created_at,
    };
  }

  async getConfigByHash(sessionId, configHash) {
    const result = await this.pool.query(
      `
        SELECT session_id, config_rev, config_hash, config_json, created_at
        FROM session_configs
        WHERE session_id = $1 AND config_hash = $2
        LIMIT 1
      `,
      [sessionId, configHash]
    );

    if (!result.rows[0]) {
      return null;
    }

    return {
      session_id: result.rows[0].session_id,
      config_rev: Number(result.rows[0].config_rev),
      config_hash: result.rows[0].config_hash,
      config: result.rows[0].config_json,
      created_at: result.rows[0].created_at,
    };
  }
}

class InMemoryConfigRepository extends ConfigRepository {
  constructor() {
    super();
    this.store = new Map();
  }

  async saveConfig(sessionId, config, configHash) {
    const revisions = this.store.get(sessionId) || [];
    const latest = revisions[revisions.length - 1] || null;

    if (latest && latest.config_hash === configHash) {
      return { ...latest, reused: true };
    }

    const row = {
      session_id: sessionId,
      config_rev: latest ? latest.config_rev + 1 : 1,
      config_hash: configHash,
      config: config,
      created_at: new Date().toISOString(),
    };
    revisions.push(row);
    this.store.set(sessionId, revisions);
    return { ...row, reused: false };
  }

  async getLatestConfig(sessionId) {
    const revisions = this.store.get(sessionId);
    if (!revisions || revisions.length === 0) {
      return null;
    }
    return revisions[revisions.length - 1];
  }

  async listRevisions(sessionId) {
    const revisions = this.store.get(sessionId) || [];
    return revisions.map((row) => ({ ...row }));
  }

  async getConfigByRevision(sessionId, configRev) {
    const revisions = this.store.get(sessionId) || [];
    const found = revisions.find((row) => row.config_rev === configRev);
    return found ? { ...found } : null;
  }

  async getConfigByHash(sessionId, configHash) {
    const revisions = this.store.get(sessionId) || [];
    const found = revisions.find((row) => row.config_hash === configHash);
    return found ? { ...found } : null;
  }
}

module.exports = {
  PgConfigRepository,
  InMemoryConfigRepository,
};
