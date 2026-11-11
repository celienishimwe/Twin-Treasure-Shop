'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '@/components/language';
import { useToastNotifications } from '@/components/notifications';

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
  const { language, t } = useLanguage();
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useToastNotifications('', error);

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
    { label: t('Total money invested'), value: report.totalInvestment },
    { label: t('Total sales revenue'), value: report.totalSalesRevenue },
    { label: t('Total expenses'), value: report.totalExpenses },
    { label: t('Cost of products sold'), value: report.costOfProductsSold },
    { label: t(report.grossProfit < 0 ? 'Gross loss' : 'Gross profit'), value: report.grossProfit, profit: true },
    { label: t(report.netProfit < 0 ? 'Net loss' : 'Net profit'), value: report.netProfit, profit: true },
    { label: t('Closing cash balance'), value: report.closingCashBalance }
  ] : [];

  return (
    <div>
      <div className="page-header report-page-header">
        <div>
          <p className="eyebrow">{t('Daily, Weekly and Monthly Reports')}</p>
          <h2>{t('Profit & loss report')}</h2>
          <p className="heading-subtitle">{t('Revenue, inventory cost, operating expenses, and closing cash for your chosen period.')}</p>
        </div>
        <div className="period-controls report-controls">
          <label>
            <span>{t('Period')}</span>
            <select aria-label="Report period" value={period} onChange={(event) => setPeriod(event.target.value as 'daily' | 'weekly' | 'monthly')}>
              <option value="daily">{t('Daily')}</option>
              <option value="weekly">{t('Weekly')}</option>
              <option value="monthly">{t('Monthly')}</option>
            </select>
          </label>
          <label>
            <span>{t('Choose date')}</span>
            <input aria-label="Choose report date" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
          </label>
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {loading && <p className="report-loading">{t('Calculating report…')}</p>}
      {report && (
        <>
          <div className="report-range">
            <strong>{t(period === 'daily' ? 'Daily' : period === 'weekly' ? 'Weekly' : 'Monthly')} {t('summary')}</strong>
            <span>{formatDateRange(report.startDate, report.endDate, language)}</span>
            <small>{report.transactionCount} {t('recorded transactions')}</small>
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
            <h3>{t('How profit is calculated')}</h3>
            <p><strong>{t('Gross profit')}</strong> = {t('sales revenue − cost of products sold.')}</p>
            <p><strong>{t('Net profit / loss')}</strong> = {t('gross profit − operating expenses.')}</p>
            <p>{t('Supplier payments and inventory purchases reduce cash but are not counted as operating expenses; product cost is counted when the item sells.')}</p>
            {report.otherIncome > 0 && <p>{t('Other recorded income this period:')} <strong>{formatMoney(report.otherIncome)}</strong>.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function formatMoney(value: number) {
  return `${value < 0 ? '−' : ''}RWF ${Math.abs(Number(value)).toLocaleString()}`;
}

function formatDateRange(startDate: string, endDate: string, language: 'en' | 'rw') {
  const formatDate = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString(language === 'rw' ? 'rw-RW' : 'en', { month: 'short', day: 'numeric', year: 'numeric' });
  return startDate === endDate ? formatDate(startDate) : `${formatDate(startDate)} – ${formatDate(endDate)}`;
}
