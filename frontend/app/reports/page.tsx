'use client';

import { useEffect, useState } from 'react';

type Report = {
  period: 'daily' | 'weekly' | 'monthly';
  startDate: string;
  endDate: string;
  totalInvestment: number;
  totalSalesRevenue: number;
  totalExpenses: number;
  costOfProductsSold: number;
  otherIncome: number;
  grossProfit: number;
  netProfit: number;
  closingCashBalance: number;
  transactionCount: number;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';

export default function ReportsPage() {
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch(`${API_URL}/api/reports?period=${period}&date=${selectedDate}`, { signal: controller.signal, cache: 'no-store', credentials: 'include' })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Unable to load financial report.');
        return result as Report;
      })
      .then(setReport)
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name === 'AbortError') return;
        setError(requestError instanceof Error ? requestError.message : 'Unable to load financial report.');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [period, selectedDate]);

  const metrics = report ? [
    { label: 'Total money invested', value: report.totalInvestment },
    { label: 'Total sales revenue', value: report.totalSalesRevenue },
    { label: 'Total expenses', value: report.totalExpenses },
    { label: 'Cost of products sold', value: report.costOfProductsSold },
    { label: report.grossProfit < 0 ? 'Gross loss' : 'Gross profit', value: report.grossProfit, profit: true },
    { label: report.netProfit < 0 ? 'Net loss' : 'Net profit', value: report.netProfit, profit: true },
    { label: 'Closing cash balance', value: report.closingCashBalance }
  ] : [];

  return (
    <div>
      <div className="page-header report-page-header">
        <div>
          <p className="eyebrow">Daily, Weekly and Monthly Reports</p>
          <h2>Profit &amp; loss report</h2>
          <p className="heading-subtitle">Revenue, inventory cost, operating expenses, and closing cash for your chosen period.</p>
        </div>
        <div className="period-controls report-controls">
          <label>
            <span>Period</span>
            <select aria-label="Report period" value={period} onChange={(event) => setPeriod(event.target.value as 'daily' | 'weekly' | 'monthly')}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label>
            <span>Choose date</span>
            <input aria-label="Choose report date" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
          </label>
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {loading && <p className="report-loading">Calculating report…</p>}
      {report && (
        <>
          <div className="report-range">
            <strong>{period[0].toUpperCase() + period.slice(1)} summary</strong>
            <span>{formatDateRange(report.startDate, report.endDate)}</span>
            <small>{report.transactionCount} recorded transactions</small>
          </div>
          <div className="report-metrics-grid">
            {metrics.map((metric) => (
              <article className={`report-metric${metric.profit ? ' emphasized' : ''}`} key={metric.label}>
                <span>{metric.label}</span>
                <strong className={metric.profit ? metric.value < 0 ? 'amount-out' : 'amount-in' : ''}>{formatMoney(metric.value)}</strong>
              </article>
            ))}
          </div>
          <div className="card report-note">
            <h3>How profit is calculated</h3>
            <p><strong>Gross profit</strong> = sales revenue − cost of products sold.</p>
            <p><strong>Net profit / loss</strong> = gross profit − operating expenses.</p>
            <p>Supplier payments and inventory purchases reduce cash but are not counted as operating expenses; product cost is counted when the item sells.</p>
            {report.otherIncome > 0 && <p>Other recorded income this period: <strong>{formatMoney(report.otherIncome)}</strong>.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function formatMoney(value: number) {
  return `${value < 0 ? '−' : ''}RWF ${Math.abs(Number(value)).toLocaleString()}`;
}

function formatDateRange(startDate: string, endDate: string) {
  const formatDate = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
  return startDate === endDate ? formatDate(startDate) : `${formatDate(startDate)} – ${formatDate(endDate)}`;
}
