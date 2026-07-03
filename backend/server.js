const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const now = () => new Date().toISOString();

// ---------- GET /accounts ----------
app.get('/accounts', (req, res) => {
  const rows = db.prepare('SELECT * FROM accounts').all();
  res.json(rows.map(a => ({
    id: a.id,
    owner_name: a.owner_name,
    balance: a.balance_cents / 100
  })));
});

// ---------- POST /accounts ----------
// Body: { owner_name, starting_balance? }
app.post('/accounts', (req, res) => {
  const { owner_name, starting_balance } = req.body;

  if (!owner_name || typeof owner_name !== 'string' || !owner_name.trim()) {
    return res.status(400).json({ error: 'owner_name is required' });
  }

  const startingCents = starting_balance ? Math.round(Number(starting_balance) * 100) : 0;
  if (!Number.isFinite(startingCents) || startingCents < 0) {
    return res.status(400).json({ error: 'starting_balance must be a non-negative number' });
  }

  const id = 'acc_' + owner_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString(36);

  db.prepare('INSERT INTO accounts (id, owner_name, balance_cents) VALUES (?, ?, ?)')
    .run(id, owner_name.trim(), startingCents);

  return res.status(201).json({
    id,
    owner_name: owner_name.trim(),
    balance: startingCents / 100
  });
});

// ---------- GET /transactions ----------
app.get('/transactions', (req, res) => {
  const { account_id } = req.query;
  let rows;
  if (account_id) {
    rows = db.prepare(
      `SELECT * FROM transactions
       WHERE from_account_id = ? OR to_account_id = ?
       ORDER BY created_at DESC`
    ).all(account_id, account_id);
  } else {
    rows = db.prepare('SELECT * FROM transactions ORDER BY created_at DESC').all();
  }
  res.json(rows.map(t => ({ ...t, amount: t.amount_cents / 100 })));
});

// ---------- POST /transactions/transfer ----------
app.post('/transactions/transfer', (req, res) => {
  const { from_account_id, to_account_id, amount, idempotency_key } = req.body;

  if (!from_account_id || !to_account_id || amount === undefined) {
    return res.status(400).json({ error: 'from_account_id, to_account_id and amount are required' });
  }
  if (from_account_id === to_account_id) {
    return res.status(400).json({ error: 'Cannot transfer to the same account' });
  }
  const amountCents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  const idempotencyKey = idempotency_key || uuidv4();

  const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(idempotencyKey);
  if (existing) {
    return res.status(existing.status === 'SUCCESS' ? 200 : 409).json({
      ...existing,
      amount: existing.amount_cents / 100,
      duplicate: true
    });
  }

  const txId = uuidv4();
  const timestamp = now();

  // Record the transaction as PENDING before attempting it — gives an honest lifecycle,
  // and ensures a row exists even if something crashes mid-transfer.
  db.prepare(`
    INSERT INTO transactions
      (id, idempotency_key, from_account_id, to_account_id, amount_cents, status, failure_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, ?, ?)
  `).run(txId, idempotencyKey, from_account_id, to_account_id, amountCents, timestamp, timestamp);

  // --- atomic transfer: better-sqlite3 transactions are synchronous and all-or-nothing ---
  const runTransfer = db.transaction(() => {
    const fromAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(from_account_id);
    const toAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(to_account_id);

    if (!fromAccount || !toAccount) {
      throw { code: 'NOT_FOUND', message: 'One or both accounts do not exist' };
    }
    if (fromAccount.balance_cents < amountCents) {
      throw { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient balance for this transfer' };
    }

    db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?')
      .run(amountCents, from_account_id);
    db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?')
      .run(amountCents, to_account_id);

    db.prepare(`
      UPDATE transactions
      SET status = 'SUCCESS', updated_at = ?
      WHERE id = ?
    `).run(now(), txId);
  });

  try {
    runTransfer();
    const created = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
    return res.status(201).json({ ...created, amount: created.amount_cents / 100 });
  } catch (err) {
    const reason = err.message || 'Unknown error';
    if (err.code === 'NOT_FOUND') {
      // Accounts didn't exist — remove the PENDING row we speculatively created, nothing to log.
      db.prepare('DELETE FROM transactions WHERE id = ?').run(txId);
    } else {
      db.prepare(`
        UPDATE transactions
        SET status = 'FAILED', failure_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(reason, now(), txId);
    }
    const statusCode = err.code === 'NOT_FOUND' ? 404
      : err.code === 'INSUFFICIENT_FUNDS' ? 422
      : 500;
    return res.status(statusCode).json({ error: reason });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));