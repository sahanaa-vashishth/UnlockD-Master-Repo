import { useEffect, useState, useCallback } from 'react'
import './App.css'

const API_BASE = 'http://localhost:4000'

interface Account {
  id: string
  owner_name: string
  balance: number
  savings_balance: number
  is_active: boolean
}

interface Transaction {
  id: string
  from_account_id: string
  to_account_id: string
  amount: number
  status: 'SUCCESS' | 'FAILED' | 'PENDING'
  failure_reason: string | null
  created_at: string
}

interface Expense {
  id: string
  account_id: string
  category: string
  amount: number
  payee: string
  created_at: string
}

interface SavingsTx {
  id: string
  account_id: string
  type: 'CONTRIBUTE' | 'WITHDRAW'
  amount: number
  created_at: string
}

interface Budget {
  id: string
  account_id: string
  category: string
  monthly_limit: number
  spent: number
  remaining: number
  utilization_pct: number
  approaching_limit: boolean
  over_limit: boolean
  goal_reached: boolean
}

const SPEND_CATEGORIES = ['Food', 'Entertainment', 'Miscellaneous'] as const
const ALL_CATEGORIES = [...SPEND_CATEGORIES, 'Savings'] as const

function currentMonthValue() {
  return new Date().toISOString().slice(0, 7) // "2026-07"
}

function formatMonthLabel(month: string) {
  // month is "YYYY-MM" -> "July 2026"
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
}

