'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

type Product = { id: number; name: string; buyingPrice: number };
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';

export default function ProductInvestmentsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState('');
  const [supplier, setSupplier] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [buyingPrice, setBuyingPrice] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('Paid');
  const [paidAmount, setPaidAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/products`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load products.');
        return response.json();
      })
      .then((items: Product[]) => {
        setProducts(items);
        if (items.length) {
          setProductId(String(items[0].id));
          setBuyingPrice(items[0].buyingPrice > 0 ? String(items[0].buyingPrice) : '');
        }
      })
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : 'Unable to load products.'));
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
      const response = await fetch(`${API_URL}/api/product-purchases`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: Number(productId),
          productName: selectedProduct?.name,
          supplier,
          quantity: Number(quantity),
          buyingPrice: Number(buyingPrice),
          totalInvestment,
          paymentStatus,
          paidAmount: paymentStatus === 'Paid' ? totalInvestment : paymentStatus === 'Pending' ? 0 : Number(paidAmount),
          date
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'The purchase could not be saved.');
      setMessage('Purchase saved and stock updated.');
      setQuantity('1');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The purchase could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div><p className="eyebrow">Product Investment</p><h2>Record product purchase</h2></div>
      </div>
      <div className="card form-card">
        {error && <div className="error-banner" role="alert">{error}</div>}
        {message && <p className="success-message" role="status">{message}</p>}
        {!products.length && !error && <p className="empty-state">Add a product in Product Management before recording a purchase.</p>}
        <form onSubmit={handleSubmit} className="form-grid">
          <label>
            <span>Product</span>
            <select required value={productId} onChange={(event) => selectProduct(event.target.value)}>
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </label>
          <label><span>Supplier</span><input required value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder="Supplier name" /></label>
          <label><span>Quantity</span><input type="number" min="1" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <label><span>Buying price per item (RWF)</span><input type="number" min="1" required value={buyingPrice} onChange={(event) => setBuyingPrice(event.target.value)} /></label>
          <label><span>Total product investment (RWF)</span><input readOnly value={totalInvestment} /></label>
          <label>
            <span>Payment status</span>
            <select value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)}>
              <option>Paid</option><option>Partial</option><option>Pending</option>
            </select>
          </label>
          {paymentStatus === 'Partial' && (
            <label>
              <span>Amount paid now (RWF)</span>
              <input type="number" min="1" max={totalInvestment - 1} required value={paidAmount} onChange={(event) => setPaidAmount(event.target.value)} />
            </label>
          )}
          <label><span>Purchase date</span><input type="date" required value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <button className="primary-button" type="submit" disabled={saving || !products.length}>{saving ? 'Saving…' : 'Save purchase'}</button>
        </form>
      </div>
    </div>
  );
}
