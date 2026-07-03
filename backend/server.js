const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const now = () => new Date().toISOString();
const currentMonthPrefix = () => new Date().toISOString().slice(0, 7); // "2026-07"

const SPEND_CATEGORIES = ['Food', 'Entertainment', 'Miscellaneous'];
const ALL_CATEGORIES = [...SPEND_CATEGORIES, 'Savings'];

// ================== ACCOUNTS ==================

// ---------- GET /accounts ----------
app.get('/accounts', (req, res) => {
  const rows = db.prepare('SELECT * FROM accounts').all();
  res.json(rows.map(a => ({
    id: a.id,
    owner_name: a.owner_name,
    balance: a.balance_cents / 100,
    savings_balance: a.savings_balance_cents / 100,
    is_active: !!a.is_active
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

  db.prepare('INSERT INTO accounts (id, owner_name, balance_cents, savings_balance_cents, is_active) VALUES (?, ?, ?, 0, 1)')
    .run(id, owner_name.trim(), startingCents);

  return res.status(201).json({
    id,
    owner_name: owner_name.trim(),
    balance: startingCents / 100,
    savings_balance: 0,
    is_active: true
  });
});

// ---------- PATCH /accounts/:id/status ----------
// Body: { is_active: boolean }
app.patch('/accounts/:id/status', (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false' });
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  db.prepare('UPDATE accounts SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, id);

  const updated = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return res.json({
    id: updated.id,
    owner_name: updated.owner_name,
    balance: updated.balance_cents / 100,
    savings_balance: updated.savings_balance_cents / 100,
    is_active: !!updated.is_active
  });
});

// ================== TRANSACTIONS (Feature 1) ==================

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

  db.prepare(`
    INSERT INTO transactions
      (id, idempotency_key, from_account_id, to_account_id, amount_cents, status, failure_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, ?, ?)
  `).run(txId, idempotencyKey, from_account_id, to_account_id, amountCents, timestamp, timestamp);

  const runTransfer = db.transaction(() => {
    const fromAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(from_account_id);
    const toAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(to_account_id);

    if (!fromAccount || !toAccount) {
      throw { code: 'NOT_FOUND', message: 'One or both accounts do not exist' };
    }
    if (!fromAccount.is_active || !toAccount.is_active) {
      throw { code: 'ACCOUNT_INACTIVE', message: 'One or both accounts are disabled' };
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
      : err.code === 'ACCOUNT_INACTIVE' ? 403
      : 500;
    return res.status(statusCode).json({ error: reason });
  }
});

// ================== EXPENSES (Feature 2) ==================
// Spending against Food / Entertainment / Miscellaneous. Money leaves the account
// entirely (paid to a shopkeeper, helper, anyone outside the app) — unlike transfers,
// it never lands in another account here.

// ---------- GET /expenses?account_id=X ----------
app.get('/expenses', (req, res) => {
  const { account_id } = req.query;
  let rows;
  if (account_id) {
    rows = db.prepare('SELECT * FROM expenses WHERE account_id = ? ORDER BY created_at DESC').all(account_id);
  } else {
    rows = db.prepare('SELECT * FROM expenses ORDER BY created_at DESC').all();
  }
  res.json(rows.map(e => ({ ...e, amount: e.amount_cents / 100 })));
});

// ---------- POST /expenses ----------
// Body: { account_id, category, amount, payee }
app.post('/expenses', (req, res) => {
  const { account_id, category, amount, payee } = req.body;

  if (!account_id || !category || amount === undefined || !payee || !payee.trim()) {
    return res.status(400).json({ error: 'account_id, category, amount and payee are required' });
  }
  if (!SPEND_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${SPEND_CATEGORIES.join(', ')}` });
  }
  const amountCents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  if (!account.is_active) {
    return res.status(403).json({ error: 'Account is disabled' });
  }
  if (account.balance_cents < amountCents) {
    return res.status(422).json({ error: 'Insufficient balance for this expense' });
  }

  const expenseId = uuidv4();
  const timestamp = now();

  const runExpense = db.transaction(() => {
    db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?')
      .run(amountCents, account_id);
    db.prepare(`
      INSERT INTO expenses (id, account_id, category, amount_cents, payee, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(expenseId, account_id, category, amountCents, payee.trim(), timestamp);
  });
  runExpense();

  const created = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
  return res.status(201).json({ ...created, amount: created.amount_cents / 100 });
});

// ================== SAVINGS (Feature 2) ==================
// Savings is a two-way pot: contribute moves money out of the main balance into
// savings; withdraw moves it back (e.g. for emergencies). Net of the two, for the
// current month, is what counts toward the Savings budget goal.

// ---------- GET /savings/transactions?account_id=X ----------
app.get('/savings/transactions', (req, res) => {
  const { account_id } = req.query;
  let rows;
  if (account_id) {
    rows = db.prepare('SELECT * FROM savings_transactions WHERE account_id = ? ORDER BY created_at DESC').all(account_id);
  } else {
    rows = db.prepare('SELECT * FROM savings_transactions ORDER BY created_at DESC').all();
  }
  res.json(rows.map(s => ({ ...s, amount: s.amount_cents / 100 })));
});

function handleSavingsMove(type) {
  return (req, res) => {
    const { account_id, amount } = req.body;

    if (!account_id || amount === undefined) {
      return res.status(400).json({ error: 'account_id and amount are required' });
    }
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    if (!account.is_active) {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    if (type === 'CONTRIBUTE' && account.balance_cents < amountCents) {
      return res.status(422).json({ error: 'Insufficient main balance to contribute this amount' });
    }
    if (type === 'WITHDRAW' && account.savings_balance_cents < amountCents) {
      return res.status(422).json({ error: 'Insufficient savings balance to withdraw this amount' });
    }

    const id = uuidv4();
    const timestamp = now();

    const runMove = db.transaction(() => {
      if (type === 'CONTRIBUTE') {
        db.prepare('UPDATE accounts SET balance_cents = balance_cents - ?, savings_balance_cents = savings_balance_cents + ? WHERE id = ?')
          .run(amountCents, amountCents, account_id);
      } else {
        db.prepare('UPDATE accounts SET balance_cents = balance_cents + ?, savings_balance_cents = savings_balance_cents - ? WHERE id = ?')
          .run(amountCents, amountCents, account_id);
      }
      db.prepare(`
        INSERT INTO savings_transactions (id, account_id, type, amount_cents, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, account_id, type, amountCents, timestamp);
    });
    runMove();

    const created = db.prepare('SELECT * FROM savings_transactions WHERE id = ?').get(id);
    const updatedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
    return res.status(201).json({
      ...created,
      amount: created.amount_cents / 100,
      account: {
        id: updatedAccount.id,
        balance: updatedAccount.balance_cents / 100,
        savings_balance: updatedAccount.savings_balance_cents / 100
      }
    });
  };
}

// ---------- POST /savings/contribute ----------
app.post('/savings/contribute', handleSavingsMove('CONTRIBUTE'));

// ---------- POST /savings/withdraw ----------
app.post('/savings/withdraw', handleSavingsMove('WITHDRAW'));

// ================== BUDGETS (Feature 2) ==================

// ---------- GET /budgets?account_id=X ----------
// Returns each budget plus live utilization for the current calendar month.
// Because utilization is always computed from "this month's" rows, budgets
// reset automatically at the start of each month — no cron job needed.
app.get('/budgets', (req, res) => {
  const { account_id, month } = req.query;
  if (!account_id) {
    return res.status(400).json({ error: 'account_id is required' });
  }

  // Optional ?month=YYYY-MM to view any month (past, current, or future).
  // Defaults to the current month if not given. Because spend/savings are
  // always computed live from real rows in that exact month, a future month
  // with no rows yet naturally comes back as spent: 0 / utilization: 0%.
  let monthPrefix = currentMonthPrefix();
  if (month !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format' });
    }
    monthPrefix = month;
  }

  const budgets = db.prepare('SELECT * FROM budgets WHERE account_id = ?').all(account_id);

  const result = budgets.map(b => {
    let spentCents = 0;

    if (b.category === 'Savings') {
      const rows = db.prepare(
        `SELECT type, SUM(amount_cents) AS total FROM savings_transactions
         WHERE account_id = ? AND created_at LIKE ? GROUP BY type`
      ).all(account_id, `${monthPrefix}%`);
      const contributed = rows.find(r => r.type === 'CONTRIBUTE')?.total || 0;
      const withdrawn = rows.find(r => r.type === 'WITHDRAW')?.total || 0;
      spentCents = contributed - withdrawn; // net saved this month
    } else {
      const row = db.prepare(
        `SELECT SUM(amount_cents) AS total FROM expenses
         WHERE account_id = ? AND category = ? AND created_at LIKE ?`
      ).get(account_id, b.category, `${monthPrefix}%`);
      spentCents = row.total || 0;
    }

    const limitCents = b.monthly_limit_cents;
    const utilizationPct = limitCents > 0 ? Math.round((spentCents / limitCents) * 100) : 0;

    return {
      id: b.id,
      account_id: b.account_id,
      category: b.category,
      monthly_limit: limitCents / 100,
      spent: spentCents / 100,
      remaining: (limitCents - spentCents) / 100,
      utilization_pct: utilizationPct,
      approaching_limit: b.category !== 'Savings' && utilizationPct >= 80 && utilizationPct < 100,
      over_limit: b.category !== 'Savings' && utilizationPct >= 100,
      goal_reached: b.category === 'Savings' && utilizationPct >= 100
    };
  });

  res.json({ month: monthPrefix, budgets: result });
});

// ---------- POST /budgets ----------
// Body: { account_id, category, monthly_limit }
// Upserts — setting a budget for a category that already has one just updates the limit.
app.post('/budgets', (req, res) => {
  const { account_id, category, monthly_limit } = req.body;

  if (!account_id || !category || monthly_limit === undefined) {
    return res.status(400).json({ error: 'account_id, category and monthly_limit are required' });
  }
  if (!ALL_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${ALL_CATEGORIES.join(', ')}` });
  }
  const limitCents = Math.round(Number(monthly_limit) * 100);
  if (!Number.isFinite(limitCents) || limitCents <= 0) {
    return res.status(400).json({ error: 'monthly_limit must be a positive number' });
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const existing = db.prepare('SELECT * FROM budgets WHERE account_id = ? AND category = ?').get(account_id, category);
  const timestamp = now();

  if (existing) {
    db.prepare('UPDATE budgets SET monthly_limit_cents = ?, updated_at = ? WHERE id = ?')
      .run(limitCents, timestamp, existing.id);
  } else {
    db.prepare(`
      INSERT INTO budgets (id, account_id, category, monthly_limit_cents, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), account_id, category, limitCents, timestamp, timestamp);
  }

  const saved = db.prepare('SELECT * FROM budgets WHERE account_id = ? AND category = ?').get(account_id, category);
  return res.status(existing ? 200 : 201).json({
    id: saved.id,
    account_id: saved.account_id,
    category: saved.category,
    monthly_limit: saved.monthly_limit_cents / 100
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));