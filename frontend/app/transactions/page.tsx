import TransactionManager from '@/components/transaction-manager';

export default function TransactionsPage() {
  return (
    <div>
      <div className="page-header">
        <div>
          <p className="eyebrow">Transaction History</p>
          <h2>Financial activity</h2>
          <p className="heading-subtitle">Edit source financial records or delete them with their linked stock and ledger entries.</p>
        </div>
      </div>
      <TransactionManager />
    </div>
  );
}
