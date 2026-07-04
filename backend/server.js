const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { pool, init } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const now = () => new Date().toISOString();
const currentMonthPrefix = () => new Date().toISOString().slice(0, 7); // "2026-07"

const DEFAULT_SPEND_CATEGORIES = ['Food', 'Entertainment', 'Miscellaneous'];
const RESERVED_CATEGORY = 'Savings';

function normalizeCategory(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 40) return null;
  return trimmed;
}

// Small helper so every route can just `await q(...)` instead of managing
// pool.query boilerplate everywhere.
const q = (text, params) => pool.query(text, params);

// ================== ACCOUNTS ==================

app.get('/accounts', async (req, res) => {
  const { rows } = await q('SELECT * FROM accounts');
  res.json(rows.map(a => ({
    id: a.id,
    owner_name: a.owner_name,
    balance: a.balance_cents / 100,
    savings_balance: a.savings_balance_cents / 100,
    is_active: !!a.is_active
  })));
});

app.post('/accounts', async (req, res) => {
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

  await q(
    'INSERT INTO accounts (id, owner_name, balance_cents, savings_balance_cents, is_active, pin) VALUES ($1, $2, $3, 0, 1, $4)',
    [id, owner_name.trim(), startingCents, finalPin]
  );

  return res.status(201).json({
    id,
    owner_name: owner_name.trim(),
    balance: startingCents / 100,
    savings_balance: 0,
    is_active: true
  });
});

app.patch('/accounts/:id/status', async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false' });
  }

  const { rows } = await q('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Account not found' });

  await q('UPDATE accounts SET is_active = $1 WHERE id = $2', [is_active ? 1 : 0, id]);

  const updated = (await q('SELECT * FROM accounts WHERE id = $1', [id])).rows[0];
  return res.json({
    id: updated.id,
    owner_name: updated.owner_name,
    balance: updated.balance_cents / 100,
    savings_balance: updated.savings_balance_cents / 100,
    is_active: !!updated.is_active
  });
});

app.post('/accounts/:id/verify-pin', async (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;

  const { rows } = await q('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Account not found' });

  const valid = String(pin) === rows[0].pin;
  return res.status(valid ? 200 : 401).json({ valid });
});

