const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = Number(process.env.API_PORT || 4000);

app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'appdb',
});

app.get('/api/health', async (_req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, service: 'api', dbTime: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, service: 'api', error: err.message });
  }
});

app.get('/api/messages', async (_req, res) => {
  try {
    const result = await pool.query('SELECT id, content, created_at FROM messages ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages', async (req, res) => {
  const { content } = req.body || {};
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO messages(content) VALUES($1) RETURNING id, content, created_at',
      [content]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`API running on port ${port}`);
});
