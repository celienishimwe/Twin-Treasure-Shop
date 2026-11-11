'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useLanguage } from '@/components/language';
import { useToastNotifications } from '@/components/notifications';

type Product = { id: number; name: string; buyingPrice: number; availableQuantity: number };
type Purchase = { id: number; date: string; supplier: string; productId: number; product: string; quantity: number; buyingPrice: number; totalAmount: number; paidAmount: number };
type Supplier = { id: number; name: string };
type SupplierReturn = { id: number; transactionId: number; supplierId: number; supplier: string; productId: number; product: string; quantity: number; unitCost: number; amount: number; settlementType: string; date: string };
type StockAdjustment = { id: number; productId: number; product: string; quantityDelta: number; unitCost: number; date: string };
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';

export default function ProductInvestmentsPage() {
  const { t } = useLanguage();
  const [products, setProducts] = useState<Product[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [returns, setReturns] = useState<SupplierReturn[]>([]);
  const [adjustments, setAdjustments] = useState<StockAdjustment[]>([]);
  const [productId, setProductId] = useState('');
  const [editingPurchaseId, setEditingPurchaseId] = useState<number | null>(null);
  const [supplier, setSupplier] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [buyingPrice, setBuyingPrice] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('Paid');
  const [paidAmount, setPaidAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useToastNotifications(message, error);
  const [saving, setSaving] = useState(false);
  const [supplierForm, setSupplierForm] = useState({ id: 0, name: '' });
  const [returnId, setReturnId] = useState<number | null>(null);
  const [returnForm, setReturnForm] = useState({
    supplierId: '',
    productId: '',
    quantity: '1',
    unitCost: '',
    amount: '',
    settlementType: 'supplier_credit',
    date: new Date().toISOString().slice(0, 10)
  });
  const [adjustmentId, setAdjustmentId] = useState<number | null>(null);
  const [adjustmentForm, setAdjustmentForm] = useState({ productId: '', quantityDelta: '', unitCost: '' });

  async function refreshProducts() {
    const response = await fetch(`${API_URL}/api/products`, { credentials: 'include' });
    const items = await response.json();
    if (!response.ok) throw new Error(items.error ?? t('Unable to load products.'));
    setProducts(items);
  }

  async function refreshPurchases() {
    const response = await fetch(`${API_URL}/api/product-purchases`, { credentials: 'include' });
    const items = await response.json();
    if (!response.ok) throw new Error(items.error ?? t('Unable to load purchases.'));
    setPurchases(items);
  }

  async function refreshSuppliers() {
    const response = await fetch(`${API_URL}/api/suppliers`, { credentials: 'include' });
    const items = await response.json();
    if (!response.ok) throw new Error(items.error ?? t('Unable to load suppliers.'));
    setSuppliers(items);
  }

  async function refreshReturns() {
    const response = await fetch(`${API_URL}/api/supplier-returns`, { credentials: 'include' });
    const items = await response.json();
    if (!response.ok) throw new Error(items.error ?? t('Unable to load supplier returns.'));
    setReturns(items);
  }

  async function refreshAdjustments() {
    const response = await fetch(`${API_URL}/api/stock-movements`, { credentials: 'include' });
    const items: Array<StockAdjustment & { movementType: string }> = await response.json();
    if (!response.ok) throw new Error(t('Unable to load stock movements.'));
    setAdjustments(items.filter((item) => item.movementType === 'adjustment'));
  }

  useEffect(() => {
    fetch(`${API_URL}/api/products`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(t('Unable to load products.'));
        return response.json();
      })
      .then((items: Product[]) => {
        setProducts(items);
        if (items.length) {
          setProductId(String(items[0].id));
          setBuyingPrice(items[0].buyingPrice > 0 ? String(items[0].buyingPrice) : '');
        }
      })
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : t('Unable to load products.')));
    refreshPurchases().catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : t('Unable to load purchases.')));
    refreshSuppliers().catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : t('Unable to load suppliers.')));
    refreshReturns().catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : t('Unable to load supplier returns.')));
    refreshAdjustments().catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : t('Unable to load stock adjustments.')));
  }, []);

  const selectedProduct = products.find((product) => String(product.id) === productId);
  const totalInvestment = useMemo(() => Number(quantity || 0) * Number(buyingPrice || 0), [quantity, buyingPrice]);

  function selectProduct(value: string) {
    setProductId(value);
    const product = products.find((item) => String(item.id) === value);
    if (product) setBuyingPrice(product.buyingPrice > 0 ? String(product.buyingPrice) : '');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    setSaving(true);
    try {
      const response = await fetch(`${API_URL}/api/product-purchases${editingPurchaseId ? `/${editingPurchaseId}` : ''}`, {
        method: editingPurchaseId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: Number(quantity),
          buyingPrice: Number(buyingPrice),
          ...(editingPurchaseId ? {} : {
            productId: Number(productId),
            productName: selectedProduct?.name,
            supplier,
            totalInvestment,
            paymentStatus,
            paidAmount: paymentStatus === 'Paid' ? totalInvestment : paymentStatus === 'Pending' ? 0 : Number(paidAmount)
          }),
          date
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t('The purchase could not be saved.'));
      setMessage(editingPurchaseId ? t('Purchase updated and stock recalculated.') : t('Purchase saved and stock updated.'));
      setQuantity('1');
      setEditingPurchaseId(null);
      await refreshPurchases();
      await refreshSuppliers();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('The purchase could not be saved.'));
    } finally {
      setSaving(false);
    }
  }

  function editPurchase(purchase: Purchase) {
    setEditingPurchaseId(purchase.id);
    setProductId(String(purchase.productId));
    setSupplier(purchase.supplier);
    setQuantity(String(purchase.quantity));
    setBuyingPrice(String(purchase.buyingPrice));
    setDate(purchase.date);
  }

  async function deletePurchase(purchase: Purchase) {
    if (!window.confirm(`${t('Permanently delete purchase')} #${purchase.id}? ${t('Linked payments remain recorded. Purchases tied to later sales cannot be deleted.')}`)) return;
    try {
      const response = await fetch(`${API_URL}/api/product-purchases/${purchase.id}`, { method: 'DELETE', credentials: 'include' });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(result?.error ?? t('Purchase could not be deleted.'));
      setMessage(t('Purchase deleted and stock recalculated.'));
      await refreshPurchases();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Purchase could not be deleted.'));
    }
  }

  async function saveSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/suppliers${supplierForm.id ? `/${supplierForm.id}` : ''}`, {
        method: supplierForm.id ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: supplierForm.name })
      });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(result?.error ?? t('Supplier could not be saved.'));
      setSupplierForm({ id: 0, name: '' });
      setMessage(supplierForm.id ? t('Supplier updated.') : t('Supplier created.'));
      await refreshSuppliers();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Supplier could not be saved.'));
    }
  }

  async function deleteSupplier(item: Supplier) {
    if (!window.confirm(`${t('Permanently delete supplier')} "${item.name}"? ${t('Suppliers with purchase or payment history cannot be deleted.')}`)) return;
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/suppliers/${item.id}`, { method: 'DELETE', credentials: 'include' });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(result?.error ?? t('Supplier could not be deleted.'));
      setMessage(t('Supplier deleted.'));
      await refreshSuppliers();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Supplier could not be deleted.'));
    }
  }

  async function saveReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/supplier-returns${returnId ? `/${returnId}` : ''}`, {
        method: returnId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: Number(returnForm.supplierId),
          productId: Number(returnForm.productId),
          quantity: Number(returnForm.quantity),
          unitCost: Number(returnForm.unitCost),
          amount: Number(returnForm.amount || Number(returnForm.quantity) * Number(returnForm.unitCost)),
          settlementType: returnForm.settlementType,
          date: returnForm.date
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t('Supplier return could not be saved.'));
      setReturnId(null);
      setReturnForm({ ...returnForm, quantity: '1', amount: '' });
      setMessage(returnId ? t('Supplier return updated.') : t('Supplier return recorded.'));
      await refreshReturns();
      await refreshProducts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Supplier return could not be saved.'));
    }
  }

  function editReturn(item: SupplierReturn) {
    setReturnId(item.id);
    setReturnForm({
      supplierId: String(item.supplierId),
      productId: String(item.productId),
      quantity: String(item.quantity),
      unitCost: String(item.unitCost),
      amount: String(item.amount),
      settlementType: item.settlementType,
      date: item.date
    });
  }

  async function deleteReturn(item: SupplierReturn) {
    if (!window.confirm(`${t('Permanently delete this return of')} ${item.quantity} ${item.product}? ${t('Stock and cash history will be restored.')}`)) return;
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/transactions/${item.transactionId}`, { method: 'DELETE', credentials: 'include' });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(result?.error ?? t('Supplier return could not be deleted.'));
      setMessage(t('Supplier return deleted.'));
      await refreshReturns();
      await refreshProducts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Supplier return could not be deleted.'));
    }
  }

  async function saveAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/stock-adjustments${adjustmentId ? `/${adjustmentId}` : ''}`, {
        method: adjustmentId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: Number(adjustmentForm.productId),
          quantityDelta: Number(adjustmentForm.quantityDelta),
          unitCost: Number(adjustmentForm.unitCost || 0)
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t('Stock adjustment could not be saved.'));
      setAdjustmentId(null);
      setAdjustmentForm({ ...adjustmentForm, quantityDelta: '', unitCost: '' });
      setMessage(adjustmentId ? t('Stock adjustment updated.') : t('Stock adjusted.'));
      await refreshAdjustments();
      await refreshProducts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Stock adjustment could not be saved.'));
    }
  }

  function editAdjustment(item: StockAdjustment) {
    setAdjustmentId(item.id);
    setAdjustmentForm({
      productId: String(item.productId),
      quantityDelta: String(item.quantityDelta),
      unitCost: String(item.unitCost)
    });
  }

  async function deleteAdjustment(item: StockAdjustment) {
    if (!window.confirm(`${t('Delete this stock')} ${t(item.quantityDelta > 0 ? 'increase' : 'decrease')} (${Math.abs(item.quantityDelta)}) ${item.product}? ${t('Stock will be restored.')}`)) return;
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/stock-adjustments/${item.id}`, { method: 'DELETE', credentials: 'include' });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(result?.error ?? t('Stock adjustment could not be deleted.'));
      setMessage(t('Stock adjustment deleted.'));
      await refreshAdjustments();
      await refreshProducts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('Stock adjustment could not be deleted.'));
    }
  }

  return (
    <div>
      <div className="page-header">
        <div><p className="eyebrow">{t('Product Investment')}</p><h2>{t(editingPurchaseId ? 'Edit product purchase' : 'Record product purchase')}</h2></div>
      </div>
      <div className="card form-card">
        {error && <div className="error-banner" role="alert">{error}</div>}
        {message && <p className="success-message" role="status">{message}</p>}
        {!products.length && !error && <p className="empty-state">{t('Add a product in Product Management before recording a purchase.')}</p>}
        <form onSubmit={handleSubmit} className="form-grid">
          {!editingPurchaseId && <label>
            <span>{t('Product')}</span>
            <select required value={productId} onChange={(event) => selectProduct(event.target.value)}>
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </label>}
          {!editingPurchaseId && <label><span>{t('Supplier')}</span><input required list="supplier-options" value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder={t('Supplier name')} /><datalist id="supplier-options">{suppliers.map((item) => <option key={item.id} value={item.name} />)}</datalist></label>}
          <label><span>{t('Quantity')}</span><input type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <label><span>{t('Buying price per item (RWF)')}</span><input type="number" min="1" step="0.01" required value={buyingPrice} onChange={(event) => setBuyingPrice(event.target.value)} /></label>
          <label><span>{t('Total product investment (RWF)')}</span><input readOnly value={totalInvestment} /></label>
          {!editingPurchaseId && <label>
            <span>{t('Payment status')}</span>
            <select value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)}>
              <option value="Paid">{t('Paid')}</option><option value="Partial">{t('Partial')}</option><option value="Pending">{t('Pending')}</option>
            </select>
          </label>}
          {!editingPurchaseId && paymentStatus === 'Partial' && (
            <label>
              <span>{t('Amount paid now (RWF)')}</span>
              <input type="number" min="1" max={totalInvestment - 1} required value={paidAmount} onChange={(event) => setPaidAmount(event.target.value)} />
            </label>
          )}
          <label><span>{t('Purchase date')}</span><input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <div className="row-actions">
            <button className="primary-button" type="submit" disabled={saving || !products.length}>{saving ? t('Saving…') : editingPurchaseId ? t('Save changes') : t('Save purchase')}</button>
            {editingPurchaseId && <button className="outline-button" type="button" onClick={() => setEditingPurchaseId(null)}>{t('Cancel')}</button>}
          </div>
        </form>
      </div>
      <section className="management-section">
        <div className="page-header"><div><p className="eyebrow">{t('Product Investment')}</p><h2>{t('Purchase history')}</h2></div></div>
        <div className="card inventory-card">
          {purchases.map((purchase) => (
            <div key={purchase.id} className="inventory-row">
              <div><strong>{purchase.product} × {purchase.quantity}</strong><small>{purchase.date} · {purchase.supplier} · Total RWF {purchase.totalAmount.toLocaleString()} · Paid RWF {purchase.paidAmount.toLocaleString()}</small></div>
              <div className="row-actions">
                <button className="outline-button" type="button" onClick={() => editPurchase(purchase)}>{t('Edit')}</button>
                <button className="danger-button" type="button" onClick={() => void deletePurchase(purchase)}>{t('Delete')}</button>
              </div>
            </div>
          ))}
          {!purchases.length && <p className="empty-state">{t('No product purchases recorded yet.')}</p>}
        </div>
      </section>
      <section className="management-section">
        <div className="page-header"><div><p className="eyebrow">{t('Directory')}</p><h2>{t('Suppliers')}</h2></div></div>
        <div className="card form-card">
          <form onSubmit={saveSupplier} className="form-grid">
            <label><span>{t('Supplier name')}</span><input required value={supplierForm.name} onChange={(event) => setSupplierForm({ ...supplierForm, name: event.target.value })} /></label>
            <div className="row-actions">
              <button className="primary-button" type="submit">{supplierForm.id ? t('Save supplier') : t('Add supplier')}</button>
              {supplierForm.id > 0 && <button className="outline-button" type="button" onClick={() => setSupplierForm({ id: 0, name: '' })}>{t('Cancel')}</button>}
            </div>
          </form>
          {suppliers.map((item) => (
            <div key={item.id} className="inventory-row">
              <strong>{item.name}</strong>
              <div className="row-actions">
                <button className="outline-button" type="button" onClick={() => setSupplierForm({ id: item.id, name: item.name })}>{t('Edit')}</button>
                <button className="danger-button" type="button" onClick={() => void deleteSupplier(item)}>{t('Delete')}</button>
              </div>
            </div>
          ))}
          {!suppliers.length && <p className="empty-state">{t('No suppliers recorded yet.')}</p>}
        </div>
      </section>
      <section className="management-section">
        <div className="page-header"><div><p className="eyebrow">{t('Stock control')}</p><h2>{t(returnId ? 'Edit supplier return' : 'Record supplier return')}</h2></div></div>
        <div className="card form-card">
          <form onSubmit={saveReturn} className="form-grid">
            <label><span>{t('Supplier')}</span><select required disabled={Boolean(returnId)} value={returnForm.supplierId} onChange={(event) => setReturnForm({ ...returnForm, supplierId: event.target.value })}>
              <option value="">{t('Select a supplier')}</option>{suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label><span>{t('Product')}</span><select required disabled={Boolean(returnId)} value={returnForm.productId} onChange={(event) => setReturnForm({ ...returnForm, productId: event.target.value })}>
              <option value="">{t('Select a product')}</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label><span>{t('Quantity returned')}</span><input type="number" min="1" step="1" required value={returnForm.quantity} onChange={(event) => setReturnForm({ ...returnForm, quantity: event.target.value })} /></label>
            <label><span>{t('Unit cost (RWF)')}</span><input type="number" min="0" step="0.01" required value={returnForm.unitCost} onChange={(event) => setReturnForm({ ...returnForm, unitCost: event.target.value })} /></label>
            <label><span>{t('Settlement')}</span><select value={returnForm.settlementType} onChange={(event) => setReturnForm({ ...returnForm, settlementType: event.target.value })}>
              <option value="supplier_credit">{t('Supplier credit')}</option><option value="cash_refund">{t('Cash refund')}</option>
            </select></label>
            <label><span>{t('Return date')}</span><input type="date" required value={returnForm.date} onChange={(event) => setReturnForm({ ...returnForm, date: event.target.value })} /></label>
            <label><span>{t('Return amount (RWF)')}</span><input type="number" min="0.01" step="0.01" value={returnForm.amount} onChange={(event) => setReturnForm({ ...returnForm, amount: event.target.value })} placeholder={t('Defaults to quantity × unit cost')} /></label>
            <div className="row-actions">
              <button className="primary-button" type="submit" disabled={!products.length || !suppliers.length}>{returnId ? t('Save return') : t('Record return')}</button>
              {returnId && <button className="outline-button" type="button" onClick={() => setReturnId(null)}>{t('Cancel')}</button>}
            </div>
          </form>
          {returns.map((item) => (
            <div key={item.id} className="inventory-row">
              <div><strong>{item.product} × {item.quantity}</strong><small>{item.date} · {item.supplier} · {item.settlementType.replace('_', ' ')} · RWF {item.amount.toLocaleString()}</small></div>
              <div className="row-actions">
                <button className="outline-button" type="button" onClick={() => editReturn(item)}>{t('Edit')}</button>
                <button className="danger-button" type="button" onClick={() => void deleteReturn(item)}>{t('Delete')}</button>
              </div>
            </div>
          ))}
          {!returns.length && <p className="empty-state">{t('No supplier returns recorded.')}</p>}
        </div>
      </section>
      <section className="management-section">
        <div className="page-header"><div><p className="eyebrow">{t('Stock control')}</p><h2>{t(adjustmentId ? 'Edit stock adjustment' : 'Adjust stock')}</h2></div></div>
        <div className="card form-card">
          <form onSubmit={saveAdjustment} className="form-grid">
            <label><span>{t('Product')}</span><select required disabled={Boolean(adjustmentId)} value={adjustmentForm.productId} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, productId: event.target.value })}>
              <option value="">{t('Select a product')}</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.availableQuantity} {t('on hand')})</option>)}
            </select></label>
            <label><span>{t('Quantity change (+ or −)')}</span><input type="number" step="1" required value={adjustmentForm.quantityDelta} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, quantityDelta: event.target.value })} /></label>
            <label><span>{t('Unit cost for stock increase (RWF)')}</span><input type="number" min="0" step="0.01" value={adjustmentForm.unitCost} onChange={(event) => setAdjustmentForm({ ...adjustmentForm, unitCost: event.target.value })} /></label>
            <div className="row-actions">
              <button className="primary-button" type="submit" disabled={!products.length}>{adjustmentId ? t('Save adjustment') : t('Adjust stock')}</button>
              {adjustmentId && <button className="outline-button" type="button" onClick={() => setAdjustmentId(null)}>{t('Cancel')}</button>}
            </div>
          </form>
          {adjustments.map((item) => (
            <div key={item.id} className="inventory-row">
              <div><strong>{item.product}: {item.quantityDelta > 0 ? '+' : ''}{item.quantityDelta}</strong><small>{new Date(item.date).toLocaleString()} · Unit cost RWF {item.unitCost.toLocaleString()}</small></div>
              <div className="row-actions">
                <button className="outline-button" type="button" onClick={() => editAdjustment(item)}>{t('Edit')}</button>
                <button className="danger-button" type="button" onClick={() => void deleteAdjustment(item)}>{t('Delete')}</button>
              </div>
            </div>
          ))}
          {!adjustments.length && <p className="empty-state">{t('No stock adjustments recorded.')}</p>}
        </div>
      </section>
    </div>
  );
}