app.patch('/accounts/:id/pin', async (req, res) => {
  const { id } = req.params;
  const { current_pin, new_pin } = req.body;

  const { rows } = await q('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
  if (String(current_pin) !== rows[0].pin) {
    return res.status(401).json({ error: 'Current PIN is incorrect' });
  }
  if (!/^\d{4}$/.test(String(new_pin))) {
    return res.status(400).json({ error: 'New PIN must be exactly 4 digits' });
  }

  await q('UPDATE accounts SET pin = $1 WHERE id = $2', [String(new_pin), id]);
  return res.json({ updated: true });
});

// ================== TRANSACTIONS (Feature 1) ==================

function buildTransactionQuery(query) {
  const { account_id, q: search, category, min_amount, max_amount, start_date, end_date } = query;
  const clauses = [];
  const params = [];
  let i = 1;

  if (account_id) {
    clauses.push(`(from_account_id = $${i} OR to_account_id = $${i + 1})`);
    params.push(account_id, account_id);
    i += 2;
  }
  if (search && search.trim()) {
    clauses.push(`(description LIKE $${i} OR merchant LIKE $${i + 1})`);
    const like = `%${search.trim()}%`;
    params.push(like, like);
    i += 2;
  }
  if (category && category.trim()) {
    clauses.push(`category = $${i}`);
    params.push(category.trim());
    i += 1;
  }
  if (min_amount !== undefined) {
    const cents = Math.round(Number(min_amount) * 100);
    if (Number.isFinite(cents)) {
      clauses.push(`amount_cents >= $${i}`);
      params.push(cents);
      i += 1;
    }
  }
  if (max_amount !== undefined) {
    const cents = Math.round(Number(max_amount) * 100);
    if (Number.isFinite(cents)) {
      clauses.push(`amount_cents <= $${i}`);
      params.push(cents);
      i += 1;
    }
  }
  if (start_date) {
    clauses.push(`created_at >= $${i}`);
    params.push(start_date);
    i += 1;
  }
  if (end_date) {
    clauses.push(`created_at <= $${i}`);
    params.push(end_date.length <= 10 ? `${end_date}T23:59:59.999Z` : end_date);
    i += 1;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

app.get('/transactions', async (req, res) => {
  const { where, params } = buildTransactionQuery(req.query);
  const { rows } = await q(`SELECT * FROM transactions ${where} ORDER BY created_at DESC`, params);
  res.json(rows.map(t => ({ ...t, amount: t.amount_cents / 100 })));
});

app.get('/transactions/export', async (req, res) => {
  const { where, params } = buildTransactionQuery(req.query);
  const { rows } = await q(`SELECT * FROM transactions ${where} ORDER BY created_at DESC`, params);

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

app.patch('/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const { category, description, merchant } = req.body;

  const { rows } = await q('SELECT * FROM transactions WHERE id = $1', [id]);
  const existing = rows[0];
  if (!existing) return res.status(404).json({ error: 'Transaction not found' });

  const nextCategory = category !== undefined ? normalizeCategory(category) : existing.category;
  if (category !== undefined && category !== null && category.trim() && !nextCategory) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  await q(
    `UPDATE transactions SET category = $1, description = $2, merchant = $3, updated_at = $4 WHERE id = $5`,
    [
      category !== undefined ? nextCategory : existing.category,
      description !== undefined ? description : existing.description,
      merchant !== undefined ? merchant : existing.merchant,
      now(),
      id
    ]
  );

  const updated = (await q('SELECT * FROM transactions WHERE id = $1', [id])).rows[0];
  return res.json({ ...updated, amount: updated.amount_cents / 100 });
});
const UNDO_WINDOW_MS = 5000;
const pendingTransferTimers = new Map(); // txId -> Timeout

async function executeTransfer(txId, from_account_id, to_account_id, amountCents) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = (await client.query('SELECT status FROM transactions WHERE id = $1', [txId])).rows[0];
    if (!current || current.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return; // already cancelled or otherwise no longer pending
    }

    const fromAccount = (await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [from_account_id])).rows[0];
    const toAccount = (await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [to_account_id])).rows[0];

    if (!fromAccount || !toAccount) {
      throw { code: 'NOT_FOUND', message: 'One or both accounts do not exist' };
    }
    if (!fromAccount.is_active || !toAccount.is_active) {
      throw { code: 'ACCOUNT_INACTIVE', message: 'One or both accounts are disabled' };
    }
    if (fromAccount.balance_cents < amountCents) {
      throw { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient balance for this transfer' };
    }

    await client.query('UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2', [amountCents, from_account_id]);
    await client.query('UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2', [amountCents, to_account_id]);
    await client.query(`UPDATE transactions SET status = 'SUCCESS', updated_at = $1 WHERE id = $2`, [now(), txId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    const reason = err.message || 'Unknown error';
    await q(`UPDATE transactions SET status = 'FAILED', failure_reason = $1, updated_at = $2 WHERE id = $3`, [reason, now(), txId]);
  } finally {
    client.release();
    pendingTransferTimers.delete(txId);
  }
}

app.post('/transactions/transfer', async (req, res) => {
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

  const existingTx = (await q('SELECT * FROM transactions WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
  if (existingTx) {
    return res.status(existingTx.status === 'SUCCESS' ? 200 : 409).json({
      ...existingTx,
      amount: existingTx.amount_cents / 100,
      duplicate: true
    });
  }

  const fromAccount = (await q('SELECT * FROM accounts WHERE id = $1', [from_account_id])).rows[0];
  const toAccount = (await q('SELECT * FROM accounts WHERE id = $1', [to_account_id])).rows[0];
  if (!fromAccount || !toAccount) {
    return res.status(404).json({ error: 'One or both accounts do not exist' });
  }
  if (!fromAccount.is_active || !toAccount.is_active) {
    return res.status(403).json({ error: 'One or both accounts are disabled' });
  }
  if (fromAccount.balance_cents < amountCents) {
    return res.status(422).json({ error: 'Insufficient balance for this transfer' });
  }

  const txId = uuidv4();
  const timestamp = now();

  await q(
    `INSERT INTO transactions (id, idempotency_key, from_account_id, to_account_id, amount_cents, status, failure_reason, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', NULL, $6, $7)`,
    [txId, idempotencyKey, from_account_id, to_account_id, amountCents, timestamp, timestamp]
  );

  const timer = setTimeout(() => {
    executeTransfer(txId, from_account_id, to_account_id, amountCents);
  }, UNDO_WINDOW_MS);
  pendingTransferTimers.set(txId, timer);

  const created = (await q('SELECT * FROM transactions WHERE id = $1', [txId])).rows[0];
  return res.status(201).json({
    ...created,
    amount: created.amount_cents / 100,
    undoable: true,
    undo_window_ms: UNDO_WINDOW_MS
  });
});

app.post('/transactions/:id/undo', async (req, res) => {
  const { id } = req.params;

  const timer = pendingTransferTimers.get(id);
  if (!timer) {
    return res.status(409).json({ error: 'This transaction can no longer be undone' });
  }

  clearTimeout(timer);
  pendingTransferTimers.delete(id);

  await q(`UPDATE transactions SET status = 'CANCELLED', updated_at = $1 WHERE id = $2`, [now(), id]);

  const updated = (await q('SELECT * FROM transactions WHERE id = $1', [id])).rows[0];
  return res.json({ ...updated, amount: updated.amount_cents / 100 });
});
// ================== EXPENSES (Feature 2) ==================

app.get('/expenses', async (req, res) => {
  const { account_id } = req.query;
  const { rows } = account_id
    ? await q('SELECT * FROM expenses WHERE account_id = $1 ORDER BY created_at DESC', [account_id])
    : await q('SELECT * FROM expenses ORDER BY created_at DESC');
  res.json(rows.map(e => ({ ...e, amount: e.amount_cents / 100 })));
});

// Shared helper — takes an existing pg client so callers can run it inside
// their own transaction (used directly by /expenses and by split "pay").
async function createExpenseWithClient(client, { account_id, category, amountCents, payee }) {
  const account = (await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account_id])).rows[0];
  if (!account) throw { code: 'NOT_FOUND', message: 'Account not found' };
  if (!account.is_active) throw { code: 'ACCOUNT_INACTIVE', message: 'Account is disabled' };
  if (account.balance_cents < amountCents) throw { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient balance for this expense' };

  const expenseId = uuidv4();
  const timestamp = now();

  await client.query('UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2', [amountCents, account_id]);
  await client.query(
    `INSERT INTO expenses (id, account_id, category, amount_cents, payee, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [expenseId, account_id, category, amountCents, payee, timestamp]
  );

  return (await client.query('SELECT * FROM expenses WHERE id = $1', [expenseId])).rows[0];
}

app.post('/expenses', async (req, res) => {
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await createExpenseWithClient(client, { account_id, category, amountCents, payee: payee.trim() });
    await client.query('COMMIT');
    return res.status(201).json({ ...created, amount: created.amount_cents / 100 });
  } catch (err) {
    await client.query('ROLLBACK');
    const statusCode = err.code === 'NOT_FOUND' ? 404
      : err.code === 'ACCOUNT_INACTIVE' ? 403
      : err.code === 'INSUFFICIENT_FUNDS' ? 422
      : 500;
    return res.status(statusCode).json({ error: err.message || 'Could not log expense' });
  } finally {
    client.release();
  }
});

// ================== SAVINGS (Feature 2) ==================

app.get('/savings/transactions', async (req, res) => {
  const { account_id } = req.query;
  const { rows } = account_id
    ? await q('SELECT * FROM savings_transactions WHERE account_id = $1 ORDER BY created_at DESC', [account_id])
    : await q('SELECT * FROM savings_transactions ORDER BY created_at DESC');
  res.json(rows.map(s => ({ ...s, amount: s.amount_cents / 100 })));
});

function handleSavingsMove(type) {
  return async (req, res) => {
    const { account_id, amount } = req.body;

    if (!account_id || amount === undefined) {
      return res.status(400).json({ error: 'account_id and amount are required' });
    }
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const account = (await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [account_id])).rows[0];
      if (!account) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Account not found' }); }
      if (!account.is_active) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Account is disabled' }); }

      if (type === 'CONTRIBUTE' && account.balance_cents < amountCents) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'Insufficient main balance to contribute this amount' });
      }
      if (type === 'WITHDRAW' && account.savings_balance_cents < amountCents) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'Insufficient savings balance to withdraw this amount' });
      }

      const id = uuidv4();
      const timestamp = now();

      if (type === 'CONTRIBUTE') {
        await client.query(
          'UPDATE accounts SET balance_cents = balance_cents - $1, savings_balance_cents = savings_balance_cents + $1 WHERE id = $2',
          [amountCents, account_id]
        );
      } else {
        await client.query(
          'UPDATE accounts SET balance_cents = balance_cents + $1, savings_balance_cents = savings_balance_cents - $1 WHERE id = $2',
          [amountCents, account_id]
        );
      }
      await client.query(
        `INSERT INTO savings_transactions (id, account_id, type, amount_cents, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [id, account_id, type, amountCents, timestamp]
      );

      await client.query('COMMIT');

      const created = (await q('SELECT * FROM savings_transactions WHERE id = $1', [id])).rows[0];
      const updatedAccount = (await q('SELECT * FROM accounts WHERE id = $1', [account_id])).rows[0];
      return res.status(201).json({
        ...created,
        amount: created.amount_cents / 100,
        account: {
          id: updatedAccount.id,
          balance: updatedAccount.balance_cents / 100,
          savings_balance: updatedAccount.savings_balance_cents / 100
        }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Could not complete savings action' });
    } finally {
      client.release();
    }
  };
}

app.post('/savings/contribute', handleSavingsMove('CONTRIBUTE'));
app.post('/savings/withdraw', handleSavingsMove('WITHDRAW'));

// ================== BUDGETS (Feature 2) ==================

app.get('/budgets', async (req, res) => {
  const { account_id, month } = req.query;
  if (!account_id) return res.status(400).json({ error: 'account_id is required' });

  let monthPrefix = currentMonthPrefix();
  if (month !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format' });
    }
    monthPrefix = month;
  }

  const budgets = (await q('SELECT * FROM budgets WHERE account_id = $1', [account_id])).rows;

  const result = [];
  for (const b of budgets) {
    let spentCents = 0;

    if (b.category === 'Savings') {
      const rows = (await q(
        `SELECT type, SUM(amount_cents) AS total FROM savings_transactions
         WHERE account_id = $1 AND created_at LIKE $2 GROUP BY type`,
        [account_id, `${monthPrefix}%`]
      )).rows;
      const contributed = Number(rows.find(r => r.type === 'CONTRIBUTE')?.total || 0);
      const withdrawn = Number(rows.find(r => r.type === 'WITHDRAW')?.total || 0);
      spentCents = contributed - withdrawn;
    } else {
      const row = (await q(
        `SELECT SUM(amount_cents) AS total FROM expenses WHERE account_id = $1 AND category = $2 AND created_at LIKE $3`,
        [account_id, b.category, `${monthPrefix}%`]
      )).rows[0];
      spentCents = Number(row.total || 0);
    }

    const limitCents = b.monthly_limit_cents;
    const utilizationPct = limitCents > 0 ? Math.round((spentCents / limitCents) * 100) : 0;

    result.push({
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
    });
  }

  res.json({ month: monthPrefix, budgets: result });
});

app.post('/budgets', async (req, res) => {
  const { account_id, monthly_limit } = req.body;
  const category = normalizeCategory(req.body.category);

  if (!account_id || !category || monthly_limit === undefined) {
    return res.status(400).json({ error: 'account_id, category and monthly_limit are required' });
  }
  const limitCents = Math.round(Number(monthly_limit) * 100);
  if (!Number.isFinite(limitCents) || limitCents <= 0) {
    return res.status(400).json({ error: 'monthly_limit must be a positive number' });
  }

  const account = (await q('SELECT * FROM accounts WHERE id = $1', [account_id])).rows[0];
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const existing = (await q('SELECT * FROM budgets WHERE account_id = $1 AND category = $2', [account_id, category])).rows[0];
  const timestamp = now();

  if (existing) {
    await q('UPDATE budgets SET monthly_limit_cents = $1, updated_at = $2 WHERE id = $3', [limitCents, timestamp, existing.id]);
  } else {
    await q(
      `INSERT INTO budgets (id, account_id, category, monthly_limit_cents, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), account_id, category, limitCents, timestamp, timestamp]
    );
  }

  const saved = (await q('SELECT * FROM budgets WHERE account_id = $1 AND category = $2', [account_id, category])).rows[0];
  return res.status(existing ? 200 : 201).json({
    id: saved.id,
    account_id: saved.account_id,
    category: saved.category,
    monthly_limit: saved.monthly_limit_cents / 100
  });
});

app.delete('/budgets/:id', async (req, res) => {
  const { id } = req.params;
  const existing = (await q('SELECT * FROM budgets WHERE id = $1', [id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Budget not found' });
  await q('DELETE FROM budgets WHERE id = $1', [id]);
  return res.status(200).json({ deleted: true, id });
});

app.get('/categories', async (req, res) => {
  const { account_id } = req.query;
  const used = new Set(DEFAULT_SPEND_CATEGORIES);

  if (account_id) {
    (await q('SELECT DISTINCT category FROM expenses WHERE account_id = $1', [account_id])).rows.forEach(r => used.add(r.category));
    (await q('SELECT DISTINCT category FROM budgets WHERE account_id = $1', [account_id])).rows.forEach(r => used.add(r.category));
  } else {
    (await q('SELECT DISTINCT category FROM expenses')).rows.forEach(r => used.add(r.category));
    (await q('SELECT DISTINCT category FROM budgets')).rows.forEach(r => used.add(r.category));
  }
  used.delete(RESERVED_CATEGORY);

  res.json({ spend_categories: Array.from(used).sort(), reserved: RESERVED_CATEGORY });
});

// ================== SPLIT A BILL (Feature 3) ==================

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

async function getSplitWithShares(splitId) {
  const split = (await q('SELECT * FROM splits WHERE id = $1', [splitId])).rows[0];
  if (!split) return null;
  const shares = (await q(
    `SELECT split_shares.*, accounts.owner_name AS owner_name
     FROM split_shares JOIN accounts ON accounts.id = split_shares.account_id
     WHERE split_shares.split_id = $1 ORDER BY split_shares.created_at ASC`,
    [splitId]
  )).rows;
  return serializeSplit(split, shares);
}

app.get('/splits', async (req, res) => {
  const { account_id } = req.query;

  let splitIds;
  if (account_id) {
    splitIds = (await q(
      `SELECT DISTINCT splits.id FROM splits
       LEFT JOIN split_shares ON split_shares.split_id = splits.id
       WHERE splits.creator_account_id = $1 OR split_shares.account_id = $1
       ORDER BY splits.id`,
      [account_id]
    )).rows.map(r => r.id);
  } else {
    splitIds = (await q('SELECT id FROM splits')).rows.map(r => r.id);
  }

  const results = [];
  for (const id of splitIds) results.push(await getSplitWithShares(id));
  results.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  res.json(results);
});

app.post('/splits', async (req, res) => {
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

  const creator = (await q('SELECT * FROM accounts WHERE id = $1', [creator_account_id])).rows[0];
  if (!creator) return res.status(404).json({ error: 'Creator account not found' });
  if (!creator.is_active) return res.status(403).json({ error: 'Creator account is disabled' });

  let shareRows;
  if (split_type === 'EQUAL') {
    const accountIds = participants.map(p => (typeof p === 'string' ? p : p.account_id));
    if (new Set(accountIds).size !== accountIds.length) {
      return res.status(400).json({ error: 'Duplicate participants are not allowed' });
    }
    const n = accountIds.length;
    const base = Math.floor(totalCents / n);
    const remainder = totalCents - base * n;
    shareRows = accountIds.map((account_id, i) => ({ account_id, amountCents: base + (i < remainder ? 1 : 0) }));
  } else {
    if (participants.some(p => typeof p !== 'object' || !p.account_id || p.amount === undefined)) {
      return res.status(400).json({ error: 'CUSTOM participants must each have account_id and amount' });
    }
    const accountIds = participants.map(p => p.account_id);
    if (new Set(accountIds).size !== accountIds.length) {
      return res.status(400).json({ error: 'Duplicate participants are not allowed' });
    }
    shareRows = participants.map(p => ({ account_id: p.account_id, amountCents: Math.round(Number(p.amount) * 100) }));
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

  for (const s of shareRows) {
    const acc = (await q('SELECT * FROM accounts WHERE id = $1', [s.account_id])).rows[0];
    if (!acc) return res.status(404).json({ error: `Participant account not found: ${s.account_id}` });
    if (!acc.is_active) return res.status(403).json({ error: `Participant account is disabled: ${acc.owner_name}` });
  }

  const splitId = uuidv4();
  const timestamp = now();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO splits (id, creator_account_id, category, payee, total_cents, split_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [splitId, creator_account_id, category, payee.trim(), totalCents, split_type, timestamp]
    );
    for (const s of shareRows) {
      await client.query(
        `INSERT INTO split_shares (id, split_id, account_id, amount_cents, status, expense_id, created_at) VALUES ($1, $2, $3, $4, 'PENDING', NULL, $5)`,
        [uuidv4(), splitId, s.account_id, s.amountCents, timestamp]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Could not create split' });
  } finally {
    client.release();
  }

  return res.status(201).json(await getSplitWithShares(splitId));
});

app.post('/splits/:splitId/shares/:shareId/pay', async (req, res) => {
  const { splitId, shareId } = req.params;
  const { payee } = req.body;

  if (!payee || !payee.trim()) {
    return res.status(400).json({ error: 'payee is required (what are you paying for)' });
  }

  const split = (await q('SELECT * FROM splits WHERE id = $1', [splitId])).rows[0];
  if (!split) return res.status(404).json({ error: 'Split not found' });
  const share = (await q('SELECT * FROM split_shares WHERE id = $1 AND split_id = $2', [shareId, splitId])).rows[0];
  if (!share) return res.status(404).json({ error: 'Share not found on this split' });
  if (share.status === 'PAID') return res.status(409).json({ error: 'This share has already been paid' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expense = await createExpenseWithClient(client, {
      account_id: share.account_id,
      category: split.category,
      amountCents: share.amount_cents,
      payee: payee.trim()
    });
    await client.query(`UPDATE split_shares SET status = 'PAID', expense_id = $1 WHERE id = $2`, [expense.id, shareId]);
    await client.query('COMMIT');
    return res.status(200).json(await getSplitWithShares(splitId));
  } catch (err) {
    await client.query('ROLLBACK');
    const statusCode = err.code === 'NOT_FOUND' ? 404
      : err.code === 'ACCOUNT_INACTIVE' ? 403
      : err.code === 'INSUFFICIENT_FUNDS' ? 422
      : 500;
    return res.status(statusCode).json({ error: err.message || 'Could not pay this share' });
  } finally {
    client.release();
  }
});

// ================== TRANSACTION IMPORT & ANALYTICS (Feature 5) ==================

app.post('/import/transactions', async (req, res) => {
  const { account_id, csv_data } = req.body;

  if (!account_id || !csv_data) {
    return res.status(400).json({ error: 'account_id and csv_data are required' });
  }

  const account = (await q('SELECT * FROM accounts WHERE id = $1', [account_id])).rows[0];
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const lines = csv_data.trim().split('\n');
  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV must have a header and at least one data row' });
  }

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

      await q(
        `INSERT INTO transactions (id, idempotency_key, from_account_id, to_account_id, amount_cents, status, created_at, updated_at, merchant)
         VALUES ($1, $2, $3, $4, $5, 'SUCCESS', $6, $7, $8)`,
        [txId, `import_${account_id}_${i}_${Date.now()}`, account_id, account_id, amountCents, timestamp, timestamp, merchant]
      );

      imported.push({ date: txDate, merchant, amount: amountCents / 100 });
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err.message}`);
    }
  }

  return res.status(200).json({ imported: imported.length, errors, data: imported });
});

app.get('/analytics/spending', async (req, res) => {
  const { account_id, month } = req.query;
  if (!account_id) return res.status(400).json({ error: 'account_id is required' });

  let monthPrefix = currentMonthPrefix();
  if (month !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format' });
    }
    monthPrefix = month;
  }

  const rows = (await q(
    `SELECT merchant, SUM(amount_cents) AS total, COUNT(*) AS count
     FROM transactions WHERE from_account_id = $1 AND created_at LIKE $2 AND status = 'SUCCESS'
     GROUP BY merchant ORDER BY total DESC`,
    [account_id, `${monthPrefix}%`]
  )).rows;

  const data = rows.map(r => ({ merchant: r.merchant || 'Uncategorized', total: Number(r.total) / 100, count: Number(r.count) }));
  const grandTotal = data.reduce((sum, d) => sum + d.total, 0);

  return res.json({ month: monthPrefix, total_spending: grandTotal, by_merchant: data });
});

app.delete('/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const existing = (await q('SELECT * FROM transactions WHERE id = $1', [id])).rows[0];
  if (!existing) return res.status(404).json({ error: 'Transaction not found' });
  await q('DELETE FROM transactions WHERE id = $1', [id]);
  return res.status(200).json({ deleted: true, id });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;

init()
  .then(() => {
    app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });