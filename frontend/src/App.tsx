import { useEffect, useState, useCallback } from 'react'
import './App.css'

const API_BASE = 'http://localhost:4000'

interface Account {
  id: string
  owner_name: string
  balance: number
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
      return accData[0]?.id ?? ''
    })
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const activeAccount = accounts.find(a => a.id === activeAccountId)
  const otherAccounts = accounts.filter(a => a.id !== activeAccountId)

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
                >
                  {acc.owner_name}
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
            <div className="label">Current balance</div>
            <div className="amount">${activeAccount ? formatMoney(activeAccount.balance) : '—'}</div>
          </div>
          <div className="owner">{activeAccount?.owner_name ?? 'Loading…'}</div>
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
            <button className="send-btn" type="submit" disabled={sending}>
              {sending ? 'Sending…' : 'Send transfer'}
            </button>
            {message && (
              <div className={`form-message ${message.type}`}>{message.text}</div>
            )}
          </form>
        </div>
      </section>

      <section className="ledger-section">
        <h2>Transaction ledger</h2>
        <div className="ledger">
          <div className="ledger-row head">
            <span>Date</span>
            <span>Parties</span>
            <span>Amount</span>
            <span>Status</span>
          </div>
          {transactions.length === 0 && (
            <div className="empty-state">No transactions yet — send your first transfer above.</div>
          )}
          {transactions.map(tx => {
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
    </>
  )
}

export default App