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
  sku?: string | null;
  reorderLevel?: number;
};
type Sale = { id: number; date: string; productId: number; product: string; quantity: number; unitPrice: number; revenue: number; cost: number };

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';
const emptyForm = { name: '', sellingPrice: '', sku: '', reorderLevel: '0' };
const emptySale = { productId: '', quantity: '1', unitPrice: '', date: new Date().toISOString().slice(0, 10) };

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [saleForm, setSaleForm] = useState(emptySale);
  const [editingProductId, setEditingProductId] = useState<number | null>(null);
  const [editingSaleId, setEditingSaleId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const refreshProducts = useCallback(async () => {
    const response = await fetch(`${API_URL}/api/products`, { credentials: 'include' });
    if (!response.ok) throw new Error('Unable to load products.');
    const items: Product[] = await response.json();
    setProducts(items);
    if (!saleForm.productId && items.length) {
      setSaleForm((current) => ({ ...current, productId: String(items[0].id), unitPrice: String(items[0].sellingPrice) }));
    }
  }, [saleForm.productId]);

  const refreshSales = useCallback(async () => {
    const response = await fetch(`${API_URL}/api/sales`, { credentials: 'include' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Unable to load sales.');
    setSales(result);
  }, []);

  useEffect(() => {
    refreshProducts().catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : 'Unable to load products.'));
    refreshSales().catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : 'Unable to load sales.'));
  }, [refreshProducts, refreshSales]);

  function chooseSaleProduct(id: string) {
    setSaleForm((current) => ({ ...current, productId: id }));
    const selected = products.find((product) => String(product.id) === id);
    if (selected) setSaleForm((current) => ({ ...current, unitPrice: String(selected.sellingPrice) }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/products${editingProductId ? `/${editingProductId}` : ''}`, {
        method: editingProductId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          sellingPrice: Number(form.sellingPrice),
          sku: form.sku,
          reorderLevel: Number(form.reorderLevel)
        })
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? 'Product could not be saved.');
      }
      setForm(emptyForm);
      setEditingProductId(null);
      setMessage(editingProductId ? 'Product updated.' : 'Product added. Record its first stock purchase in Product Investment.');
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
      const response = await fetch(`${API_URL}/api/sales${editingSaleId ? `/${editingSaleId}` : ''}`, {
        method: editingSaleId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: Number(saleForm.productId),
          quantity: Number(saleForm.quantity),
          unitPrice: Number(saleForm.unitPrice),
          date: saleForm.date
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Sale could not be recorded.');
      setMessage(editingSaleId ? 'Sale updated and stock recalculated.' : 'Sale recorded and stock updated.');
      setSaleForm({ ...emptySale, productId: saleForm.productId, unitPrice: saleForm.unitPrice });
      setEditingSaleId(null);
      await refreshProducts();
      await refreshSales();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Sale could not be recorded.');
    }
  }

  function editProduct(product: Product) {
    setEditingProductId(product.id);
    setForm({
      name: product.name,
      sellingPrice: String(product.sellingPrice),
      sku: product.sku ?? '',
      reorderLevel: String(product.reorderLevel ?? 0)
    });
  }

  async function deleteProduct(product: Product) {
    if (!window.confirm(`Permanently delete "${product.name}"? Products with purchase, sale, or stock history cannot be deleted.`)) return;
    try {
      const response = await fetch(`${API_URL}/api/products/${product.id}`, { method: 'DELETE', credentials: 'include' });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(result?.error ?? 'Product could not be deleted.');
      setMessage('Product deleted.');
      await refreshProducts();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Product could not be deleted.');
    }
  }

  function editSale(sale: Sale) {
    setEditingSaleId(sale.id);
    setSaleForm({ productId: String(sale.productId), quantity: String(sale.quantity), unitPrice: String(sale.unitPrice), date: sale.date });
  }

  async function deleteSale(sale: Sale) {
    if (!window.confirm(`Permanently delete this sale of ${sale.quantity} ${sale.product}? Stock will be restored.`)) return;
    try {
      const response = await fetch(`${API_URL}/api/sales/${sale.id}`, { method: 'DELETE', credentials: 'include' });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(result?.error ?? 'Sale could not be deleted.');
      setMessage('Sale deleted and stock restored.');
      await refreshProducts();
      await refreshSales();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Sale could not be deleted.');
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
          <h3>{editingProductId ? 'Edit product' : 'Add product'}</h3>
          <p className="panel-description">Add a product to your catalog, then use Product Investment to receive stock.</p>
          <form onSubmit={handleSubmit} className="form-grid">
            <label><span>Product name</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label><span>SKU (optional)</span><input value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} /></label>
            <label><span>Selling price (RWF)</span><input type="number" min="0" step="0.01" required value={form.sellingPrice} onChange={(event) => setForm({ ...form, sellingPrice: event.target.value })} /></label>
            <label><span>Low-stock alert quantity</span><input type="number" min="0" step="1" required value={form.reorderLevel} onChange={(event) => setForm({ ...form, reorderLevel: event.target.value })} /></label>
            <div className="row-actions">
              <button type="submit" className="primary-button">{editingProductId ? 'Save changes' : 'Save product'}</button>
              {editingProductId && <button type="button" className="outline-button" onClick={() => { setEditingProductId(null); setForm(emptyForm); }}>Cancel</button>}
            </div>
          </form>
        </div>

        <div className="card form-card">
          <h3>Record sale</h3>
          <p className="panel-description">Saving a sale reduces available stock and updates the dashboard.</p>
          <form onSubmit={handleSale} className="form-grid">
            <label>
              <span>Product</span>
              <select required value={saleForm.productId} onChange={(event) => chooseSaleProduct(event.target.value)}>
                {products.map((product) => <option key={product.id} value={product.id}>{product.name} ({product.availableQuantity} available)</option>)}
              </select>
            </label>
            <label><span>Quantity sold</span><input type="number" min="1" step="1" required value={saleForm.quantity} onChange={(event) => setSaleForm({ ...saleForm, quantity: event.target.value })} /></label>
            <label><span>Sale price per item (RWF)</span><input type="number" min="1" step="0.01" required value={saleForm.unitPrice} onChange={(event) => setSaleForm({ ...saleForm, unitPrice: event.target.value })} /></label>
            <label><span>Sale date</span><input type="date" required value={saleForm.date} onChange={(event) => setSaleForm({ ...saleForm, date: event.target.value })} /></label>
            <div className="row-actions">
              <button type="submit" className="primary-button" disabled={!editingSaleId && !products.some((product) => product.availableQuantity > 0)}>{editingSaleId ? 'Save sale changes' : 'Save sale'}</button>
              {editingSaleId && <button type="button" className="outline-button" onClick={() => { setEditingSaleId(null); setSaleForm(emptySale); }}>Cancel</button>}
            </div>
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
              <div className="row-actions">
                <button className="outline-button" type="button" onClick={() => editProduct(product)}>Edit</button>
                <button className="danger-button" type="button" onClick={() => void deleteProduct(product)}>Delete</button>
              </div>
            </div>
          ))}
          {!products.length && <p className="empty-state">No products yet. Add one above to get started.</p>}
        </div>
        <div className="card inventory-card">
          <div className="panel-heading"><h3>Sales history</h3><span className="inventory-count">{sales.length} sales</span></div>
          {sales.map((sale) => (
            <div key={sale.id} className="inventory-row">
              <div className="inventory-product">
                <span className="product-initial">{sale.product.slice(0, 1).toUpperCase()}</span>
                <div><strong>{sale.product} × {sale.quantity}</strong><small>{sale.date} · Revenue {formatMoney(sale.revenue)} · COGS {formatMoney(sale.cost)}</small></div>
              </div>
              <div className="row-actions">
                <button className="outline-button" type="button" onClick={() => editSale(sale)}>Edit</button>
                <button className="danger-button" type="button" onClick={() => void deleteSale(sale)}>Delete</button>
              </div>
            </div>
          ))}
          {!sales.length && <p className="empty-state">No sales recorded yet.</p>}
        </div>
      </div>
    </div>
  );
}

function formatMoney(value: number) {
  return `RWF ${Number(value).toLocaleString()}`;
}
