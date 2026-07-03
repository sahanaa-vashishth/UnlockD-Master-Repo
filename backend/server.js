const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const now = () => new Date().toISOString();
const currentMonthPrefix = () => new Date().toISOString().slice(0, 7); // "2026-07"

// Default suggestions shown in the UI — not a restriction. Any non-empty name
// is accepted (e.g. "Dream Vacation", "TV"), so budgets/expenses aren't locked
// to a fixed list. 'Savings' is reserved: it's tracked via savings_transactions,
// not the expenses table, so it can't be used as a plain spending category.
const DEFAULT_SPEND_CATEGORIES = ['Food', 'Entertainment', 'Miscellaneous'];
const RESERVED_CATEGORY = 'Savings';

function normalizeCategory(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 40) return null;
  return trimmed;
}

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
  const { owner_name, starting_balance, pin } = req.body;

  if (!owner_name || typeof owner_name !== 'string' || !owner_name.trim()) {
    return res.status(400).json({ error: 'owner_name is required' });
  }

  const startingCents = starting_balance ? Math.round(Number(starting_balance) * 100) : 0;
  if (!Number.isFinite(startingCents) || startingCents < 0) {
    return res.status(400).json({ error: 'starting_balance must be a non-negative number' });
  }

  let finalPin = '0000';
  if (pin !== undefined && pin !== '') {
    if (!/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }
    finalPin = String(pin);
  }

  const id = 'acc_' + owner_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString(36);

  db.prepare('INSERT INTO accounts (id, owner_name, balance_cents, savings_balance_cents, is_active, pin) VALUES (?, ?, ?, 0, 1, ?)')
    .run(id, owner_name.trim(), startingCents, finalPin);

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
// ---------- POST /accounts/:id/verify-pin ----------
app.post('/accounts/:id/verify-pin', (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const valid = String(pin) === account.pin;
  return res.status(valid ? 200 : 401).json({ valid });
});

// ---------- PATCH /accounts/:id/pin ----------
app.patch('/accounts/:id/pin', (req, res) => {
  const { id } = req.params;
  const { current_pin, new_pin } = req.body;

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  if (String(current_pin) !== account.pin) {
    return res.status(401).json({ error: 'Current PIN is incorrect' });
  }
  if (!/^\d{4}$/.test(String(new_pin))) {
    return res.status(400).json({ error: 'New PIN must be exactly 4 digits' });
  }

  db.prepare('UPDATE accounts SET pin = ? WHERE id = ?').run(String(new_pin), id);
  return res.json({ updated: true });
});
// ================== TRANSACTIONS (Feature 1) ==================

