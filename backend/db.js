const { Pool } = require('pg');

// Connection comes from environment variables (set in docker-compose.yml).
// Falls back to sensible local defaults if not provided.
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'unlockd',
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      owner_name TEXT NOT NULL,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      savings_balance_cents INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      pin TEXT NOT NULL DEFAULT '0000'
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE NOT NULL,
      from_account_id TEXT NOT NULL,
      to_account_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING','SUCCESS','FAILED')),
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      category TEXT,
      description TEXT,
      merchant TEXT
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      category TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      payee TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      category TEXT NOT NULL,
      monthly_limit_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, category)
    );

    CREATE TABLE IF NOT EXISTS savings_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('CONTRIBUTE','WITHDRAW')),
      amount_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS splits (
      id TEXT PRIMARY KEY,
      creator_account_id TEXT NOT NULL,
      category TEXT NOT NULL,
      payee TEXT NOT NULL,
      total_cents INTEGER NOT NULL,
      split_type TEXT NOT NULL CHECK(split_type IN ('EQUAL','CUSTOM')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS split_shares (
      id TEXT PRIMARY KEY,
      split_id TEXT NOT NULL REFERENCES splits(id),
      account_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING','PAID')) DEFAULT 'PENDING',
      expense_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Idempotent "migrations" — Postgres supports IF NOT EXISTS on ADD COLUMN,
  // so no need for the PRAGMA-based checks SQLite required.
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1;`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS savings_balance_cents INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pin TEXT NOT NULL DEFAULT '0000';`);
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category TEXT;`);
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description TEXT;`);
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant TEXT;`);

  // Seed two demo accounts if empty, so you can test transfers immediately.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM accounts');
  if (rows[0].c === 0) {
    await pool.query(
      `INSERT INTO accounts (id, owner_name, balance_cents, savings_balance_cents, is_active, pin)
       VALUES ($1, $2, $3, 0, 1, '0000'), ($4, $5, $6, 0, 1, '0000')`,
      ['acc_alice', 'Alice', 100000, 'acc_bob', 'Bob', 50000]
    );
    console.log('Seeded demo accounts: acc_alice ($1000), acc_bob ($500)');
  }
}

module.exports = { pool, init };