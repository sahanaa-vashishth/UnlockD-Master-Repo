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
  category?: string | null
  description?: string | null
  merchant?: string | null
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

interface SplitShare {
  id: string
  split_id: string
  account_id: string
  owner_name: string
  amount: number
  status: 'PENDING' | 'PAID'
  expense_id: string | null
}

interface Split {
  id: string
  creator_account_id: string
  category: string
  payee: string
  total: number
  split_type: 'EQUAL' | 'CUSTOM'
  created_at: string
  shares: SplitShare[]
}

const DEFAULT_SPEND_CATEGORIES = ['Food', 'Entertainment', 'Miscellaneous']
const RESERVED_CATEGORY = 'Savings'

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
  const [pendingUndo, setPendingUndo] = useState<{ txId: string; amount: number; secondsLeft: number } | null>(null)
  const [pinPrompt, setPinPrompt] = useState<{ accountId: string; onSuccess: () => void } | null>(null)
const [pinInput, setPinInput] = useState('')
const [pinError, setPinError] = useState('')
const [pinChecking, setPinChecking] = useState(false)
const [newAccountPin, setNewAccountPin] = useState('')
  const [showNewAccount, setShowNewAccount] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')
  const [newAccountBalance, setNewAccountBalance] = useState('')
  const [creating, setCreating] = useState(false)
  const [createMessage, setCreateMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [togglingStatus, setTogglingStatus] = useState(false)

  // Expense form
  const [categories, setCategories] = useState<string[]>([...DEFAULT_SPEND_CATEGORIES])
  const [expenseCategory, setExpenseCategory] = useState<string>('Food')
  const [expenseNewCategory, setExpenseNewCategory] = useState(false)
  const [expenseNewCategoryName, setExpenseNewCategoryName] = useState('')
  const [expenseAmount, setExpenseAmount] = useState('')
  const [expensePayee, setExpensePayee] = useState('')
  const [loggingExpense, setLoggingExpense] = useState(false)
  const [expenseMessage, setExpenseMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Savings form
  const [savingsAmount, setSavingsAmount] = useState('')
  const [savingsBusy, setSavingsBusy] = useState(false)
  const [savingsMessage, setSavingsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Budget form
  const [budgetCategory, setBudgetCategory] = useState<string>('Food')
  const [budgetNewCategory, setBudgetNewCategory] = useState(false)
  const [budgetNewCategoryName, setBudgetNewCategoryName] = useState('')
  const [budgetLimit, setBudgetLimit] = useState('')
  const [savingBudget, setSavingBudget] = useState(false)
  const [budgetMessage, setBudgetMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [deletingBudgetId, setDeletingBudgetId] = useState<string | null>(null)

  // Budget calendar — compare any two months (past, current, or future)
  const [monthA, setMonthA] = useState<string>(currentMonthValue())
  const [monthB, setMonthB] = useState<string>(currentMonthValue())
  const [budgetsA, setBudgetsA] = useState<Budget[]>([])
  const [budgetsB, setBudgetsB] = useState<Budget[]>([])
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState<string | null>(null)
  const [compareRefreshKey, setCompareRefreshKey] = useState(0)

  // ---- Split a bill (Feature 3) ----
  const [splits, setSplits] = useState<Split[]>([])
  const [showNewSplit, setShowNewSplit] = useState(false)
  const [splitCategory, setSplitCategory] = useState<string>('Food')
  const [splitNewCategory, setSplitNewCategory] = useState(false)
  const [splitNewCategoryName, setSplitNewCategoryName] = useState('')
  const [splitPayee, setSplitPayee] = useState('')
  const [splitTotal, setSplitTotal] = useState('')
  const [splitType, setSplitType] = useState<'EQUAL' | 'CUSTOM'>('EQUAL')
  const [selectedParticipants, setSelectedParticipants] = useState<Record<string, boolean>>({})
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({})
  const [creatingSplit, setCreatingSplit] = useState(false)
  const [splitMessage, setSplitMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Paying one pending share
  // Paying one pending share
  const [payingShare, setPayingShare] = useState<{ splitId: string; shareId: string } | null>(null)
  const [payPayeeInput, setPayPayeeInput] = useState('')
  const [payingBusy, setPayingBusy] = useState(false)
  const [payMessage, setPayMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // ---- Transaction Management (Feature 4) ----
  const [tmSearch, setTmSearch] = useState('')
  const [tmCategory, setTmCategory] = useState('')
  const [tmMinAmount, setTmMinAmount] = useState('')
  const [tmMaxAmount, setTmMaxAmount] = useState('')
  const [tmStartDate, setTmStartDate] = useState('')
  const [tmEndDate, setTmEndDate] = useState('')
  const [tmAccountOnly, setTmAccountOnly] = useState(true) // true = only active account
  const [managedTransactions, setManagedTransactions] = useState<Transaction[]>([])
  const [tmLoading, setTmLoading] = useState(false)
  const [tmMessage, setTmMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [editingTxId, setEditingTxId] = useState<string | null>(null)
  const [editCategory, setEditCategory] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editMerchant, setEditMerchant] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

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
  const saved = localStorage.getItem('activeAccountId')
  if (saved && accData.some(a => a.id === saved)) return saved
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
    const [expRes, savRes, budRes, catRes] = await Promise.all([
      fetch(`${API_BASE}/expenses?account_id=${accountId}`),
      fetch(`${API_BASE}/savings/transactions?account_id=${accountId}`),
      fetch(`${API_BASE}/budgets?account_id=${accountId}`),
      fetch(`${API_BASE}/categories?account_id=${accountId}`),
    ])
    setExpenses(await expRes.json())
    setSavingsTxs(await savRes.json())
    const budData = await budRes.json()
    setBudgets(budData.budgets)
    const catData = await catRes.json()
    setCategories(catData.spend_categories)
  }, [])

  const loadSplits = useCallback(async (accountId: string) => {
    if (!accountId) {
      setSplits([])
      return
    }
    const res = await fetch(`${API_BASE}/splits?account_id=${accountId}`)
    setSplits(await res.json())
  }, [])

  function buildTmParams(accountId: string) {
    const params = new URLSearchParams()
    if (tmAccountOnly && accountId) params.set('account_id', accountId)
    if (tmSearch.trim()) params.set('q', tmSearch.trim())
    if (tmCategory.trim()) params.set('category', tmCategory.trim())
    if (tmMinAmount) params.set('min_amount', tmMinAmount)
    if (tmMaxAmount) params.set('max_amount', tmMaxAmount)
    if (tmStartDate) params.set('start_date', tmStartDate)
    if (tmEndDate) params.set('end_date', tmEndDate)
    return params
  }

  const runTransactionSearch = useCallback(async () => {
    setTmLoading(true)
    setTmMessage(null)
    try {
      const params = buildTmParams(activeAccountId)
      const res = await fetch(`${API_BASE}/transactions?${params.toString()}`)
      if (!res.ok) throw new Error('Search failed')
      setManagedTransactions(await res.json())
    } catch {
      setTmMessage({ type: 'error', text: 'Could not search transactions. Is the backend running?' })
    } finally {
      setTmLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId, tmAccountOnly, tmSearch, tmCategory, tmMinAmount, tmMaxAmount, tmStartDate, tmEndDate])

  useEffect(() => {
    runTransactionSearch()
  }, [runTransactionSearch])

  function startEditTx(tx: Transaction) {
    setEditingTxId(tx.id)
    setEditCategory(tx.category || '')
    setEditDescription(tx.description || '')
    setEditMerchant(tx.merchant || '')
    setTmMessage(null)
  }

  async function handleSaveEditTx(txId: string) {
    setSavingEdit(true)
    setTmMessage(null)
    try {
      const res = await fetch(`${API_BASE}/transactions/${txId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: editCategory.trim() || null,
          description: editDescription.trim() || null,
          merchant: editMerchant.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setTmMessage({ type: 'error', text: data.error || 'Could not update transaction.' })
      } else {
        setEditingTxId(null)
        await runTransactionSearch()
        await loadData(activeAccountId)
      }
    } catch {
      setTmMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setSavingEdit(false)
    }
  }

  function handleExportTransactions() {
    const params = buildTmParams(activeAccountId)
    window.open(`${API_BASE}/transactions/export?${params.toString()}`, '_blank')
  }

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
    if (activeAccountId) {
      loadBudgetingData(activeAccountId)
      loadSplits(activeAccountId)
    }
  }, [activeAccountId, loadBudgetingData, loadSplits])
  useEffect(() => {
  if (activeAccountId) {
    localStorage.setItem('activeAccountId', activeAccountId)
  }
}, [activeAccountId])

  const activeAccount = accounts.find(a => a.id === activeAccountId)

  const otherAccounts = accounts.filter(a => a.id !== activeAccountId && a.is_active)

  const activeAccounts = accounts.filter(a => a.is_active)

  const accountTransactions = transactions.filter(
    tx => tx.from_account_id === activeAccountId || tx.to_account_id === activeAccountId
  )

  // All PENDING shares belonging to the active account, across every split
  // they're part of (whether they created it or were added to it).
  const myPendingShares = splits.flatMap(s =>
    s.shares
      .filter(sh => sh.account_id === activeAccountId && sh.status === 'PENDING')
      .map(sh => ({ split: s, share: sh }))
  )

  // Splits the active account created — for the live status view.
  const mySplits = splits.filter(s => s.creator_account_id === activeAccountId)

  useEffect(() => {
    if (toAccountId && !otherAccounts.some(a => a.id === toAccountId)) {
      setToAccountId('')
    }
  }, [otherAccounts, toAccountId])

  // Keep the participant checkbox list sane if accounts change while the
  // new-split form is open (e.g. an account gets disabled).
  useEffect(() => {
    setSelectedParticipants(prev => {
      const next: Record<string, boolean> = {}
      activeAccounts.forEach(a => {
        if (prev[a.id]) next[a.id] = true
      })
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length])
  function requirePin(accountId: string, onSuccess: () => void) {
    setPinError('')
    setPinInput('')
    setPinPrompt({ accountId, onSuccess })
  }

  async function submitPin(e: React.FormEvent) {
    e.preventDefault()
    if (!pinPrompt) return
    setPinChecking(true)
    setPinError('')
    try {
      const res = await fetch(`${API_BASE}/accounts/${pinPrompt.accountId}/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinInput }),
      })
      const data = await res.json()
      if (res.ok && data.valid) {
        const action = pinPrompt.onSuccess
        setPinPrompt(null)
        action()
      } else {
        setPinError('Incorrect PIN. Try again.')
      }
    } catch {
      setPinError('Could not reach the server.')
    } finally {
      setPinChecking(false)
    }
  }

 async function handleTransfer(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)

    if (!toAccountId || !amount) {
      setMessage({ type: 'error', text: 'Choose a recipient and enter an amount.' })
      return
    }

    requirePin(activeAccountId, () => doTransfer())
  }

  async function doTransfer() {
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
        setMessage(null)
        setPendingUndo({ txId: data.id, amount: Number(amount), secondsLeft: 5 })
        setAmount('')
        setToAccountId('')
      }
    } catch {
      setMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setSending(false)
    }
  }

  async function handleUndoTransfer(txId: string) {
    try {
      await fetch(`${API_BASE}/transactions/${txId}/undo`, { method: 'POST' })
    } finally {
      setPendingUndo(null)
      setMessage({ type: 'success', text: 'Transfer cancelled.' })
      await loadData(activeAccountId)
    }
  }

  useEffect(() => {
    if (!pendingUndo) return
    if (pendingUndo.secondsLeft <= 0) {
      setPendingUndo(null)
      setMessage({ type: 'success', text: `Sent $${formatMoney(pendingUndo.amount)} successfully.` })
      loadData(activeAccountId)
      return
    }
    const t = setTimeout(() => {
      setPendingUndo(p => p ? { ...p, secondsLeft: p.secondsLeft - 1 } : p)
    }, 1000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUndo])

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
          pin: newAccountPin || undefined,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setCreateMessage({ type: 'error', text: data.error || 'Could not create account.' })
      } else {
        setNewAccountName('')
        setNewAccountBalance('')
        setNewAccountPin('')
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

    const effectiveCategory = expenseNewCategory ? expenseNewCategoryName.trim() : expenseCategory

    if (!expenseAmount || !expensePayee.trim()) {
      setExpenseMessage({ type: 'error', text: 'Enter an amount and who you paid.' })
      return
    }
    if (!effectiveCategory) {
      setExpenseMessage({ type: 'error', text: 'Enter a category name.' })
      return
    }

    setLoggingExpense(true)
    try {
      const res = await fetch(`${API_BASE}/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: activeAccountId,
          category: effectiveCategory,
          amount: Number(expenseAmount),
          payee: expensePayee.trim(),
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setExpenseMessage({ type: 'error', text: data.error || 'Could not log expense.' })
      } else {
        setExpenseMessage({ type: 'success', text: `Logged $${formatMoney(Number(expenseAmount))} to ${effectiveCategory}.` })
        setExpenseAmount('')
        setExpensePayee('')
        if (expenseNewCategory) {
          setExpenseCategory(effectiveCategory)
          setExpenseNewCategory(false)
          setExpenseNewCategoryName('')
        }
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

    const effectiveCategory = budgetNewCategory ? budgetNewCategoryName.trim() : budgetCategory

    if (!budgetLimit) {
      setBudgetMessage({ type: 'error', text: 'Enter a monthly limit.' })
      return
    }
    if (!effectiveCategory) {
      setBudgetMessage({ type: 'error', text: 'Enter a category name.' })
      return
    }

    setSavingBudget(true)
    try {
      const res = await fetch(`${API_BASE}/budgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: activeAccountId,
          category: effectiveCategory,
          monthly_limit: Number(budgetLimit),
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setBudgetMessage({ type: 'error', text: data.error || 'Could not save budget.' })
      } else {
        setBudgetMessage({ type: 'success', text: `${effectiveCategory} budget set to $${formatMoney(Number(budgetLimit))}/month.` })
        setBudgetLimit('')
        if (budgetNewCategory) {
          setBudgetCategory(effectiveCategory)
          setBudgetNewCategory(false)
          setBudgetNewCategoryName('')
        }
        await loadBudgetingData(activeAccountId)
        setCompareRefreshKey(k => k + 1)
      }
    } catch {
      setBudgetMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setSavingBudget(false)
    }
  }

  async function handleDeleteBudget(budgetId: string, category: string) {
    setBudgetMessage(null)
    setDeletingBudgetId(budgetId)
    try {
      const res = await fetch(`${API_BASE}/budgets/${budgetId}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setBudgetMessage({ type: 'error', text: data.error || 'Could not delete budget.' })
      } else {
        setBudgetMessage({ type: 'success', text: `Deleted the ${category} budget. Past activity in that category is unaffected.` })
        await loadBudgetingData(activeAccountId)
        setCompareRefreshKey(k => k + 1)
      }
    } catch {
      setBudgetMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setDeletingBudgetId(null)
    }
  }

  function toggleParticipant(accountId: string) {
    setSelectedParticipants(prev => ({ ...prev, [accountId]: !prev[accountId] }))
  }

  async function handleCreateSplit(e: React.FormEvent) {
    e.preventDefault()
    setSplitMessage(null)

    const effectiveCategory = splitNewCategory ? splitNewCategoryName.trim() : splitCategory
    const chosenIds = Object.keys(selectedParticipants).filter(id => selectedParticipants[id])

    if (!splitPayee.trim() || !splitTotal) {
      setSplitMessage({ type: 'error', text: 'Enter who was paid and the total amount.' })
      return
    }
    if (!effectiveCategory) {
      setSplitMessage({ type: 'error', text: 'Enter a category name.' })
      return
    }
    if (chosenIds.length === 0) {
      setSplitMessage({ type: 'error', text: 'Select at least one person to split with.' })
      return
    }

    let participantsPayload: unknown
    if (splitType === 'EQUAL') {
      participantsPayload = chosenIds
    } else {
      const withAmounts = chosenIds.map(id => ({ account_id: id, amount: Number(customAmounts[id] || '0') }))
      if (withAmounts.some(p => !p.amount || p.amount <= 0)) {
        setSplitMessage({ type: 'error', text: 'Enter a positive amount for every selected person.' })
        return
      }
      participantsPayload = withAmounts
    }

    setCreatingSplit(true)
    try {
      const res = await fetch(`${API_BASE}/splits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creator_account_id: activeAccountId,
          category: effectiveCategory,
          payee: splitPayee.trim(),
          total: Number(splitTotal),
          split_type: splitType,
          participants: participantsPayload,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setSplitMessage({ type: 'error', text: data.error || 'Could not create split.' })
      } else {
        setSplitMessage({ type: 'success', text: `Split created for $${formatMoney(Number(splitTotal))} across ${chosenIds.length} people.` })
        setSplitPayee('')
        setSplitTotal('')
        setSelectedParticipants({})
        setCustomAmounts({})
        if (splitNewCategory) {
          setSplitCategory(effectiveCategory)
          setSplitNewCategory(false)
          setSplitNewCategoryName('')
        }
        setShowNewSplit(false)
        await loadSplits(activeAccountId)
      }
    } catch {
      setSplitMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setCreatingSplit(false)
    }
  }

  function openPayShare(splitId: string, shareId: string) {
    setPayMessage(null)
    setPayPayeeInput('')
    setPayingShare({ splitId, shareId })
  }

  async function handlePayShare(e: React.FormEvent) {
    e.preventDefault()
    if (!payingShare) return
    setPayMessage(null)

    if (!payPayeeInput.trim()) {
      setPayMessage({ type: 'error', text: 'Enter what you\'re paying for.' })
      return
    }

    setPayingBusy(true)
    try {
      const res = await fetch(
        `${API_BASE}/splits/${payingShare.splitId}/shares/${payingShare.shareId}/pay`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payee: payPayeeInput.trim() }),
        }
      )
      const data = await res.json()

      if (!res.ok) {
        setPayMessage({ type: 'error', text: data.error || 'Could not pay this share.' })
      } else {
        setPayingShare(null)
        setPayPayeeInput('')
        await loadData(activeAccountId)
        await loadBudgetingData(activeAccountId)
        await loadSplits(activeAccountId)
        setCompareRefreshKey(k => k + 1)
      }
    } catch {
      setPayMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' })
    } finally {
      setPayingBusy(false)
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
                  onClick={() => requirePin(acc.id, () => setActiveAccountId(acc.id))}
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
            <div className="field">
  <label htmlFor="new-pin">4-digit PIN (optional, defaults to 0000)</label>
  <input
    id="new-pin"
    type="text"
    inputMode="numeric"
    maxLength={4}
    placeholder="0000"
    value={newAccountPin}
    onChange={e => setNewAccountPin(e.target.value.replace(/\D/g, ''))}
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>Split a bill</h2>
            <button
              type="button"
              className="new-account-btn"
              onClick={() => { setSplitMessage(null); setShowNewSplit(s => !s) }}
              disabled={!activeAccount?.is_active}
            >
              {showNewSplit ? 'Cancel' : '+ New split'}
            </button>
          </div>

          {showNewSplit && (
            <form onSubmit={handleCreateSplit} style={{ marginTop: 16 }}>
              <div className="field">
                <label htmlFor="split-category">Category</label>
                <select
                  id="split-category"
                  value={splitNewCategory ? '__new__' : splitCategory}
                  onChange={e => {
                    if (e.target.value === '__new__') {
                      setSplitNewCategory(true)
                    } else {
                      setSplitNewCategory(false)
                      setSplitCategory(e.target.value)
                    }
                  }}
                >
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  <option value="__new__">+ Add new category…</option>
                </select>
                {splitNewCategory && (
                  <input
                    type="text"
                    placeholder="e.g. Trip, Groceries"
                    value={splitNewCategoryName}
                    onChange={e => setSplitNewCategoryName(e.target.value)}
                    style={{ marginTop: 8 }}
                    autoFocus
                  />
                )}
              </div>

              <div className="field">
                <label htmlFor="split-payee">Paid to</label>
                <input
                  id="split-payee"
                  type="text"
                  placeholder="e.g. restaurant, cab driver"
                  value={splitPayee}
                  onChange={e => setSplitPayee(e.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="split-total">Total amount (USD)</label>
                <input
                  id="split-total"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  value={splitTotal}
                  onChange={e => setSplitTotal(e.target.value)}
                />
              </div>

              <div className="field">
                <label>How to split</label>
                <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
                    <input
                      type="radio"
                      name="split-type"
                      checked={splitType === 'EQUAL'}
                      onChange={() => setSplitType('EQUAL')}
                    />
                    Equally
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
                    <input
                      type="radio"
                      name="split-type"
                      checked={splitType === 'CUSTOM'}
                      onChange={() => setSplitType('CUSTOM')}
                    />
                    According to what you bought
                  </label>
                </div>
              </div>

              <div className="field">
                <label>Split with</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                  {activeAccounts.map(acc => (
                    <div key={acc.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, flex: 1 }}>
                        <input
                          type="checkbox"
                          checked={!!selectedParticipants[acc.id]}
                          onChange={() => toggleParticipant(acc.id)}
                        />
                        {acc.owner_name}{acc.id === activeAccountId ? ' (you)' : ''}
                      </label>
                      {splitType === 'CUSTOM' && selectedParticipants[acc.id] && (
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          placeholder="0.00"
                          value={customAmounts[acc.id] || ''}
                          onChange={e => setCustomAmounts(prev => ({ ...prev, [acc.id]: e.target.value }))}
                          style={{ width: 100 }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <button className="send-btn" type="submit" disabled={creatingSplit}>
                {creatingSplit ? 'Creating…' : 'Create split'}
              </button>
              {splitMessage && (
                <div className={`form-message ${splitMessage.type}`}>{splitMessage.text}</div>
              )}
            </form>
          )}

          {!showNewSplit && (
            <>
              <h3 style={{ fontSize: '0.95rem', marginTop: 16, marginBottom: 8, color: '#666' }}>
                Your pending payments
              </h3>
              {myPendingShares.length === 0 && (
                <div className="empty-state">Nothing pending — you're all settled up.</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {myPendingShares.map(({ split, share }) => (
                  <div key={share.id} style={{ padding: '10px 14px', border: '1px solid #e5e1d8', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <strong>{split.category}</strong> — {split.payee}
                        <div style={{ fontSize: '0.8rem', color: '#666' }}>
                          Your share: ${formatMoney(share.amount)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="send-btn"
                        onClick={() => openPayShare(split.id, share.id)}
                        style={{ padding: '6px 14px', fontSize: '0.85rem' }}
                      >
                        Pay
                      </button>
                    </div>

                    {payingShare?.splitId === split.id && payingShare?.shareId === share.id && (
                      <form onSubmit={handlePayShare} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #eee' }}>
                        <div className="field">
                          <label htmlFor={`pay-payee-${share.id}`}>What are you paying for?</label>
                          <input
                            id={`pay-payee-${share.id}`}
                            type="text"
                            placeholder="e.g. my share of dinner"
                            value={payPayeeInput}
                            onChange={e => setPayPayeeInput(e.target.value)}
                            autoFocus
                          />
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="send-btn" type="submit" disabled={payingBusy} style={{ flex: 1 }}>
                            {payingBusy ? 'Paying…' : `Pay $${formatMoney(share.amount)}`}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPayingShare(null)}
                            style={{ flex: 1, background: '#eee', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                        </div>
                        {payMessage && (
                          <div className={`form-message ${payMessage.type}`}>{payMessage.text}</div>
                        )}
                      </form>
                    )}
                  </div>
                ))}
              </div>

              <h3 style={{ fontSize: '0.95rem', marginTop: 20, marginBottom: 8, color: '#666' }}>
                Splits you created
              </h3>
              {mySplits.length === 0 && (
                <div className="empty-state">You haven't created any splits yet.</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {mySplits.map(split => (
                  <div key={split.id} style={{ padding: '10px 14px', border: '1px solid #e5e1d8', borderRadius: 8 }}>
                    <div style={{ marginBottom: 6 }}>
                      <strong>{split.category}</strong> — {split.payee} · ${formatMoney(split.total)} total
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {split.shares.map(sh => (
                        <div key={sh.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                          <span>{sh.owner_name}{sh.account_id === activeAccountId ? ' (you)' : ''} — ${formatMoney(sh.amount)}</span>
                          <span className={`status-badge ${sh.status === 'PAID' ? 'SUCCESS' : 'PENDING'}`}>{sh.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
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

      <section className="main-grid" style={{ marginTop: 24 }}>
        <div className="transfer-card">
          <h2>Log an expense</h2>
          <form onSubmit={handleLogExpense}>
            <div className="field">
              <label htmlFor="expense-category">Category</label>
              <select
                id="expense-category"
                value={expenseNewCategory ? '__new__' : expenseCategory}
                onChange={e => {
                  if (e.target.value === '__new__') {
                    setExpenseNewCategory(true)
                  } else {
                    setExpenseNewCategory(false)
                    setExpenseCategory(e.target.value)
                  }
                }}
              >
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
                <option value="__new__">+ Add new category…</option>
              </select>
              {expenseNewCategory && (
                <input
                  type="text"
                  placeholder="e.g. Dream Vacation, TV"
                  value={expenseNewCategoryName}
                  onChange={e => setExpenseNewCategoryName(e.target.value)}
                  style={{ marginTop: 8 }}
                  autoFocus
                />
              )}
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
          <h2>Budgets{activeAccount && <span className="ledger-subtitle"> — {activeAccount.owner_name}</span>}</h2>

          <form onSubmit={handleSetBudget} style={{ marginBottom: 20 }}>
          <div className="field">
            <label htmlFor="budget-category">Category</label>
            <select
              id="budget-category"
              value={budgetNewCategory ? '__new__' : budgetCategory}
              onChange={e => {
                if (e.target.value === '__new__') {
                  setBudgetNewCategory(true)
                } else {
                  setBudgetNewCategory(false)
                  setBudgetCategory(e.target.value)
                }
              }}
            >
              {[...categories, RESERVED_CATEGORY].map(c => <option key={c} value={c}>{c}</option>)}
              <option value="__new__">+ Add new category…</option>
            </select>
            {budgetNewCategory && (
              <input
                type="text"
                placeholder="e.g. Dream Vacation, TV"
                value={budgetNewCategoryName}
                onChange={e => setBudgetNewCategoryName(e.target.value)}
                style={{ marginTop: 8 }}
                autoFocus
              />
            )}
          </div>
          <div className="field">
            <label htmlFor="budget-limit">
              {(budgetNewCategory ? budgetNewCategoryName : budgetCategory) === RESERVED_CATEGORY ? 'Monthly savings goal (USD)' : 'Monthly limit (USD)'}
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <strong>{b.category}</strong>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span>
                      ${formatMoney(b.spent)} / ${formatMoney(b.monthly_limit)}
                      {isSavings ? ' saved' : ' spent'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDeleteBudget(b.id, b.category)}
                      disabled={deletingBudgetId === b.id}
                      title={`Delete ${b.category} budget`}
                      style={{
                        background: 'none',
                        border: '1px solid #d9887e',
                        color: '#b03a2e',
                        borderRadius: 6,
                        padding: '2px 8px',
                        fontSize: '0.75rem',
                        cursor: deletingBudgetId === b.id ? 'default' : 'pointer',
                      }}
                    >
                      {deletingBudgetId === b.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
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

      <section className="ledger-section" style={{ marginTop: 24 }}>
        <h2>Transaction Management</h2>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <div className="field" style={{ flex: 2, minWidth: 200 }}>
            <label htmlFor="tm-search">Search (description / merchant)</label>
            <input
              id="tm-search"
              type="text"
              placeholder="e.g. Amazon, groceries"
              value={tmSearch}
              onChange={e => setTmSearch(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 140 }}>
            <label htmlFor="tm-category">Category</label>
            <input
              id="tm-category"
              type="text"
              placeholder="e.g. Food"
              value={tmCategory}
              onChange={e => setTmCategory(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 120 }}>
            <label htmlFor="tm-min">Min amount</label>
            <input
              id="tm-min"
              type="number"
              step="0.01"
              value={tmMinAmount}
              onChange={e => setTmMinAmount(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 120 }}>
            <label htmlFor="tm-max">Max amount</label>
            <input
              id="tm-max"
              type="number"
              step="0.01"
              value={tmMaxAmount}
              onChange={e => setTmMaxAmount(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label htmlFor="tm-start">From date</label>
            <input
              id="tm-start"
              type="date"
              value={tmStartDate}
              onChange={e => setTmStartDate(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label htmlFor="tm-end">To date</label>
            <input
              id="tm-end"
              type="date"
              value={tmEndDate}
              onChange={e => setTmEndDate(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={tmAccountOnly}
              onChange={e => setTmAccountOnly(e.target.checked)}
            />
            Only {activeAccount?.owner_name ?? 'this account'}
          </label>
          <button type="button" className="new-account-btn" onClick={handleExportTransactions}>
            Export CSV
          </button>
        </div>

        {tmMessage && <div className={`form-message ${tmMessage.type}`}>{tmMessage.text}</div>}
        {tmLoading && <div className="empty-state">Searching…</div>}

        {!tmLoading && (
          <div className="ledger">
            <div className="ledger-row tm-row head">
              <span>Date</span>
              <span>Category / Merchant / Description</span>
              <span>Amount</span>
              <span>Actions</span>
            </div>
            {managedTransactions.length === 0 && (
              <div className="empty-state">No transactions match these filters.</div>
            )}
            {managedTransactions.map(tx => {
              const isOutgoing = tx.from_account_id === activeAccountId
              const isEditing = editingTxId === tx.id
              return (
                <div className="ledger-row tm-row" key={tx.id}>
                  <span>{formatTime(tx.created_at)}</span>
                  {isEditing ? (
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <input
                        type="text"
                        placeholder="Category"
                        value={editCategory}
                        onChange={e => setEditCategory(e.target.value)}
                      />
                      <input
                        type="text"
                        placeholder="Merchant"
                        value={editMerchant}
                        onChange={e => setEditMerchant(e.target.value)}
                      />
                      <input
                        type="text"
                        placeholder="Description"
                        value={editDescription}
                        onChange={e => setEditDescription(e.target.value)}
                      />
                    </span>
                  ) : (
                    <span className="parties">
                      {tx.category && <strong>{tx.category}</strong>}
                      {tx.merchant && ` · ${tx.merchant}`}
                      {tx.description && ` — ${tx.description}`}
                      {!tx.category && !tx.merchant && !tx.description && <em>Uncategorized</em>}
                    </span>
                  )}
                  <span className={`amount ${isOutgoing ? 'debit' : 'credit'}`}>
                    {isOutgoing ? '−' : '+'}${formatMoney(tx.amount)}
                  </span>
               <span>
  {isEditing ? (
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        type="button"
        className="send-btn"
        style={{ padding: '4px 10px', fontSize: '0.8rem' }}
        disabled={savingEdit}
        onClick={() => handleSaveEditTx(tx.id)}
      >
        {savingEdit ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        style={{ padding: '4px 10px', fontSize: '0.8rem', background: '#eee', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        onClick={() => setEditingTxId(null)}
      >
        Cancel
      </button>
    </div>
  ) : (
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        type="button"
        style={{ padding: '4px 10px', fontSize: '0.8rem', background: '#eee', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        onClick={() => startEditTx(tx)}
      >
        Edit
      </button>
      <button
        type="button"
        style={{ padding: '4px 10px', fontSize: '0.8rem', background: '#d9887e', color: '#b03a2e', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        onClick={async () => {
          try {
            const res = await fetch(`${API_BASE}/transactions/${tx.id}`, { method: 'DELETE' });
            if (res.ok) {
              await runTransactionSearch();
            } else {
              setTmMessage({ type: 'error', text: 'Could not delete transaction.' });
            }
          } catch {
            setTmMessage({ type: 'error', text: 'Could not reach server.' });
          }
        }}
      >
        Delete
      </button>
    </div>
  )}
</span>
                  
                </div>
              )
            })}
          </div>
        )}
      </section>
      <section className="ledger-section" style={{ marginTop: 24 }}>
    <h2>Import transactions</h2>
    <p style={{ color: '#666', fontSize: '0.9rem', marginTop: -8, marginBottom: 16 }}>
      Paste CSV data with columns: <strong>date, merchant, amount</strong>. Dates should be ISO format (2026-07-03).
    </p>
<form onSubmit={async (e) => {
  e.preventDefault();
  const csvData = (e.currentTarget.elements.namedItem('csv-data') as HTMLTextAreaElement)?.value || '';
  if (!csvData.trim()) {
    setTmMessage({ type: 'error', text: 'Paste CSV data first.' });
    return;
  }
  
  const targetAccountId = activeAccountId;
  if (!targetAccountId) {
    setTmMessage({ type: 'error', text: 'No account selected.' });
    return;
  }
  
let res: Response;
  try {
    res = await fetch(`${API_BASE}/import/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: targetAccountId, csv_data: csvData })
    });
  } catch {
    setTmMessage({ type: 'error', text: 'Could not reach the server. Is the backend running?' });
    return;
  }

  try {
    const data = await res.json();
    if (!res.ok) {
      setTmMessage({ type: 'error', text: data.error || 'Import failed' });
    } else {
      setTmMessage({ type: 'success', text: `Imported ${data.imported} transactions${data.errors.length > 0 ? ` (${data.errors.length} errors)` : '.'}` });
      (e.currentTarget.elements.namedItem('csv-data') as HTMLTextAreaElement).value = '';
      await loadData(targetAccountId);
      runTransactionSearch();
      setCompareRefreshKey(k => k + 1);
    }
  } catch {
    setTmMessage({ type: 'error', text: 'Import succeeded but the response could not be read. Refresh to confirm.' });
  }
}}>
      <textarea
        name="csv-data"
        placeholder="date,merchant,amount&#10;2026-07-01,Starbucks,5.50&#10;2026-07-02,Amazon,29.99"
        style={{ width: '100%', height: 120, fontFamily: 'monospace', padding: 10, borderRadius: 6, border: '1px solid #ddd', marginBottom: 12 }}
      />
      <button className="send-btn" type="submit">Import CSV</button>
      {tmMessage && <div className={`form-message ${tmMessage.type}`}>{tmMessage.text}</div>}
    </form>
  </section>

  <section className="ledger-section" style={{ marginTop: 24 }}>
    <h2>Spending by merchant</h2>
    <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
      <div className="field" style={{ flex: 1, minWidth: 180 }}>
        <label htmlFor="analytics-month">Month</label>
        <input
          id="analytics-month"
          type="month"
          defaultValue={currentMonthValue()}
          onChange={async (e) => {
            const month = e.currentTarget.value;
            try {
              const res = await fetch(`${API_BASE}/analytics/spending?account_id=${activeAccountId}&month=${month}`);
              const data = await res.json();
              if (res.ok) {
                const total = data.total_spending;
                const html = data.by_merchant.length === 0
                  ? '<div class="empty-state">No spending this month.</div>'
                  : `<div style="display:flex;flex-direction:column;gap:12px;">${data.by_merchant.map((m: any) => `
                    <div style="padding:10px 14px;border:1px solid #e5e1d8;border-radius:8px;">
                      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                        <strong>${m.merchant}</strong>
                        <span>$${m.total.toFixed(2)} (${m.count}x)</span>
                      </div>
                      <div style="background:#eee;border-radius:4px;height:8px;">
                        <div style="width:${(m.total/total)*100}%;background:#2f7a4f;height:100%;"></div>
                      </div>
                    </div>
                  `).join('')}</div>`;
                document.getElementById('analytics-results')!.innerHTML = html;
              }
            } catch {
              document.getElementById('analytics-results')!.innerHTML = '<div class="empty-state">Could not load data.</div>';
            }
          }}
        />
      </div>
    </div>
    <div id="analytics-results" className="empty-state">Select a month to see data.</div>
  </section>
 {pendingUndo && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: '#222', color: '#fff', padding: '14px 20px', borderRadius: 10,
          display: 'flex', alignItems: 'center', gap: 16, zIndex: 1100,
          boxShadow: '0 4px 16px rgba(0,0,0,0.25)'
        }}>
          <span>Sent ${formatMoney(pendingUndo.amount)} — undoing in {pendingUndo.secondsLeft}s</span>
          <button
            type="button"
            onClick={() => handleUndoTransfer(pendingUndo.txId)}
            style={{
              background: '#fff', color: '#222', border: 'none', borderRadius: 6,
              padding: '6px 14px', fontWeight: 600, cursor: 'pointer'
            }}
          >
            Undo
          </button>
        </div>
      )}

 {pinPrompt && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <form
            onSubmit={submitPin}
            style={{ background: '#fff', padding: 24, borderRadius: 10, width: 280 }}
          >
            <h3 style={{ marginTop: 0 }}>Enter PIN</h3>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoFocus
              value={pinInput}
              onChange={e => setPinInput(e.target.value.replace(/\D/g, ''))}
              style={{ width: '100%', fontSize: '1.2rem', letterSpacing: 6, textAlign: 'center', padding: 10, marginBottom: 12 }}
            />
            {pinError && <div className="form-message error">{pinError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="send-btn" type="submit" disabled={pinChecking || pinInput.length !== 4} style={{ flex: 1 }}>
                {pinChecking ? 'Checking…' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => setPinPrompt(null)}
                style={{ flex: 1, background: '#eee', border: 'none', borderRadius: 6, cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}

export default App