// ---------- GET /transactions ----------
// Supports Feature 4: search by description/merchant, filter by date range,
// category, amount range, and account. All params optional and combinable.
function buildTransactionQuery(query) {
  const { account_id, q, category, min_amount, max_amount, start_date, end_date } = query;

  const clauses = [];
  const params = [];

  if (account_id) {
    clauses.push('(from_account_id = ? OR to_account_id = ?)');
    params.push(account_id, account_id);
  }
  if (q && q.trim()) {
    clauses.push('(description LIKE ? OR merchant LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }
  if (category && category.trim()) {
    clauses.push('category = ?');
    params.push(category.trim());
  }
  if (min_amount !== undefined) {
    const cents = Math.round(Number(min_amount) * 100);
    if (Number.isFinite(cents)) {
      clauses.push('amount_cents >= ?');
      params.push(cents);
    }
  }
  if (max_amount !== undefined) {
    const cents = Math.round(Number(max_amount) * 100);
    if (Number.isFinite(cents)) {
      clauses.push('amount_cents <= ?');
      params.push(cents);
    }
  }
  if (start_date) {
    clauses.push('created_at >= ?');
    params.push(start_date);
  }
  if (end_date) {
    // created_at is an ISO timestamp; add a day-boundary so end_date is inclusive
    // whether the caller passed "YYYY-MM-DD" or a full ISO string.
    clauses.push('created_at <= ?');
    params.push(end_date.length <= 10 ? `${end_date}T23:59:59.999Z` : end_date);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

app.get('/transactions', (req, res) => {
  const { where, params } = buildTransactionQuery(req.query);
  const rows = db.prepare(`SELECT * FROM transactions ${where} ORDER BY created_at DESC`).all(...params);
  res.json(rows.map(t => ({ ...t, amount: t.amount_cents / 100 })));
});

// ---------- GET /transactions/export ----------
// Same filters as GET /transactions, returned as a downloadable CSV.
app.get('/transactions/export', (req, res) => {
  const { where, params } = buildTransactionQuery(req.query);
  const rows = db.prepare(`SELECT * FROM transactions ${where} ORDER BY created_at DESC`).all(...params);

  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const header = ['id', 'created_at', 'from_account_id', 'to_account_id', 'amount', 'status', 'category', 'merchant', 'description'];
  const lines = [header.join(',')];
  rows.forEach(t => {
    lines.push([
      t.id, t.created_at, t.from_account_id, t.to_account_id,
      (t.amount_cents / 100).toFixed(2), t.status,
      t.category, t.merchant, t.description
    ].map(escape).join(','));
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
  res.send(lines.join('\n'));
});

// ---------- PATCH /transactions/:id ----------
// Edit/categorize a transaction record. Only category, description, and
// merchant are editable here — amount/accounts/status are controlled by the
// transfer flow itself and shouldn't be hand-edited.
app.patch('/transactions/:id', (req, res) => {
  const { id } = req.params;
  const { category, description, merchant } = req.body;

  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  const nextCategory = category !== undefined ? normalizeCategory(category) : existing.category;
  if (category !== undefined && category !== null && category.trim() && !nextCategory) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  db.prepare(`
    UPDATE transactions
    SET category = ?, description = ?, merchant = ?, updated_at = ?
    WHERE id = ?
  `).run(
    category !== undefined ? nextCategory : existing.category,
    description !== undefined ? description : existing.description,
    merchant !== undefined ? merchant : existing.merchant,
    now(),
    id
  );

  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  return res.json({ ...updated, amount: updated.amount_cents / 100 });
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

// Shared helper so both the normal expense route and the split-share "Pay" route
// log an expense identically (same balance check, same atomic deduction).
// Returns the created expense row (raw, cents) or throws { code, message }.
function createExpenseInternal({ account_id, category, amountCents, payee }) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
  if (!account) {
    throw { code: 'NOT_FOUND', message: 'Account not found' };
  }
  if (!account.is_active) {
    throw { code: 'ACCOUNT_INACTIVE', message: 'Account is disabled' };
  }
  if (account.balance_cents < amountCents) {
    throw { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient balance for this expense' };
  }

  const expenseId = uuidv4();
  const timestamp = now();

  const runExpense = db.transaction(() => {
    db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?')
      .run(amountCents, account_id);
    db.prepare(`
      INSERT INTO expenses (id, account_id, category, amount_cents, payee, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(expenseId, account_id, category, amountCents, payee, timestamp);
  });
  runExpense();

  return db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
}

// ---------- POST /expenses ----------
// Body: { account_id, category, amount, payee }
app.post('/expenses', (req, res) => {
  const { account_id, amount, payee } = req.body;
  const category = normalizeCategory(req.body.category);

  if (!account_id || !category || amount === undefined || !payee || !payee.trim()) {
    return res.status(400).json({ error: 'account_id, category, amount and payee are required' });
  }
  if (category === RESERVED_CATEGORY) {
    return res.status(400).json({ error: `"${RESERVED_CATEGORY}" is reserved — use the Savings contribute/withdraw endpoints instead` });
  }
  const amountCents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  try {
    const created = createExpenseInternal({ account_id, category, amountCents, payee: payee.trim() });
    return res.status(201).json({ ...created, amount: created.amount_cents / 100 });
  } catch (err) {
    const statusCode = err.code === 'NOT_FOUND' ? 404
      : err.code === 'ACCOUNT_INACTIVE' ? 403
      : err.code === 'INSUFFICIENT_FUNDS' ? 422
      : 500;
    return res.status(statusCode).json({ error: err.message || 'Could not log expense' });
  }
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
  const { account_id, monthly_limit } = req.body;
  const category = normalizeCategory(req.body.category);

  if (!account_id || !category || monthly_limit === undefined) {
    return res.status(400).json({ error: 'account_id, category and monthly_limit are required' });
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

// ---------- DELETE /budgets/:id ----------
// Removes the budget itself only. Past expenses/savings activity already
// logged under that category is untouched — this just stops tracking a
// monthly limit for it going forward.
app.delete('/budgets/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Budget not found' });
  }
  db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
  return res.status(200).json({ deleted: true, id });
});

// ---------- GET /categories?account_id=X ----------
// Default suggestions plus any custom category names already used in expenses
// or budgets for this account, so the frontend can offer them in a dropdown
// alongside a "+ Add new category" option. 'Savings' is always included since
// it's a built-in budget target even though it lives in a different table.
app.get('/categories', (req, res) => {
  const { account_id } = req.query;
  const used = new Set(DEFAULT_SPEND_CATEGORIES);

  if (account_id) {
    db.prepare('SELECT DISTINCT category FROM expenses WHERE account_id = ?').all(account_id)
      .forEach(r => used.add(r.category));
    db.prepare('SELECT DISTINCT category FROM budgets WHERE account_id = ?').all(account_id)
      .forEach(r => used.add(r.category));
  } else {
    db.prepare('SELECT DISTINCT category FROM expenses').all().forEach(r => used.add(r.category));
    db.prepare('SELECT DISTINCT category FROM budgets').all().forEach(r => used.add(r.category));
  }
  used.delete(RESERVED_CATEGORY);

  res.json({
    spend_categories: Array.from(used).sort(),
    reserved: RESERVED_CATEGORY
  });
});

// ================== SPLIT A BILL (Feature 3) ==================
// A split is a template: total amount, category, payee (shopkeeper/cab driver/etc.),
// and a list of participants (including the creator). Each participant gets their
// own independent "share" row. There are NO internal transfers between people —
// each share simply becomes that person's own expense (hitting their own budget)
// the moment they pay it. The creator's own share is just as PENDING as everyone
// else's until they pay it too.

function serializeSplit(split, shares) {
  return {
    id: split.id,
    creator_account_id: split.creator_account_id,
    category: split.category,
    payee: split.payee,
    total: split.total_cents / 100,
    split_type: split.split_type,
    created_at: split.created_at,
    shares: shares.map(s => ({
      id: s.id,
      split_id: s.split_id,
      account_id: s.account_id,
      owner_name: s.owner_name,
      amount: s.amount_cents / 100,
      status: s.status,
      expense_id: s.expense_id
    }))
  };
}

function getSplitWithShares(splitId) {
  const split = db.prepare('SELECT * FROM splits WHERE id = ?').get(splitId);
  if (!split) return null;
  const shares = db.prepare(`
    SELECT split_shares.*, accounts.owner_name AS owner_name
    FROM split_shares
    JOIN accounts ON accounts.id = split_shares.account_id
    WHERE split_shares.split_id = ?
    ORDER BY split_shares.created_at ASC
  `).all(splitId);
  return serializeSplit(split, shares);
}

// ---------- GET /splits?account_id=X ----------
// Returns every split where account_id is either the creator or a participant,
// each with the full live list of shares (so the UI can show everyone's
// paid/pending status, and so "my pending payment" tiles can be derived).
app.get('/splits', (req, res) => {
  const { account_id } = req.query;

  let splitIds;
  if (account_id) {
    splitIds = db.prepare(`
      SELECT DISTINCT splits.id FROM splits
      LEFT JOIN split_shares ON split_shares.split_id = splits.id
      WHERE splits.creator_account_id = ? OR split_shares.account_id = ?
      ORDER BY splits.id
    `).all(account_id, account_id).map(r => r.id);
  } else {
    splitIds = db.prepare('SELECT id FROM splits').all().map(r => r.id);
  }

  const results = splitIds
    .map(id => getSplitWithShares(id))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first

  res.json(results);
});

// ---------- POST /splits ----------
// Body: {
//   creator_account_id, category, payee, total, split_type: 'EQUAL' | 'CUSTOM',
//   participants: [account_id, ...]                (for EQUAL), or
//   participants: [{ account_id, amount }, ...]     (for CUSTOM)
// }
// The creator MUST be included in participants themselves if they owe a share too
// (matches "everyone pays their own share, including the creator").
app.post('/splits', (req, res) => {
  const { creator_account_id, payee, total, split_type, participants } = req.body;
  const category = normalizeCategory(req.body.category);

  if (!creator_account_id || !category || !payee || !payee.trim() || total === undefined) {
    return res.status(400).json({ error: 'creator_account_id, category, payee and total are required' });
  }
  if (category === RESERVED_CATEGORY) {
    return res.status(400).json({ error: `"${RESERVED_CATEGORY}" cannot be used as a split category` });
  }
  if (split_type !== 'EQUAL' && split_type !== 'CUSTOM') {
    return res.status(400).json({ error: "split_type must be 'EQUAL' or 'CUSTOM'" });
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: 'participants must be a non-empty array' });
  }

  const totalCents = Math.round(Number(total) * 100);
  if (!Number.isFinite(totalCents) || totalCents <= 0) {
    return res.status(400).json({ error: 'total must be a positive number' });
  }

  const creator = db.prepare('SELECT * FROM accounts WHERE id = ?').get(creator_account_id);
  if (!creator) {
    return res.status(404).json({ error: 'Creator account not found' });
  }
  if (!creator.is_active) {
    return res.status(403).json({ error: 'Creator account is disabled' });
  }

  // Normalize participants into a flat list of { account_id, amountCents }
  let shareRows;
  if (split_type === 'EQUAL') {
    const accountIds = participants.map(p => (typeof p === 'string' ? p : p.account_id));
    if (new Set(accountIds).size !== accountIds.length) {
      return res.status(400).json({ error: 'Duplicate participants are not allowed' });
    }
    const n = accountIds.length;
    const base = Math.floor(totalCents / n);
    const remainder = totalCents - base * n;
    // Distribute the leftover cents (from integer division) one at a time
    // across the first `remainder` participants so shares always sum exactly
    // to totalCents.
    shareRows = accountIds.map((account_id, i) => ({
      account_id,
      amountCents: base + (i < remainder ? 1 : 0)
    }));
  } else {
    if (participants.some(p => typeof p !== 'object' || !p.account_id || p.amount === undefined)) {
      return res.status(400).json({ error: 'CUSTOM participants must each have account_id and amount' });
    }
    const accountIds = participants.map(p => p.account_id);
    if (new Set(accountIds).size !== accountIds.length) {
      return res.status(400).json({ error: 'Duplicate participants are not allowed' });
    }
    shareRows = participants.map(p => ({
      account_id: p.account_id,
      amountCents: Math.round(Number(p.amount) * 100)
    }));
    if (shareRows.some(s => !Number.isFinite(s.amountCents) || s.amountCents <= 0)) {
      return res.status(400).json({ error: 'Each participant amount must be a positive number' });
    }
    const sum = shareRows.reduce((acc, s) => acc + s.amountCents, 0);
    if (sum !== totalCents) {
      return res.status(400).json({
        error: `Custom shares must add up to the total. Shares sum to $${(sum / 100).toFixed(2)}, total is $${(totalCents / 100).toFixed(2)}.`
      });
    }
  }

  // Validate every participant account exists and is active.
  for (const s of shareRows) {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(s.account_id);
    if (!acc) {
      return res.status(404).json({ error: `Participant account not found: ${s.account_id}` });
    }
    if (!acc.is_active) {
      return res.status(403).json({ error: `Participant account is disabled: ${acc.owner_name}` });
    }
  }

  const splitId = uuidv4();
  const timestamp = now();

  const runCreate = db.transaction(() => {
    db.prepare(`
      INSERT INTO splits (id, creator_account_id, category, payee, total_cents, split_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(splitId, creator_account_id, category, payee.trim(), totalCents, split_type, timestamp);

    const insertShare = db.prepare(`
      INSERT INTO split_shares (id, split_id, account_id, amount_cents, status, expense_id, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', NULL, ?)
    `);
    shareRows.forEach(s => {
      insertShare.run(uuidv4(), splitId, s.account_id, s.amountCents, timestamp);
    });
  });
  runCreate();

  return res.status(201).json(getSplitWithShares(splitId));
});

// ---------- POST /splits/:splitId/shares/:shareId/pay ----------
// Body: { payee } — "what are you paying for" is asked again here per your spec,
// since this becomes that person's own independent expense record.
// Logs a normal expense on the paying participant's own account (same category
// as the split), which is what makes it count against their own budget. No money
// moves between participants — this is not a transfer.
app.post('/splits/:splitId/shares/:shareId/pay', (req, res) => {
  const { splitId, shareId } = req.params;
  const { payee } = req.body;

  if (!payee || !payee.trim()) {
    return res.status(400).json({ error: 'payee is required (what are you paying for)' });
  }

  const split = db.prepare('SELECT * FROM splits WHERE id = ?').get(splitId);
  if (!split) {
    return res.status(404).json({ error: 'Split not found' });
  }
  const share = db.prepare('SELECT * FROM split_shares WHERE id = ? AND split_id = ?').get(shareId, splitId);
  if (!share) {
    return res.status(404).json({ error: 'Share not found on this split' });
  }
  if (share.status === 'PAID') {
    return res.status(409).json({ error: 'This share has already been paid' });
  }

  try {
    const expense = createExpenseInternal({
      account_id: share.account_id,
      category: split.category,
      amountCents: share.amount_cents,
      payee: payee.trim()
    });

    db.prepare(`UPDATE split_shares SET status = 'PAID', expense_id = ? WHERE id = ?`)
      .run(expense.id, shareId);

    return res.status(200).json(getSplitWithShares(splitId));
  } catch (err) {
    const statusCode = err.code === 'NOT_FOUND' ? 404
      : err.code === 'ACCOUNT_INACTIVE' ? 403
      : err.code === 'INSUFFICIENT_FUNDS' ? 422
      : 500;
    return res.status(statusCode).json({ error: err.message || 'Could not pay this share' });
  }
});
// ================== TRANSACTION IMPORT & ANALYTICS (Feature 5) ==================

// ---------- POST /import/transactions ----------
// Body: { account_id, csv_data } where csv_data is the raw CSV string
// Expected CSV columns: date, merchant, amount (minimum required)
app.post('/import/transactions', (req, res) => {
  const { account_id, csv_data } = req.body;

  if (!account_id || !csv_data) {
    return res.status(400).json({ error: 'account_id and csv_data are required' });
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const lines = csv_data.trim().split('\n');
  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV must have a header and at least one data row' });
  }

  // Parse header
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const dateIdx = header.indexOf('date');
  const merchantIdx = header.indexOf('merchant');
  const amountIdx = header.indexOf('amount');

  if (dateIdx === -1 || merchantIdx === -1 || amountIdx === -1) {
    return res.status(400).json({ error: 'CSV must have "date", "merchant", and "amount" columns' });
  }

  const imported = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',').map(c => c.trim());
    const txDate = cols[dateIdx];
    const merchant = cols[merchantIdx];
    const amountStr = cols[amountIdx];

    if (!txDate || !merchant || !amountStr) {
      errors.push(`Row ${i + 1}: missing required fields`);
      continue;
    }

    const amountCents = Math.round(Number(amountStr) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      errors.push(`Row ${i + 1}: invalid amount "${amountStr}"`);
      continue;
    }

    try {
      const txId = uuidv4();
      const timestamp = new Date(txDate).toISOString();
      if (isNaN(new Date(timestamp).getTime())) {
        errors.push(`Row ${i + 1}: invalid date "${txDate}"`);
        continue;
      }

      db.prepare(`
        INSERT INTO transactions
          (id, idempotency_key, from_account_id, to_account_id, amount_cents, status, created_at, updated_at, merchant)
        VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?, ?, ?)
      `).run(
        txId,
        `import_${account_id}_${i}_${Date.now()}`,
        account_id,
        account_id, // to_account_id = same account (import, not transfer)
        amountCents,
        timestamp,
        timestamp,
        merchant
      );

      imported.push({ date: txDate, merchant, amount: amountCents / 100 });
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err.message}`);
    }
  }

  return res.status(200).json({
    imported: imported.length,
    errors,
    data: imported
  });
});

// ---------- GET /analytics/spending?account_id=X&month=YYYY-MM ----------
// Returns total spending by merchant for a given month
app.get('/analytics/spending', (req, res) => {
  const { account_id, month } = req.query;

  if (!account_id) {
    return res.status(400).json({ error: 'account_id is required' });
  }

  let monthPrefix = currentMonthPrefix();
  if (month !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format' });
    }
    monthPrefix = month;
  }

  const rows = db.prepare(`
    SELECT merchant, SUM(amount_cents) AS total, COUNT(*) AS count
    FROM transactions
    WHERE from_account_id = ? AND created_at LIKE ? AND status = 'SUCCESS'
    GROUP BY merchant
    ORDER BY total DESC
  `).all(account_id, `${monthPrefix}%`);

  const data = rows.map(r => ({
    merchant: r.merchant || 'Uncategorized',
    total: r.total / 100,
    count: r.count
  }));

  const grandTotal = data.reduce((sum, d) => sum + d.total, 0);

  return res.json({
    month: monthPrefix,
    total_spending: grandTotal,
    by_merchant: data
  });
});
// ---------- DELETE /transactions/:id ----------
app.delete('/transactions/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  return res.status(200).json({ deleted: true, id });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));