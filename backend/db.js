const Database = require('better-sqlite3');
const path = require('path');

// File-based DB so data survives container restarts (stored in a docker volume if you add one).
const db = new Database(path.join(__dirname, 'data.sqlite'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    owner_name TEXT NOT NULL,
    balance_cents INTEGER NOT NULL DEFAULT 0,
    savings_balance_cents INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1
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

  -- Spending categories are free text (defaults: Food, Entertainment, Miscellaneous,
  -- plus anything custom the user names, e.g. "Dream Vacation", "TV"). Validated in
  -- server.js instead of a DB-level CHECK, so new category names never require a migration.
  -- Savings moves through savings_transactions instead (it's a two-way pot, not pure spend).
  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    category TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    payee TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- One row per account+category. monthly_limit_cents is a recurring cap —
  -- utilization is always computed fresh from the current calendar month's
  -- expenses/savings activity, so budgets "reset" automatically with no cron job.
  -- category is free text; 'Savings' is the one reserved name tracked via
  -- savings_transactions instead of the expenses table.
  CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    category TEXT NOT NULL,
    monthly_limit_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, category)
  );

  -- Savings is a sub-pot of the account: CONTRIBUTE moves money from main
  -- balance into savings, WITHDRAW moves it back out (e.g. for emergencies).
  CREATE TABLE IF NOT EXISTS savings_transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('CONTRIBUTE','WITHDRAW')),
    amount_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// ---- Migrations for anyone upgrading an existing data.sqlite from earlier features ----
const accountCols = db.prepare("PRAGMA table_info(accounts)").all();
if (!accountCols.some(c => c.name === 'is_active')) {
  db.exec('ALTER TABLE accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
}
if (!accountCols.some(c => c.name === 'savings_balance_cents')) {
  db.exec('ALTER TABLE accounts ADD COLUMN savings_balance_cents INTEGER NOT NULL DEFAULT 0');
}

// SQLite can't drop a CHECK constraint with ALTER TABLE, so if an existing
// data.sqlite still has the old fixed-category CHECK on expenses/budgets,
// rebuild those tables without it, copying every row across untouched.
function dropCategoryCheckIfPresent(table, createSql) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (row && row.sql.includes('CHECK(category')) {
    db.exec(`
      ALTER TABLE ${table} RENAME TO ${table}_old_checked;
      ${createSql}
      INSERT INTO ${table} SELECT * FROM ${table}_old_checked;
      DROP TABLE ${table}_old_checked;
    `);
    console.log(`Migrated ${table}: removed fixed-category constraint, custom category names now allowed.`);
  }
}

dropCategoryCheckIfPresent('expenses', `
  CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    category TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    payee TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

dropCategoryCheckIfPresent('budgets', `
  CREATE TABLE budgets (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    category TEXT NOT NULL,
    monthly_limit_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, category)
  );
`);

// Seed two demo accounts if empty, so you can test transfers immediately.
const count = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
if (count === 0) {
  const seed = db.prepare(
    'INSERT INTO accounts (id, owner_name, balance_cents, savings_balance_cents, is_active) VALUES (?, ?, ?, 0, 1)'
  );
  seed.run('acc_alice', 'Alice', 100000); // $1000.00
  seed.run('acc_bob', 'Bob', 50000);      // $500.00
  console.log('Seeded demo accounts: acc_alice ($1000), acc_bob ($500)');
}

module.exports = db;