function formatMoney(amount: number) {
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function App() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [savingsTxs, setSavingsTxs] = useState<SavingsTx[]>([])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string>('')

  const [toAccountId, setToAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [showNewAccount, setShowNewAccount] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')
  const [newAccountBalance, setNewAccountBalance] = useState('')
  const [creating, setCreating] = useState(false)
  const [createMessage, setCreateMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [togglingStatus, setTogglingStatus] = useState(false)

  // Expense form
  const [expenseCategory, setExpenseCategory] = useState<typeof SPEND_CATEGORIES[number]>('Food')
  const [expenseAmount, setExpenseAmount] = useState('')
  const [expensePayee, setExpensePayee] = useState('')
  const [loggingExpense, setLoggingExpense] = useState(false)
  const [expenseMessage, setExpenseMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Savings form
  const [savingsAmount, setSavingsAmount] = useState('')
  const [savingsBusy, setSavingsBusy] = useState(false)
  const [savingsMessage, setSavingsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Budget form
  const [budgetCategory, setBudgetCategory] = useState<typeof ALL_CATEGORIES[number]>('Food')
  const [budgetLimit, setBudgetLimit] = useState('')
  const [savingBudget, setSavingBudget] = useState(false)
  const [budgetMessage, setBudgetMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Budget calendar — compare any two months (past, current, or future)
  const [monthA, setMonthA] = useState<string>(currentMonthValue())
  const [monthB, setMonthB] = useState<string>(currentMonthValue())
  const [budgetsA, setBudgetsA] = useState<Budget[]>([])
  const [budgetsB, setBudgetsB] = useState<Budget[]>([])
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState<string | null>(null)
  const [compareRefreshKey, setCompareRefreshKey] = useState(0)

  const loadData = useCallback(async (preferAccountId?: string) => {
    const [accRes, txRes] = await Promise.all([
      fetch(`${API_BASE}/accounts`),
      fetch(`${API_BASE}/transactions`),
    ])
    const accData: Account[] = await accRes.json()
    const txData: Transaction[] = await txRes.json()
    setAccounts(accData)
    setTransactions(txData)
    setActiveAccountId(prev => {
      if (preferAccountId) return preferAccountId
      if (prev && accData.some(a => a.id === prev)) return prev
      return accData.find(a => a.is_active)?.id ?? accData[0]?.id ?? ''
    })
  }, [])

  const loadBudgetingData = useCallback(async (accountId: string) => {
    if (!accountId) {
      setExpenses([])
      setSavingsTxs([])
      setBudgets([])
      return
    }
    const [expRes, savRes, budRes] = await Promise.all([
      fetch(`${API_BASE}/expenses?account_id=${accountId}`),
      fetch(`${API_BASE}/savings/transactions?account_id=${accountId}`),
      fetch(`${API_BASE}/budgets?account_id=${accountId}`),
    ])
    setExpenses(await expRes.json())
    setSavingsTxs(await savRes.json())
    const budData = await budRes.json()
    setBudgets(budData.budgets)
  }, [])

  const fetchBudgetsForMonth = useCallback(async (accountId: string, month: string): Promise<Budget[]> => {
    const res = await fetch(`${API_BASE}/budgets?account_id=${accountId}&month=${month}`)
    if (!res.ok) throw new Error('Could not load budgets for ' + month)
    const data = await res.json()
    return data.budgets as Budget[]
  }, [])

  useEffect(() => {
    if (!activeAccountId) {
      setBudgetsA([])
      setBudgetsB([])
      return
    }
    let cancelled = false
    setCompareLoading(true)
    setCompareError(null)
    Promise.all([
      fetchBudgetsForMonth(activeAccountId, monthA),
      fetchBudgetsForMonth(activeAccountId, monthB),
    ])
      .then(([a, b]) => {
        if (cancelled) return
        setBudgetsA(a)
        setBudgetsB(b)
      })
      .catch(() => {
        if (!cancelled) setCompareError('Could not load the budget comparison. Is the backend running?')
      })
      .finally(() => {
        if (!cancelled) setCompareLoading(false)
      })
    return () => { cancelled = true }
  }, [activeAccountId, monthA, monthB, fetchBudgetsForMonth, compareRefreshKey])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (activeAccountId) loadBudgetingData(activeAccountId)
  }, [activeAccountId, loadBudgetingData])

  const activeAccount = accounts.find(a => a.id === activeAccountId)

  const otherAccounts = accounts.filter(a => a.id !== activeAccountId && a.is_active)

  const accountTransactions = transactions.filter(
    tx => tx.from_account_id === activeAccountId || tx.to_account_id === activeAccountId
  )

  useEffect(() => {
    if (toAccountId && !otherAccounts.some(a => a.id === toAccountId)) {
      setToAccountId('')
    }
  }, [otherAccounts, toAccountId])

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)

    if (!toAccountId || !amount) {
      setMessage({ type: 'error', text: 'Choose a recipient and enter an amount.' })
      return
    }

    setSending(true)
    try {
      const res = await fetch(`${API_BASE}/transactions/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_account_id: activeAccountId,
          to_account_id: toAccountId,
          amount: Number(amount),
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Transfer failed.' })
      } else {
        setMessage({ type: 'success', text: `Sent $${formatMoney(Number(amount))} successfully.` })
        setAmount('')
        setToAccountId('')
        await loadData(activeAccountId)
      }
    } catch {
      setMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setSending(false)
    }
  }

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault()
    setCreateMessage(null)

    if (!newAccountName.trim()) {
      setCreateMessage({ type: 'error', text: 'Enter a name for the account.' })
      return
    }

    setCreating(true)
    try {
      const res = await fetch(`${API_BASE}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner_name: newAccountName.trim(),
          starting_balance: newAccountBalance ? Number(newAccountBalance) : 0,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setCreateMessage({ type: 'error', text: data.error || 'Could not create account.' })
      } else {
        setNewAccountName('')
        setNewAccountBalance('')
        setShowNewAccount(false)
        await loadData(data.id)
      }
    } catch {
      setCreateMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setCreating(false)
    }
  }

  async function handleToggleActive() {
    if (!activeAccount) return
    setTogglingStatus(true)
    setMessage(null)
    try {
      const res = await fetch(`${API_BASE}/accounts/${activeAccount.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !activeAccount.is_active }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Could not update account status.' })
      } else {
        await loadData(activeAccount.id)
      }
    } catch {
      setMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setTogglingStatus(false)
    }
  }

  async function handleLogExpense(e: React.FormEvent) {
    e.preventDefault()
    setExpenseMessage(null)

    if (!expenseAmount || !expensePayee.trim()) {
      setExpenseMessage({ type: 'error', text: 'Enter an amount and who you paid.' })
      return
    }

    setLoggingExpense(true)
    try {
      const res = await fetch(`${API_BASE}/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: activeAccountId,
          category: expenseCategory,
          amount: Number(expenseAmount),
          payee: expensePayee.trim(),
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setExpenseMessage({ type: 'error', text: data.error || 'Could not log expense.' })
      } else {
        setExpenseMessage({ type: 'success', text: `Logged $${formatMoney(Number(expenseAmount))} to ${expenseCategory}.` })
        setExpenseAmount('')
        setExpensePayee('')
        await loadData(activeAccountId)
        await loadBudgetingData(activeAccountId)
        setCompareRefreshKey(k => k + 1)
      }
    } catch {
      setExpenseMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setLoggingExpense(false)
    }
  }

  async function handleSavingsMove(type: 'contribute' | 'withdraw') {
    setSavingsMessage(null)
    if (!savingsAmount) {
      setSavingsMessage({ type: 'error', text: 'Enter an amount.' })
      return
    }

    setSavingsBusy(true)
    try {
      const res = await fetch(`${API_BASE}/savings/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: activeAccountId, amount: Number(savingsAmount) }),
      })
      const data = await res.json()

      if (!res.ok) {
        setSavingsMessage({ type: 'error', text: data.error || 'Could not update savings.' })
      } else {
        setSavingsMessage({
          type: 'success',
          text: type === 'contribute'
            ? `Moved $${formatMoney(Number(savingsAmount))} into savings.`
            : `Withdrew $${formatMoney(Number(savingsAmount))} from savings.`,
        })
        setSavingsAmount('')
        await loadData(activeAccountId)
        await loadBudgetingData(activeAccountId)
        setCompareRefreshKey(k => k + 1)
      }
    } catch {
      setSavingsMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setSavingsBusy(false)
    }
  }

  async function handleSetBudget(e: React.FormEvent) {
    e.preventDefault()
    setBudgetMessage(null)

    if (!budgetLimit) {
      setBudgetMessage({ type: 'error', text: 'Enter a monthly limit.' })
      return
    }

    setSavingBudget(true)
    try {
      const res = await fetch(`${API_BASE}/budgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: activeAccountId,
          category: budgetCategory,
          monthly_limit: Number(budgetLimit),
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setBudgetMessage({ type: 'error', text: data.error || 'Could not save budget.' })
      } else {
        setBudgetMessage({ type: 'success', text: `${budgetCategory} budget set to $${formatMoney(Number(budgetLimit))}/month.` })
        setBudgetLimit('')
        await loadBudgetingData(activeAccountId)
        setCompareRefreshKey(k => k + 1)
      }
    } catch {
      setBudgetMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setSavingBudget(false)
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          <span className="mark">▲</span> Zenith
        </div>
        <div className="header-right">
          {accounts.length > 0 && (
            <div className="account-switcher">
              {accounts.map(acc => (
                <button
                  key={acc.id}
                  className={acc.id === activeAccountId ? 'active' : ''}
                  onClick={() => setActiveAccountId(acc.id)}
                  title={acc.is_active ? '' : 'Disabled account'}
                >
                  {acc.owner_name}
                  {!acc.is_active && ' (disabled)'}
                </button>
              ))}
            </div>
          )}
          <button className="new-account-btn" onClick={() => setShowNewAccount(s => !s)}>
            {showNewAccount ? 'Cancel' : '+ New account'}
          </button>
        </div>
      </header>

      {showNewAccount && (
        <section className="new-account-panel">
          <form onSubmit={handleCreateAccount} className="new-account-form">
            <div className="field">
              <label htmlFor="new-name">Account holder name</label>
              <input
                id="new-name"
                type="text"
                placeholder="e.g. Charlie"
                value={newAccountName}
                onChange={e => setNewAccountName(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="new-balance">Starting balance (USD, optional)</label>
              <input
                id="new-balance"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={newAccountBalance}
                onChange={e => setNewAccountBalance(e.target.value)}
              />
            </div>
            <button className="send-btn" type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Create account'}
            </button>
            {createMessage && (
              <div className={`form-message ${createMessage.type}`}>{createMessage.text}</div>
            )}
          </form>
        </section>
      )}

      <section className="main-grid">
        <div className="balance-card">
          <div>
            <div className="label">
              Current balance {activeAccount && !activeAccount.is_active && (
                <span className="status-badge FAILED" style={{ marginLeft: 8 }}>DISABLED</span>
              )}
            </div>
            <div className="amount">${activeAccount ? formatMoney(activeAccount.balance) : '—'}</div>
            <div className="label" style={{ marginTop: 12 }}>Savings balance</div>
            <div className="amount" style={{ fontSize: '1.5rem' }}>
              ${activeAccount ? formatMoney(activeAccount.savings_balance) : '—'}
            </div>
          </div>
          <div className="owner-row">
            <div className="owner">{activeAccount?.owner_name ?? 'Loading…'}</div>
            {activeAccount && (
              <button
                type="button"
                className="toggle-status-btn"
                onClick={handleToggleActive}
                disabled={togglingStatus}
              >
                {togglingStatus
                  ? 'Updating…'
                  : activeAccount.is_active
                    ? 'Disable account'
                    : 'Re-enable account'}
              </button>
            )}
          </div>
        </div>

        <div className="transfer-card">
          <h2>Send money</h2>
          <form onSubmit={handleTransfer}>
            <div className="field">
              <label htmlFor="to">To</label>
              <select id="to" value={toAccountId} onChange={e => setToAccountId(e.target.value)}>
                <option value="">Select recipient</option>
                {otherAccounts.map(acc => (
                  <option key={acc.id} value={acc.id}>{acc.owner_name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="amount">Amount (USD)</label>
              <input
                id="amount"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </div>
            <button
              className="send-btn"
              type="submit"
              disabled={sending || !activeAccount?.is_active}
            >
              {sending ? 'Sending…' : 'Send transfer'}
            </button>
            {activeAccount && !activeAccount.is_active && (
              <div className="form-message error">
                This account is disabled and cannot send transfers.
              </div>
            )}
            {message && (
              <div className={`form-message ${message.type}`}>{message.text}</div>
            )}
          </form>
        </div>
      </section>

      <section className="main-grid" style={{ marginTop: 24 }}>
        <div className="transfer-card">
          <h2>Log an expense</h2>
          <form onSubmit={handleLogExpense}>
            <div className="field">
              <label htmlFor="expense-category">Category</label>
              <select
                id="expense-category"
                value={expenseCategory}
                onChange={e => setExpenseCategory(e.target.value as typeof SPEND_CATEGORIES[number])}
              >
                {SPEND_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="expense-payee">Paid to</label>
              <input
                id="expense-payee"
                type="text"
                placeholder="e.g. local grocer, helper, cinema"
                value={expensePayee}
                onChange={e => setExpensePayee(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="expense-amount">Amount (USD)</label>
              <input
                id="expense-amount"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={expenseAmount}
                onChange={e => setExpenseAmount(e.target.value)}
              />
            </div>
            <button className="send-btn" type="submit" disabled={loggingExpense || !activeAccount?.is_active}>
              {loggingExpense ? 'Logging…' : 'Log expense'}
            </button>
            {expenseMessage && (
              <div className={`form-message ${expenseMessage.type}`}>{expenseMessage.text}</div>
            )}
          </form>
        </div>

        <div className="transfer-card">
          <h2>Savings</h2>
          <div className="field">
            <label htmlFor="savings-amount">Amount (USD)</label>
            <input
              id="savings-amount"
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={savingsAmount}
              onChange={e => setSavingsAmount(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              type="button"
              className="send-btn"
              onClick={() => handleSavingsMove('contribute')}
              disabled={savingsBusy || !activeAccount?.is_active}
              style={{ flex: 1 }}
            >
              {savingsBusy ? 'Working…' : 'Add to savings'}
            </button>
            <button
              type="button"
              className="send-btn"
              onClick={() => handleSavingsMove('withdraw')}
              disabled={savingsBusy || !activeAccount?.is_active}
              style={{ flex: 1, background: '#7a7a7a' }}
            >
              {savingsBusy ? 'Working…' : 'Withdraw (emergency)'}
            </button>
          </div>
          {savingsMessage && (
            <div className={`form-message ${savingsMessage.type}`}>{savingsMessage.text}</div>
          )}
        </div>
      </section>

      <section className="ledger-section" style={{ marginTop: 24 }}>
        <h2>Budgets{activeAccount && <span className="ledger-subtitle"> — {activeAccount.owner_name}</span>}</h2>

        <form onSubmit={handleSetBudget} className="new-account-form" style={{ marginBottom: 20 }}>
          <div className="field">
            <label htmlFor="budget-category">Category</label>
            <select
              id="budget-category"
              value={budgetCategory}
              onChange={e => setBudgetCategory(e.target.value as typeof ALL_CATEGORIES[number])}
            >
              {ALL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="budget-limit">
              {budgetCategory === 'Savings' ? 'Monthly savings goal (USD)' : 'Monthly limit (USD)'}
            </label>
            <input
              id="budget-limit"
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={budgetLimit}
              onChange={e => setBudgetLimit(e.target.value)}
            />
          </div>
          <button className="send-btn" type="submit" disabled={savingBudget}>
            {savingBudget ? 'Saving…' : 'Set budget'}
          </button>
          {budgetMessage && (
            <div className={`form-message ${budgetMessage.type}`}>{budgetMessage.text}</div>
          )}
        </form>

        {budgets.length === 0 && (
          <div className="empty-state">No budgets set yet for {activeAccount?.owner_name ?? 'this account'}.</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {budgets.map(b => {
            const isSavings = b.category === 'Savings'
            const barColor = isSavings
              ? (b.goal_reached ? '#2f7a4f' : '#b8860b')
              : (b.over_limit ? '#b03a2e' : b.approaching_limit ? '#c9862c' : '#2f7a4f')
            const pctForBar = Math.min(100, Math.max(0, b.utilization_pct))

            return (
              <div key={b.id} style={{ padding: '14px 16px', border: '1px solid #e5e1d8', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <strong>{b.category}</strong>
                  <span>
                    ${formatMoney(b.spent)} / ${formatMoney(b.monthly_limit)}
                    {isSavings ? ' saved' : ' spent'}
                  </span>
                </div>
                <div style={{ background: '#eee', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                  <div style={{ width: `${pctForBar}%`, background: barColor, height: '100%' }} />
                </div>
                <div style={{ marginTop: 6, fontSize: '0.85rem', color: '#666' }}>
                  {isSavings
                    ? (b.goal_reached
                        ? `Goal reached! (${b.utilization_pct}%)`
                        : `${b.utilization_pct}% of this month's savings goal`)
                    : (b.over_limit
                        ? `Over budget by $${formatMoney(Math.abs(b.remaining))}`
                        : b.approaching_limit
                          ? `Approaching limit — $${formatMoney(b.remaining)} remaining`
                          : `$${formatMoney(b.remaining)} remaining`)}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="ledger-section" style={{ marginTop: 24 }}>
        <h2>Budget calendar{activeAccount && <span className="ledger-subtitle"> — {activeAccount.owner_name}</span>}</h2>
        <p style={{ color: '#666', fontSize: '0.9rem', marginTop: -8, marginBottom: 16 }}>
          Compare budget utilization across any two months. Pick a month that hasn't started yet to see it sitting at 0% — spend is always computed live from that month's actual activity, so nothing carries over.
        </p>

        <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="month-a">Month A</label>
            <input
              id="month-a"
              type="month"
              value={monthA}
              onChange={e => setMonthA(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="month-b">Month B</label>
            <input
              id="month-b"
              type="month"
              value={monthB}
              onChange={e => setMonthB(e.target.value)}
            />
          </div>
        </div>

        {compareError && <div className="form-message error">{compareError}</div>}
        {compareLoading && <div className="empty-state">Loading comparison…</div>}

        {!compareLoading && !compareError && (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {[{ label: formatMonthLabel(monthA), data: budgetsA }, { label: formatMonthLabel(monthB), data: budgetsB }].map((col, i) => (
              <div key={i} style={{ flex: 1, minWidth: 260 }}>
                <h3 style={{ fontSize: '1rem', marginBottom: 10 }}>{col.label}</h3>
                {col.data.length === 0 && (
                  <div className="empty-state">No budgets set for this account yet.</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {col.data.map(b => {
                    const isSavings = b.category === 'Savings'
                    const barColor = isSavings
                      ? (b.goal_reached ? '#2f7a4f' : '#b8860b')
                      : (b.over_limit ? '#b03a2e' : b.approaching_limit ? '#c9862c' : '#2f7a4f')
                    const pctForBar = Math.min(100, Math.max(0, b.utilization_pct))
                    return (
                      <div key={b.id} style={{ padding: '10px 14px', border: '1px solid #e5e1d8', borderRadius: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: '0.9rem' }}>
                          <strong>{b.category}</strong>
                          <span>${formatMoney(b.spent)} / ${formatMoney(b.monthly_limit)}</span>
                        </div>
                        <div style={{ background: '#eee', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                          <div style={{ width: `${pctForBar}%`, background: barColor, height: '100%' }} />
                        </div>
                        <div style={{ marginTop: 6, fontSize: '0.8rem', color: '#666' }}>
                          {b.utilization_pct}% {isSavings ? 'of savings goal' : 'utilized'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ledger-section" style={{ marginTop: 24 }}>
        <h2>
          Transaction ledger
          {activeAccount && <span className="ledger-subtitle"> — {activeAccount.owner_name}</span>}
        </h2>
        <div className="ledger">
          <div className="ledger-row head">
            <span>Date</span>
            <span>Parties</span>
            <span>Amount</span>
            <span>Status</span>
          </div>
          {accountTransactions.length === 0 && (
            <div className="empty-state">
              {activeAccount
                ? `No transactions yet for ${activeAccount.owner_name} — send a transfer above.`
                : 'No transactions yet — send your first transfer above.'}
            </div>
          )}
          {accountTransactions.map(tx => {
            const isOutgoing = tx.from_account_id === activeAccountId
            const fromName = accounts.find(a => a.id === tx.from_account_id)?.owner_name ?? tx.from_account_id
            const toName = accounts.find(a => a.id === tx.to_account_id)?.owner_name ?? tx.to_account_id
            return (
              <div className="ledger-row" key={tx.id}>
                <span>{formatTime(tx.created_at)}</span>
                <span className="parties">
                  <strong>{fromName}</strong> → <strong>{toName}</strong>
                </span>
                <span className={`amount ${isOutgoing ? 'debit' : 'credit'}`}>
                  {isOutgoing ? '−' : '+'}${formatMoney(tx.amount)}
                </span>
                <span className={`status-badge ${tx.status}`}>{tx.status}</span>
              </div>
            )
          })}
        </div>
      </section>

      <section className="ledger-section" style={{ marginTop: 24 }}>
        <h2>
          Expenses
          {activeAccount && <span className="ledger-subtitle"> — {activeAccount.owner_name}</span>}
        </h2>
        <div className="ledger">
          <div className="ledger-row head">
            <span>Date</span>
            <span>Category / Paid to</span>
            <span>Amount</span>
            <span>Status</span>
          </div>
          {expenses.length === 0 && (
            <div className="empty-state">No expenses logged yet.</div>
          )}
          {expenses.map(exp => (
            <div className="ledger-row" key={exp.id}>
              <span>{formatTime(exp.created_at)}</span>
              <span className="parties">
                <strong>{exp.category}</strong> → {exp.payee}
              </span>
              <span className="amount debit">−${formatMoney(exp.amount)}</span>
              <span className="status-badge SUCCESS">LOGGED</span>
            </div>
          ))}
        </div>
      </section>

      <section className="ledger-section" style={{ marginTop: 24 }}>
        <h2>
          Savings activity
          {activeAccount && <span className="ledger-subtitle"> — {activeAccount.owner_name}</span>}
        </h2>
        <div className="ledger">
          <div className="ledger-row head">
            <span>Date</span>
            <span>Type</span>
            <span>Amount</span>
            <span>Status</span>
          </div>
          {savingsTxs.length === 0 && (
            <div className="empty-state">No savings activity yet.</div>
          )}
          {savingsTxs.map(s => (
            <div className="ledger-row" key={s.id}>
              <span>{formatTime(s.created_at)}</span>
              <span className="parties"><strong>{s.type === 'CONTRIBUTE' ? 'Added to savings' : 'Withdrawn from savings'}</strong></span>
              <span className={`amount ${s.type === 'CONTRIBUTE' ? 'debit' : 'credit'}`}>
                {s.type === 'CONTRIBUTE' ? '−' : '+'}${formatMoney(s.amount)}
              </span>
              <span className="status-badge SUCCESS">SUCCESS</span>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

export default App