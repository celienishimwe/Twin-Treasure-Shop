'use client';

import { FormEvent, useEffect, useState } from 'react';
import TransactionManager from '@/components/transaction-manager';
import { useLanguage } from '@/components/language';
import { useToastNotifications } from '@/components/notifications';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';
type Supplier = { id: number; name: string };
const defaultForm = {
  amount: '',
  type: 'Initial capital',
  adjustmentDirection: 'increase',
  date: new Date().toISOString().slice(0, 10),
  description: '',
  supplierId: ''
};

export default function MoneyPage() {
  const { t } = useLanguage();
  const [form, setForm] = useState(defaultForm);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useToastNotifications(message, error);

  useEffect(() => {
    fetch(`${API_URL}/api/suppliers`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(t('Unable to load suppliers.'));
        return response.json();
      })
      .then((items: Supplier[]) => setSuppliers(items))
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : t('Unable to load suppliers.')));
  }, [t]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    setSaving(true);
    const type = form.type === 'Record expenses' ? 'expense'
      : form.type === 'Record withdrawals' ? 'withdrawal'
        : form.type === 'Pay supplier' ? 'supplier_payment'
          : form.type === 'Record adjustment' ? 'adjustment'
        : form.type === 'Record income' ? 'income' : 'investment';
    const amount = type === 'adjustment'
      ? form.adjustmentDirection === 'decrease' ? -Math.abs(Number(form.amount)) : Math.abs(Number(form.amount))
      : ['expense', 'withdrawal', 'supplier_payment'].includes(type) ? -Math.abs(Number(form.amount)) : Math.abs(Number(form.amount));
    try {
      const response = await fetch(`${API_URL}/api/transactions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          type,
          category: form.type,
          date: form.date,
          description: form.description,
          supplierId: type === 'supplier_payment' ? Number(form.supplierId) : undefined
        })
      });
      if (!response.ok) throw new Error(t('The transaction could not be saved.'));
      setForm({ ...defaultForm, amount: '', description: '' });
      setMessage(t('Transaction saved successfully.'));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('The transaction could not be saved.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <p className="eyebrow">{t('Money Management')}</p>
          <h2>{t('Add business investment')}</h2>
        </div>
      </div>

      <div className="card form-card">
        {error && <div className="error-banner" role="alert">{error}</div>}
        {message && <p className="success-message" role="status">{message}</p>}
        <form onSubmit={handleSubmit} className="form-grid">
          <label>
            <span>{t('Transaction amount (RWF)')}</span>
            <input type="number" min="1" required value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
          </label>

          <label>
            <span>{t('Investment type')}</span>
            <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              <option value="Initial capital">{t('Initial capital')}</option>
              <option value="Additional investment">{t('Additional investment')}</option>
              <option value="Record income">{t('Record income')}</option>
              <option value="Record expenses">{t('Record expenses')}</option>
              <option value="Record withdrawals">{t('Record withdrawals')}</option>
              <option value="Pay supplier">{t('Pay supplier')}</option>
              <option value="Record adjustment">{t('Record adjustment')}</option>
            </select>
          </label>

          {form.type === 'Pay supplier' && (
            <label>
              <span>{t('Supplier')}</span>
              <select required value={form.supplierId} onChange={(event) => setForm({ ...form, supplierId: event.target.value })}>
                <option value="">{t('Select a supplier')}</option>
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </label>
          )}

          {form.type === 'Record adjustment' && (
            <label>
              <span>{t('Adjustment direction')}</span>
              <select value={form.adjustmentDirection} onChange={(event) => setForm({ ...form, adjustmentDirection: event.target.value })}>
                <option value="increase">{t('Increase available cash')}</option>
                <option value="decrease">{t('Decrease available cash')}</option>
              </select>
            </label>
          )}

          <label>
            <span>{t('Investment date')}</span>
            <input type="date" required value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
          </label>

          <label className="full-width">
            <span>{t('Description')}</span>
            <textarea rows={3} required value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </label>

          <button className="primary-button" type="submit" disabled={saving}>{saving ? t('Saving…') : t('Save transaction')}</button>
        </form>
      </div>
      <section className="management-section">
        <div className="page-header"><div><p className="eyebrow">{t('Manage records')}</p><h2>{t('Capital, expenses and payments')}</h2></div></div>
        <TransactionManager financialOnly />
      </section>
    </div>
  );
}
