const Database = require('better-sqlite3');
const path = require('path');

// File-based DB so data survives container restarts (stored in a docker volume if you add one).
const db = new Database(path.join(__dirname, 'data.sqlite'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    owner_name TEXT NOT NULL,
    balance_cents INTEGER NOT NULL DEFAULT 0
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
    updated_at TEXT NOT NULL
  );
`);

// Seed two demo accounts if empty, so you can test transfers immediately.
const count = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
if (count === 0) {
  const seed = db.prepare(
    'INSERT INTO accounts (id, owner_name, balance_cents) VALUES (?, ?, ?)'
  );
  seed.run('acc_alice', 'Alice', 100000); // $1000.00
  seed.run('acc_bob', 'Bob', 50000);      // $500.00
  console.log('Seeded demo accounts: acc_alice ($1000), acc_bob ($500)');
}

module.exports = db;