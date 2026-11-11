'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '@/components/language';
import { useToastNotifications } from '@/components/notifications';

type Transaction = {
  id: number;
  description: string;
  amount: number;
  date: string;
  type: string;
};

type DashboardData = {
  totalBusinessCapital: number;
  inventoryInvestment: number;
  availableCash: number;
  netProfit: number;
  grossProfit: number;
  totalSales: number;
  costOfGoodsSold: number;
  totalExpenses: number;
  supplierPayments: number;
  outstandingSupplierBalance: number;
  productCount: number;
  lowStockProducts: number;
  monthlySales: Array<{ key: string; label: string; value: number }>;
  recentTransactions: Transaction[];
};

type FinancialReport = {
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

export default function DashboardPage() {
  const { language, t } = useLanguage();
  const [data, setData] = useState<DashboardData | null>(null);
  const [periodReport, setPeriodReport] = useState<FinancialReport | null>(null);
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [reportDate, setReportDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useToastNotifications('', error);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [dashboardResponse, reportResponse] = await Promise.all([
        fetch(`${API_URL}/api/dashboard`, { credentials: 'include', cache: 'no-store' }),
        fetch(`${API_URL}/api/reports?period=${period}&date=${reportDate}`, { credentials: 'include', cache: 'no-store' })
      ]);
      if (!dashboardResponse.ok || !reportResponse.ok) throw new Error(t('Could not load financial data.'));
      setData(await dashboardResponse.json());
      setPeriodReport(await reportResponse.json());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Could not load dashboard data.'));
    } finally {
      setLoading(false);
    }
  }, [period, reportDate, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const monthlySales = data?.monthlySales ?? [];

  const maxSales = Math.max(1, ...monthlySales.map((item) => item.value));

  const metrics = data
    ? [
        { label: t('Business capital'), value: formatMoney(data.totalBusinessCapital), note: t('Total contributed'), icon: 'CAP', color: 'mint' },
        { label: t('Inventory investment'), value: formatMoney(data.inventoryInvestment), note: `${data.productCount} ${t('products in stock')}`, icon: 'INV', color: 'blue' },
        { label: t('Available cash'), value: formatMoney(data.availableCash), note: t('Current cash position'), icon: 'CASH', color: 'amber' },
        { label: t('Net profit'), value: formatMoney(data.netProfit), note: t('Sales less costs and expenses'), icon: 'NET', color: 'violet' },
        { label: t('Total sales'), value: formatMoney(data.totalSales), note: t('Recorded sales'), icon: 'SALE', color: 'blue' }
      ]
    : [];

  return (
    <div className="dashboard-page">
      <header className="dashboard-heading">
        <div>
          <p className="eyebrow">{t('Twin Treasure · Business overview')}</p>
          <h2>{t('Inventory & Finance Dashboard')}</h2>
          <p className="heading-subtitle">{t('A live view of your shop’s stock and financial health.')}</p>
        </div>
        <div className="heading-actions">
          <span className="live-status"><span /> {t('Live overview')}</span>
          <button className="outline-button" type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? t('Updating…') : t('↻ Refresh')}
          </button>
          <Link className="primary-button" href="/investments">{t('＋ Record purchase')}</Link>
        </div>
      </header>

      {error && <div className="error-banner" role="alert">{error} {t('Make sure the Express backend is running on port 5000.')}</div>}

      {periodReport && (
        <section className="profit-loss-section" aria-label={t('Period profit and loss')}>
          <div className="period-heading">
            <div>
              <p className="panel-kicker">{t('Period performance')}</p>
              <h3>{t('Income, expenses & profit')}</h3>
              <span>{formatDateRange(periodReport.startDate, periodReport.endDate, language)}</span>
            </div>
            <div className="period-controls">
              <select aria-label={t('Dashboard reporting period')} value={period} onChange={(event) => setPeriod(event.target.value as 'daily' | 'weekly' | 'monthly')}>
                <option value="daily">{t('Daily')}</option>
                <option value="weekly">{t('Weekly')}</option>
                <option value="monthly">{t('Monthly')}</option>
              </select>
              <input aria-label={t('Dashboard report date')} type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
            </div>
          </div>
          <div className="profit-loss-grid">
            <PeriodMetric label={t('Total investment')} value={periodReport.totalInvestment} />
            <PeriodMetric label={t('Sales revenue')} value={periodReport.totalSalesRevenue} />
            <PeriodMetric label={t('Total expenses')} value={periodReport.totalExpenses} />
            <PeriodMetric label={t('Cost of products sold')} value={periodReport.costOfProductsSold} />
            <PeriodMetric label={t('Gross profit')} value={periodReport.grossProfit} profit />
            <PeriodMetric label={t('Net profit / loss')} value={periodReport.netProfit} profit />
            <PeriodMetric label={t('Closing cash balance')} value={periodReport.closingCashBalance} />
          </div>
          {periodReport.otherIncome > 0 && <p className="other-income-note">{t('Other income in this period:')} {formatMoney(periodReport.otherIncome)} {t('(included in net profit).')}</p>}
        </section>
      )}

      <section className="dashboard-metrics" aria-label={t('Business metrics')}>
        {metrics.map((metric) => (
          <article className={`dashboard-metric ${metric.color}`} key={metric.label}>
            <div className="metric-top">
              <span className="metric-icon">{metric.icon}</span>
              <span className="metric-label">{metric.label}</span>
            </div>
            <strong>{metric.value}</strong>
            <small>{metric.note}</small>
          </article>
        ))}
      </section>

      {data && (
        <>
          <section className="quick-stats" aria-label={t('Additional business indicators')}>
            <div><span>{t('Cost of products sold')}</span><strong>{formatMoney(data.costOfGoodsSold)}</strong></div>
            <div><span>{t('Operating expenses')}</span><strong>{formatMoney(data.totalExpenses)}</strong></div>
            <div><span>{t('Supplier payments')}</span><strong>{formatMoney(data.supplierPayments)}</strong></div>
            <div><span>{t('Supplier balance')}</span><strong>{formatMoney(data.outstandingSupplierBalance)}</strong></div>
            <div><span>{t('Products')}</span><strong>{data.productCount}</strong></div>
            <div><span>{t('Low-stock products')}</span><strong className={data.lowStockProducts ? 'text-warning' : ''}>{data.lowStockProducts}</strong></div>
          </section>

          <section className="dashboard-content-grid">
            <article className="dashboard-panel chart-panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">{t('Sales activity')}</p>
                  <h3>{t('Sales by month')}</h3>
                </div>
                <Link href="/reports" className="panel-link">{t('View reports')} <span>→</span></Link>
              </div>
              <div className="sales-chart" role="img" aria-label={t('Recorded sales for the last six months')}>
                <div className="chart-grid">
                  {[0, 1, 2, 3].map((line) => <span key={line} />)}
                </div>
                <div className="chart-bars">
                  {monthlySales.map((month) => (
                    <div className="chart-column" key={month.key} title={`${month.label}: ${formatMoney(month.value)}`}>
                      <span className="chart-value">{month.value ? compactMoney(month.value) : ''}</span>
                      <div className="chart-bar" style={{ height: `${Math.max(4, (month.value / maxSales) * 100)}%` }} />
                      <small>{month.label}</small>
                    </div>
                  ))}
                </div>
              </div>
              <div className="chart-legend"><span /> {t('Sales received')}</div>
            </article>

            <article className="dashboard-panel activity-panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">{t('Latest updates')}</p>
                  <h3>{t('Recent transactions')}</h3>
                </div>
                <Link href="/transactions" className="panel-link">{t('See all')} <span>→</span></Link>
              </div>
              {data.recentTransactions.length ? (
                <div className="activity-list">
                  {data.recentTransactions.slice(0, 5).map((transaction) => (
                    <div className="activity-row" key={transaction.id}>
                      <span className={`activity-icon ${transaction.amount < 0 ? 'outflow' : 'inflow'}`}>
                        {transaction.amount < 0 ? '−' : '+'}
                      </span>
                      <div className="activity-description">
                        <strong>{transaction.description}</strong>
                        <small>{transaction.date} · {t(transaction.type.replace('_', ' '))}</small>
                      </div>
                      <strong className={transaction.amount < 0 ? 'amount-out' : 'amount-in'}>
                        {formatMoney(transaction.amount)}
                      </strong>
                    </div>
                  ))}
                </div>
              ) : <p className="empty-state">{t('No transactions recorded yet.')}</p>}
            </article>
          </section>

          <section className="dashboard-footer-panels">
            <article className="dashboard-panel">
              <p className="panel-kicker">{t('Stock health')}</p>
              <h3>{data.lowStockProducts ? `${data.lowStockProducts} ${t(data.lowStockProducts === 1 ? 'item needs attention' : 'items need attention')}` : t('Stock levels look good')}</h3>
              <p className="panel-description">{t('Track available quantities and restock from Product Management.')}</p>
              <Link href="/products" className="panel-link">{t('Manage products')} <span>→</span></Link>
            </article>
            <article className="dashboard-panel">
              <p className="panel-kicker">{t('Cash & capital')}</p>
              <h3>{formatMoney(data.availableCash)} {t('available')}</h3>
              <p className="panel-description">{t('Record new capital, income, expenses, or withdrawals.')}</p>
              <Link href="/money" className="panel-link">{t('Open money management')} <span>→</span></Link>
            </article>
          </section>
        </>
      )}
    </div>
  );
}

function formatMoney(value: number) {
  return `${value < 0 ? '−' : ''}RWF ${Math.abs(value).toLocaleString()}`;
}

function compactMoney(value: number) {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}

function PeriodMetric({ label, value, profit = false }: { label: string; value: number; profit?: boolean }) {
  const { t } = useLanguage();
  const isLoss = profit && value < 0;
  const displayLabel = isLoss
    ? label === t('Gross profit') ? t('Gross loss') : t('Net loss')
    : label;
  return (
    <div className="period-metric">
      <span>{displayLabel}</span>
      <strong className={profit ? value < 0 ? 'amount-out' : 'amount-in' : ''}>{formatMoney(value)}</strong>
    </div>
  );
}

function formatDateRange(startDate: string, endDate: string, language: 'en' | 'rw') {
  const formatDate = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString(language === 'rw' ? 'rw-RW' : 'en', { month: 'short', day: 'numeric', year: 'numeric' });
  return startDate === endDate ? formatDate(startDate) : `${formatDate(startDate)} – ${formatDate(endDate)}`;
}
