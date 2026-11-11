'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useLanguage } from '@/components/language';
import { useToastNotifications } from '@/components/notifications';

type Transaction = {
  id: number;
  type: string;
  amount: number;
  description: string;
  date: string;
  category?: string;
  eventType: string;
  supplierId: number | null;
};

type Supplier = { id: number; name: string };
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';

export default function TransactionManager({ financialOnly = false }: { financialOnly?: boolean }) {
  const { t } = useLanguage();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useToastNotifications(message, error);

  const refresh = useCallback(async () => {
    const response = await fetch(`${API_URL}/api/transactions`, { credentials: 'include' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? t('Unable to load transactions.'));
    setTransactions(result);
  }, [t]);

  useEffect(() => {
    refresh().catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : t('Unable to load transactions.')));
    fetch(`${API_URL}/api/suppliers`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(t('Unable to load suppliers.'));
        return response.json();
      })
      .then((items: Supplier[]) => setSuppliers(items))
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : t('Unable to load suppliers.')));
  }, [refresh, t]);

  const visibleTransactions = financialOnly
    ? transactions.filter((item) => ['capital_contribution', 'owner_withdrawal', 'cash_adjustment', 'operating_expense', 'supplier_payment'].includes(item.eventType))
    : transactions;

  function beginEdit(transaction: Transaction) {
    setEditing(transaction);
    setAmount(String(Math.abs(transaction.amount)));
    setDate(String(transaction.date).slice(0, 10));
    setDescription(transaction.description);
    setCategory(transaction.category ?? '');
    setSupplierId(String(transaction.supplierId ?? ''));
    setError('');
    setMessage('');
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/transactions/${editing.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: Number(amount),
          date,
          description,
          category,
          supplierId: editing.eventType === 'supplier_payment' ? Number(supplierId) : undefined
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t('Transaction could not be updated.'));
      setEditing(null);
      setMessage(t('Transaction updated.'));
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Transaction could not be updated.'));
    }
  }

  async function deleteTransaction(transaction: Transaction) {
    if (!window.confirm(`${t('Permanently delete this')} ${transaction.type.replace('_', ' ')} ${t('record? Related stock and ledger data will also be adjusted.')}`)) return;
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/transactions/${transaction.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(result?.error ?? t('Transaction could not be deleted.'));
      if (editing?.id === transaction.id) setEditing(null);
      setMessage(t('Transaction deleted.'));
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Transaction could not be deleted.'));
    }
  }

  const editableTypes = ['capital_contribution', 'owner_withdrawal', 'cash_adjustment', 'operating_expense', 'supplier_payment'];

  return (
    <div className="card transaction-manager">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {message && <p className="success-message" role="status">{message}</p>}
      {editing && (
        <form className="form-grid transaction-edit-form" onSubmit={saveEdit}>
          <label><span>{t('Amount (RWF)')}</span><input type="number" min="0.01" step="0.01" required value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
          <label><span>{t('Date')}</span><input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></label>
          {editing.eventType === 'supplier_payment' && (
            <label><span>{t('Supplier')}</span><select required value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">{t('Select a supplier')}</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select></label>
          )}
          {editing.eventType === 'operating_expense' && (
            <label><span>{t('Expense category')}</span><input required value={category} onChange={(event) => setCategory(event.target.value)} /></label>
          )}
          <label className="full-width"><span>{t('Description')}</span><input required value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <div className="row-actions full-width">
            <button type="submit" className="primary-button">{t('Save changes')}</button>
            <button type="button" className="outline-button" onClick={() => setEditing(null)}>{t('Cancel')}</button>
          </div>
        </form>
      )}
      <div className="table-header transaction-table-header">
        <span>{t('Type')}</span><span>{t('Description')}</span><span>{t('Date')}</span><span>{t('Amount')}</span><span>{t('Actions')}</span>
      </div>
      {visibleTransactions.map((transaction) => (
        <div key={transaction.id} className="table-row transaction-table-row">
          <span>{t(transaction.category || transaction.type.replaceAll('_', ' '))}</span>
          <span>{transaction.description}</span>
          <span>{String(transaction.date).slice(0, 10)}</span>
          <span className={transaction.amount < 0 ? 'negative' : 'positive'}>{formatMoney(transaction.amount)}</span>
          <span className="row-actions">
            {editableTypes.includes(transaction.eventType) && <button className="outline-button" type="button" onClick={() => beginEdit(transaction)}>{t('Edit')}</button>}
            <button className="danger-button" type="button" onClick={() => void deleteTransaction(transaction)}>{t('Delete')}</button>
          </span>
        </div>
      ))}
      {!visibleTransactions.length && <p className="empty-state">{t('No transactions recorded yet.')}</p>}
    </div>
  );
}

function formatMoney(value: number) {
  return `${value >= 0 ? '+' : '−'} RWF ${Math.abs(value).toLocaleString()}`;
}
