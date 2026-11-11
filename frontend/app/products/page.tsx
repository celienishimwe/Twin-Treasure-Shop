'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

type Product = {
  id: number;
  name: string;
  buyingPrice: number;
  sellingPrice: number;
  quantityPurchased: number;
  soldQuantity: number;
  availableQuantity: number;
  remainingStockInvestment: number;
  supplier: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';
const emptyForm = { name: '', sellingPrice: '' };

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [saleProduct, setSaleProduct] = useState('');
  const [saleQuantity, setSaleQuantity] = useState('1');
  const [salePrice, setSalePrice] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const refreshProducts = useCallback(async () => {
    const response = await fetch(`${API_URL}/api/products`, { credentials: 'include' });
    if (!response.ok) throw new Error('Unable to load products.');
    const items: Product[] = await response.json();
    setProducts(items);
    if (!saleProduct && items.length) {
      setSaleProduct(String(items[0].id));
      setSalePrice(String(items[0].sellingPrice));
    }
  }, [saleProduct]);

  useEffect(() => {
    refreshProducts().catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : 'Unable to load products.'));
  }, [refreshProducts]);

  function chooseSaleProduct(id: string) {
    setSaleProduct(id);
    const selected = products.find((product) => String(product.id) === id);
    if (selected) setSalePrice(String(selected.sellingPrice));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/products`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          sellingPrice: Number(form.sellingPrice)
        })
      });
      if (!response.ok) throw new Error('Product could not be saved.');
      setForm(emptyForm);
      setMessage('Product added. Record its first stock purchase in Product Investment.');
      await refreshProducts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Product could not be saved.');
    }
  }

  async function handleSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/sales`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: Number(saleProduct), quantity: Number(saleQuantity), unitPrice: Number(salePrice) })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Sale could not be recorded.');
      setMessage('Sale recorded and stock updated.');
      setSaleQuantity('1');
      await refreshProducts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Sale could not be recorded.');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div><p className="eyebrow">Product Management</p><h2>Products and stock</h2></div>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {message && <p className="success-message" role="status">{message}</p>}

      <div className="content-grid two-column">
        <div className="card form-card">
          <h3>Add product</h3>
          <p className="panel-description">Add a product to your catalog, then use Product Investment to receive stock.</p>
          <form onSubmit={handleSubmit} className="form-grid">
            <label><span>Product name</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label><span>Selling price (RWF)</span><input type="number" min="1" required value={form.sellingPrice} onChange={(event) => setForm({ ...form, sellingPrice: event.target.value })} /></label>
            <button type="submit" className="primary-button">Save product</button>
          </form>
        </div>

        <div className="card form-card">
          <h3>Record sale</h3>
          <p className="panel-description">Saving a sale reduces available stock and updates the dashboard.</p>
          <form onSubmit={handleSale} className="form-grid">
            <label>
              <span>Product</span>
              <select required value={saleProduct} onChange={(event) => chooseSaleProduct(event.target.value)}>
                {products.map((product) => <option key={product.id} value={product.id}>{product.name} ({product.availableQuantity} available)</option>)}
              </select>
            </label>
            <label><span>Quantity sold</span><input type="number" min="1" step="1" required value={saleQuantity} onChange={(event) => setSaleQuantity(event.target.value)} /></label>
            <label><span>Sale price per item (RWF)</span><input type="number" min="1" required value={salePrice} onChange={(event) => setSalePrice(event.target.value)} /></label>
            <button type="submit" className="primary-button" disabled={!products.some((product) => product.availableQuantity > 0)}>Save sale</button>
          </form>
        </div>

        <div className="card inventory-card">
          <div className="panel-heading"><h3>Product inventory</h3><span className="inventory-count">{products.length} products</span></div>
          {products.map((product) => (
            <div key={product.id} className="inventory-row">
              <div className="inventory-product">
                <span className="product-initial">{product.name.slice(0, 1).toUpperCase()}</span>
                <div><strong>{product.name}</strong><small>{product.supplier || 'No supplier selected'}</small></div>
              </div>
              <div className="inventory-numbers">
                <span>Available<strong>{product.availableQuantity}</strong></span>
                <span>Stock value<strong>{formatMoney(product.remainingStockInvestment)}</strong></span>
                <span>Buy / sell<strong>{formatMoney(product.buyingPrice)} / {formatMoney(product.sellingPrice)}</strong></span>
              </div>
            </div>
          ))}
          {!products.length && <p className="empty-state">No products yet. Add one above to get started.</p>}
        </div>
      </div>
    </div>
  );
}

function formatMoney(value: number) {
  return `RWF ${Number(value).toLocaleString()}`;
}
