'use client';

import { useEffect, useState } from 'react';

type Transaction = {
  id: number;
  type: string;
  amount: number;
  description: string;
  date: string;
  category?: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/api/transactions`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load transaction history.');
        return response.json();
      })
      .then(setTransactions)
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : 'Unable to load transaction history.'));
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <p className="eyebrow">Transaction History</p>
          <h2>Recent financial activity</h2>
        </div>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="card">
        <div className="table-header">
          <span>Type</span><span>Description</span><span>Date</span><span>Amount</span>
        </div>
        {transactions.map((transaction) => (
          <div key={transaction.id} className="table-row">
            <span>{transaction.category || transaction.type.replace('_', ' ')}</span>
            <span>{transaction.description}</span>
            <span>{String(transaction.date).slice(0, 10)}</span>
            <span className={transaction.amount < 0 ? 'negative' : 'positive'}>{formatMoney(transaction.amount)}</span>
          </div>
        ))}
        {!error && transactions.length === 0 && <p className="empty-state">No transactions recorded yet.</p>}
      </div>
    </div>
  );
}

function formatMoney(value: number) {
  return `${value >= 0 ? '+' : '−'} RWF ${Math.abs(value).toLocaleString()}`;
}
