'use client';

import TransactionManager from '@/components/transaction-manager';
import { useLanguage } from '@/components/language';

export default function TransactionsPage() {
  const { t } = useLanguage();
  return (
    <div>
      <div className="page-header">
        <div>
          <p className="eyebrow">{t('Transaction History')}</p>
          <h2>{t('Financial activity')}</h2>
          <p className="heading-subtitle">{t('Edit source financial records or delete them with their linked stock and ledger entries.')}</p>
        </div>
      </div>
      <TransactionManager />
    </div>
  );
}
