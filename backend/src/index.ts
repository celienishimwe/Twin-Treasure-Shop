import cors from 'cors';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { promisify } from 'node:util';

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? '5000');
const databaseUrl = process.env.DATABASE_URL;

const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
const sessionSecret = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex');
const sessionCookieName = 'twin_treasure_session';
const sessionMaxAgeSeconds = 60 * 60 * 12;
const scrypt = promisify(scryptCallback);

if (process.env.NODE_ENV === 'production'
  && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || process.env.SESSION_SECRET.startsWith('replace-with-'))) {
  throw new Error('Set SESSION_SECRET to a private random value of at least 32 characters in production.');
}

app.use(cors({ origin: frontendUrl, credentials: true }));
app.use(express.json());

const pool = new Pool({ connectionString: databaseUrl });
let databaseAvailable = false;

async function initializeDatabase() {
  try {
    await pool.query('SELECT 1');
    databaseAvailable = true;
  } catch {
    databaseAvailable = false;
    console.warn('PostgreSQL is unavailable. Run the database migration and check DATABASE_URL.');
  }
}

async function getProducts(): Promise<any[]> {
  const result = await pool.query(
    `SELECT p.*,
       COALESCE((SELECT SUM(pi.quantity)
         FROM purchase_items pi
         JOIN product_purchases pp ON pp.id = pi.purchase_id
         WHERE pi.product_id = p.id AND pp.status = 'received'), 0) AS quantity_purchased,
       COALESCE((SELECT SUM(si.quantity)
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE si.product_id = p.id AND s.status = 'completed'), 0) AS sold_quantity,
       (SELECT su.name
         FROM purchase_items pi
         JOIN product_purchases pp ON pp.id = pi.purchase_id
         JOIN suppliers su ON su.id = pp.supplier_id
         WHERE pi.product_id = p.id AND pp.status = 'received'
         ORDER BY pp.purchase_date DESC, pp.id DESC LIMIT 1) AS supplier
     FROM products p
     WHERE p.is_active = TRUE
     ORDER BY p.id ASC`
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    buyingPrice: Number(row.average_cost),
    sellingPrice: Number(row.selling_price),
    sku: row.sku,
    reorderLevel: Number(row.reorder_level),
    quantityPurchased: Number(row.quantity_purchased),
    soldQuantity: Number(row.sold_quantity),
    availableQuantity: Number(row.quantity_on_hand),
    remainingStockInvestment: Number(row.quantity_on_hand) * Number(row.average_cost),
    supplier: row.supplier ?? '',
    lastUpdated: row.updated_at
  }));
}

async function getTransactions(): Promise<any[]> {
  const result = await pool.query(
    `SELECT t.*,
       CASE t.event_type
         WHEN 'capital_contribution' THEN 'investment'
         WHEN 'owner_withdrawal' THEN 'withdrawal'
         WHEN 'cash_adjustment' THEN 'adjustment'
         WHEN 'inventory_purchase' THEN 'purchase'
         WHEN 'operating_expense' THEN 'expense'
         ELSE t.event_type
       END AS type,
       (SELECT SUM(si.cost_total) FROM sale_items si WHERE si.sale_id = t.sale_id) AS cost_amount,
       (SELECT sr.settlement_type FROM supplier_returns sr WHERE sr.id = t.supplier_return_id) AS settlement_type,
       (SELECT sp.supplier_id FROM supplier_payments sp WHERE sp.id = t.supplier_payment_id) AS supplier_id,
       (SELECT e.category FROM expenses e WHERE e.id = t.expense_id) AS expense_category
     FROM transactions t
     ORDER BY t.occurred_at DESC, t.id DESC`
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    type: row.type,
    amount: Number(row.cash_impact),
    description: row.description,
    date: new Date(row.occurred_at).toISOString(),
    category: row.expense_category ?? row.event_type,
    eventType: row.event_type,
    sourceId: Number(row.business_capital_id ?? row.product_purchase_id ?? row.sale_id ?? row.expense_id ?? row.supplier_payment_id ?? row.supplier_return_id),
    supplierId: row.supplier_id === null ? null : Number(row.supplier_id),
    totalAmount: row.event_type === 'inventory_purchase' || row.event_type === 'supplier_return' ? Number(row.amount) : null,
    paymentStatus: null,
    costAmount: row.cost_amount === null ? null : Number(row.cost_amount),
    settlementType: row.settlement_type
  }));
}

type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'all';

function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function calculateFinancialReport(
  transactions: any[],
  products: any[],
  period: ReportPeriod,
  selectedDate: string
) {
  const date = new Date(`${selectedDate}T00:00:00.000Z`);
  const start = period === 'all' ? new Date('0001-01-01T00:00:00.000Z') : new Date(date);
  const end = new Date(date);

  if (period === 'all') {
    end.setTime(new Date(`${selectedDate}T00:00:00.000Z`).getTime());
  } else if (period === 'weekly') {
    const weekday = (date.getUTCDay() + 6) % 7;
    start.setUTCDate(date.getUTCDate() - weekday);
    end.setUTCDate(start.getUTCDate() + 6);
  } else if (period === 'monthly') {
    start.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
  }

  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const inPeriod = transactions.filter((item) => {
    const transactionDate = String(item.date).slice(0, 10);
    return transactionDate >= startDate && transactionDate <= endDate;
  });
  const sum = (items: any[], predicate: (item: any) => boolean, amount = (item: any) => Number(item.amount || 0)) =>
    items.filter(predicate).reduce((total, item) => total + amount(item), 0);
  const productById = new Map(products.map((product) => [Number(product.id), product]));
  const costOfSale = (sale: any) => {
    if (sale.costAmount !== null && sale.costAmount !== undefined) return Number(sale.costAmount);
    const quantity = Number(String(sale.description).match(/^(\d+)/)?.[1] ?? 0);
    const product = productById.get(Number(sale.productId));
    return quantity && product ? quantity * Number(product.buyingPrice) : 0;
  };

  const totalInvestment = sum(inPeriod, (item) => item.type === 'investment');
  const totalSalesRevenue = sum(inPeriod, (item) => item.type === 'sale');
  const totalExpenses = Math.abs(sum(inPeriod, (item) => item.type === 'expense'));
  const otherIncome = 0;
  const costOfProductsSold = inPeriod
    .filter((item) => item.type === 'sale')
    .reduce((total, sale) => total + costOfSale(sale), 0);
  const grossProfit = totalSalesRevenue - costOfProductsSold;
  const netProfit = grossProfit - totalExpenses;
  const closingCashBalance = transactions
    .filter((item) => String(item.date).slice(0, 10) <= endDate)
    .reduce((total, item) => total + Number(item.amount || 0), 0);

  return {
    period,
    startDate,
    endDate,
    totalInvestment,
    totalSalesRevenue,
    totalExpenses,
    costOfProductsSold,
    otherIncome,
    grossProfit,
    netProfit,
    closingCashBalance,
    transactionCount: inPeriod.length
  };
}

function calculateDashboard(products: any[], transactions: any[]) {
  const sum = (items: any[], predicate: (item: any) => boolean) =>
    items.filter(predicate).reduce((total, item) => total + Number(item.amount || 0), 0);
  const totalBusinessCapital = sum(transactions, (item) => item.type === 'investment');
  const totalSales = sum(transactions, (item) => item.type === 'sale');
  const totalExpenses = Math.abs(sum(transactions, (item) => item.type === 'expense'));
  const supplierPayments = Math.abs(sum(transactions, (item) => item.type === 'supplier_payment'));
  const totalPurchases = transactions
    .filter((item) => item.type === 'purchase')
    .reduce((total, item) => total + Number(item.totalAmount ?? Math.abs(Number(item.amount))), 0);
  const inventoryInvestment = products.reduce((total, item) => total + Number(item.remainingStockInvestment || 0), 0);
  const availableCash = transactions.reduce((total, item) => total + Number(item.amount || 0), 0);
  const financials = calculateFinancialReport(transactions, products, 'monthly', new Date().toISOString().slice(0, 10));
  const allTimeFinancials = calculateFinancialReport(transactions, products, 'all', '9999-12-31');
  const grossProfit = allTimeFinancials.grossProfit;
  const netProfit = allTimeFinancials.netProfit;
  const supplierCredits = transactions
    .filter((item) => item.type === 'supplier_return' && item.settlementType === 'supplier_credit')
    .reduce((total, item) => total + Number(item.totalAmount || 0), 0);
  const outstandingSupplierBalance = Math.max(0, totalPurchases - supplierPayments - supplierCredits);
  const productCount = products.length;
  const lowStockProducts = products.filter((product) => product.availableQuantity < 5).length;
  const costOfGoodsSold = allTimeFinancials.costOfProductsSold;
  const monthlySales = Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setMonth(date.getMonth() - (5 - index), 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return {
      key,
      label: date.toLocaleDateString('en', { month: 'short' }),
      value: sum(transactions, (item) => item.type === 'sale' && String(item.date).slice(0, 7) === key)
    };
  });

  return {
    totalBusinessCapital,
    inventoryInvestment,
    availableCash,
    netProfit,
    grossProfit,
    totalSales,
    costOfGoodsSold,
    totalExpenses,
    supplierPayments,
    outstandingSupplierBalance,
    productCount,
    lowStockProducts,
    monthlySales,
    periodFinancials: financials,
    recentTransactions: transactions.slice(0, 5)
  };
}

type SessionUser = { id: number; email: string };

function getSessionToken(req: Request) {
  const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`));
  return cookie ? cookie.slice(sessionCookieName.length + 1) : null;
}

function signSession(user: SessionUser) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds
  })).toString('base64url');
  const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySession(token: string | null): SessionUser | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', sessionSecret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isInteger(data.sub) || typeof data.email !== 'string' || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return { id: data.sub, email: data.email };
  } catch {
    return null;
  }
}

function setSessionCookie(res: Response, user: SessionUser) {
  const attributes = process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
  res.setHeader('Set-Cookie', `${sessionCookieName}=${signSession(user)}; HttpOnly; ${attributes}; Path=/; Max-Age=${sessionMaxAgeSeconds}`);
}

function clearSessionCookie(res: Response) {
  const attributes = process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
  res.setHeader('Set-Cookie', `${sessionCookieName}=; HttpOnly; ${attributes}; Path=/; Max-Age=0`);
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt.toString('base64url')}.${hash.toString('base64url')}`;
}

async function passwordMatches(password: string, storedHash: string) {
  const [saltText, hashText] = storedHash.split('.');
  if (!saltText || !hashText) return false;
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(hashText, 'base64url');
  if (expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  return timingSafeEqual(actual, expected);
}

async function getOwnerCount() {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  return Number(result.rows[0].count);
}

async function getOwnerByEmail(email: string): Promise<{ id: number; email: string; passwordHash: string } | null> {
  const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
  const owner = result.rows[0];
  return owner ? { id: Number(owner.id), email: owner.email, passwordHash: owner.password_hash } : null;
}

async function registerOwner(email: string, passwordHash: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [184702911]);
    const count = await client.query('SELECT COUNT(*)::int AS count FROM users');
    if (Number(count.rows[0].count) > 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const created = await client.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );
    await client.query('COMMIT');
    return { id: Number(created.rows[0].id), email: created.rows[0].email };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('origin');
  if (origin && origin !== frontendUrl) {
    res.status(403).json({ error: 'Request origin is not allowed.' });
    return;
  }
  next();
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = verifySession(getSessionToken(req));
  if (!user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  next();
}

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', database: databaseAvailable ? 'connected' : 'unavailable' });
});

app.get('/api/auth/status', async (req: Request, res: Response) => {
  try {
    const ownerCount = await getOwnerCount();
    const user = verifySession(getSessionToken(req));
    res.json({
      setupRequired: ownerCount === 0,
      user: user && ownerCount > 0 ? user : null
    });
  } catch {
    res.status(503).json({ error: 'Authentication storage is unavailable.' });
  }
});

app.post('/api/auth/setup', requireSameOrigin, async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  if (password.length < 10 || password.length > 128) {
    res.status(400).json({ error: 'Password must be between 10 and 128 characters.' });
    return;
  }

  try {
    const owner = await registerOwner(email, await hashPassword(password));
    if (!owner) {
      res.status(409).json({ error: 'The owner account is already set up. Please log in.' });
      return;
    }
    setSessionCookie(res, owner);
    res.status(201).json({ user: owner });
  } catch {
    res.status(503).json({ error: 'Could not create the owner account. Check the backend database connection.' });
  }
});

app.post('/api/auth/login', requireSameOrigin, async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password || password.length > 128) {
    res.status(400).json({ error: 'Enter your email and password.' });
    return;
  }
  try {
    const owner = await getOwnerByEmail(email);
    if (!owner || !(await passwordMatches(password, owner.passwordHash))) {
      res.status(401).json({ error: 'Email or password is incorrect.' });
      return;
    }
    const user = { id: owner.id, email: owner.email };
    setSessionCookie(res, user);
    res.json({ user });
  } catch {
    res.status(503).json({ error: 'Authentication storage is unavailable.' });
  }
});

app.post('/api/auth/logout', requireSameOrigin, (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.use('/api', requireAuth);

app.get('/api/dashboard', async (_req: Request, res: Response) => {
  const products = await getProducts();
  const transactions = await getTransactions();
  res.json(calculateDashboard(products, transactions));
});

app.get('/api/products', async (_req: Request, res: Response) => {
  res.json(await getProducts());
});

app.post('/api/products', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  const sellingPrice = Number(body.sellingPrice);
  const reorderLevel = Number(body.reorderLevel ?? 0);
  if (!name || !Number.isFinite(sellingPrice) || sellingPrice < 0 || !Number.isInteger(reorderLevel) || reorderLevel < 0) {
    res.status(400).json({ error: 'A product name, non-negative selling price, and whole-number reorder level are required.' });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO products (name, sku, selling_price, reorder_level)
       VALUES ($1, $2, $3, $4) RETURNING id, name, selling_price, quantity_on_hand, average_cost, updated_at`,
      [name, body.sku ? String(body.sku).trim() : null, sellingPrice, reorderLevel]
    );
    const row = result.rows[0];
    res.status(201).json({
      id: Number(row.id),
      name: row.name,
      buyingPrice: Number(row.average_cost),
      sellingPrice: Number(row.selling_price),
      quantityPurchased: 0,
      soldQuantity: 0,
      availableQuantity: Number(row.quantity_on_hand),
      remainingStockInvestment: 0,
      supplier: '',
      lastUpdated: row.updated_at
    });
  } catch (error) {
    console.error('Could not create product:', error);
    res.status(500).json({ error: 'Product could not be saved.' });
  }
});

app.put('/api/products/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, sellingPrice, sku, reorderLevel } = req.body ?? {};
  const productName = String(name ?? '').trim();
  const price = Number(sellingPrice);
  const reorder = Number(reorderLevel ?? 0);
  if (!Number.isInteger(id) || id <= 0 || !productName || !Number.isFinite(price) || price < 0
    || !Number.isInteger(reorder) || reorder < 0) {
    res.status(400).json({ error: 'Provide a product name, non-negative selling price, and whole-number reorder level.' });
    return;
  }
  try {
    const result = await pool.query(
      `UPDATE products
       SET name = $1, selling_price = $2, sku = $3, reorder_level = $4, updated_at = NOW()
       WHERE id = $5 AND is_active = TRUE
       RETURNING id, name, sku, selling_price, quantity_on_hand, average_cost, reorder_level, updated_at`,
      [productName, price, sku ? String(sku).trim() : null, reorder, id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Could not update product:', error);
    res.status(409).json({ error: 'Product could not be updated. Check that its SKU is unique.' });
  }
});

app.delete('/api/products/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid product ID.' });
    return;
  }
  try {
    const result = await pool.query(
      `DELETE FROM products p
       WHERE p.id = $1
         AND NOT EXISTS (SELECT 1 FROM purchase_items WHERE product_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM sale_items WHERE product_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM stock_movements WHERE product_id = p.id)
       RETURNING p.id`,
      [id]
    );
    if (result.rowCount) {
      res.status(204).end();
      return;
    }
    const exists = await pool.query('SELECT 1 FROM products WHERE id = $1', [id]);
    res.status(exists.rowCount ? 409 : 404).json({
      error: exists.rowCount
        ? 'Product has purchase, sale, or stock history and cannot be deleted.'
        : 'Product not found.'
    });
  } catch (error) {
    console.error('Could not delete product:', error);
    res.status(500).json({ error: 'Product could not be deleted.' });
  }
});

app.post('/api/product-purchases', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const productId = Number(body.productId);
  const quantity = Number(body.quantity ?? 0);
  const buyingPrice = Number(body.buyingPrice ?? 0);
  const purchaseAmount = Math.round(quantity * buyingPrice * 100) / 100;
  const supplierName = String(body.supplier ?? '').trim();
  const date = String(body.date ?? new Date().toISOString().slice(0, 10));
  const paidAmount = body.paymentStatus === 'Paid' ? purchaseAmount
    : body.paymentStatus === 'Pending' ? 0
      : Number(body.paidAmount ?? 0);

  if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(quantity) || quantity <= 0
    || !Number.isFinite(buyingPrice) || buyingPrice <= 0 || !Number.isFinite(purchaseAmount)
    || !supplierName || !isValidDate(date)
    || !Number.isFinite(paidAmount) || paidAmount < 0 || paidAmount > purchaseAmount
    || (body.paymentStatus === 'Partial' && (paidAmount <= 0 || paidAmount >= purchaseAmount))) {
    res.status(400).json({ error: 'Enter a product, supplier, purchase date, positive quantity and price, and valid payment amount.' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const productResult = await client.query(
      'SELECT id, name, quantity_on_hand, average_cost FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE',
      [productId]
    );
    const product = productResult.rows[0];
    if (!product) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Product not found.' });
      return;
    }

    const supplierResult = await client.query(
      `INSERT INTO suppliers (name) VALUES ($1)
       ON CONFLICT (lower(name)) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [supplierName]
    );
    const supplierId = Number(supplierResult.rows[0].id);
    const purchaseDate = new Date(`${date}T00:00:00.000Z`);
    const purchaseResult = await client.query(
      `INSERT INTO product_purchases (supplier_id, purchase_date, status)
       VALUES ($1, $2, 'received') RETURNING id`,
      [supplierId, purchaseDate]
    );
    const purchaseId = Number(purchaseResult.rows[0].id);
    const itemResult = await client.query(
      `INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [purchaseId, productId, quantity, buyingPrice]
    );
    const itemId = Number(itemResult.rows[0].id);
    await client.query(
      `UPDATE products
       SET quantity_on_hand = quantity_on_hand + $1,
           average_cost = ((quantity_on_hand * average_cost) + $2) / (quantity_on_hand + $1),
           updated_at = NOW()
       WHERE id = $3`,
      [quantity, purchaseAmount, productId]
    );
    await client.query(
      `INSERT INTO stock_movements (product_id, movement_type, quantity_delta, unit_cost, purchase_item_id, occurred_at)
       VALUES ($1, 'purchase', $2, $3, $4, $5)`,
      [productId, quantity, buyingPrice, itemId, purchaseDate]
    );
    await client.query(
      `INSERT INTO transactions (event_type, amount, cash_impact, occurred_at, description, product_purchase_id)
       VALUES ('inventory_purchase', $1, 0, $2, $3, $4)`,
      [purchaseAmount, purchaseDate, `${quantity} ${product.name} purchased from ${supplierName}`, purchaseId]
    );

    if (paidAmount > 0) {
      const paymentResult = await client.query(
        `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, payment_date)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [supplierId, purchaseId, paidAmount, purchaseDate]
      );
      await client.query(
        `INSERT INTO transactions (event_type, amount, cash_impact, occurred_at, description, supplier_payment_id)
         VALUES ('supplier_payment', $1, $2, $3, $4, $5)`,
        [paidAmount, -paidAmount, purchaseDate, `Payment for purchase #${purchaseId}`, paymentResult.rows[0].id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: purchaseId, productId, supplierId, quantity, totalAmount: purchaseAmount, paidAmount });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not record product purchase:', error);
    res.status(500).json({ error: 'The purchase could not be saved.' });
  } finally {
    client.release();
  }
});

app.get('/api/product-purchases', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT pp.id, pp.purchase_date, pp.status, pp.supplier_id, su.name AS supplier,
         pi.id AS item_id, pi.product_id, p.name AS product,
         pi.quantity, pi.unit_cost, pi.line_total,
         COALESCE(SUM(sp.amount), 0) AS paid_amount
       FROM product_purchases pp
       JOIN suppliers su ON su.id = pp.supplier_id
       JOIN purchase_items pi ON pi.purchase_id = pp.id
       JOIN products p ON p.id = pi.product_id
       LEFT JOIN supplier_payments sp ON sp.purchase_id = pp.id
       GROUP BY pp.id, su.name, pi.id, p.name
       ORDER BY pp.purchase_date DESC, pp.id DESC`
    );
    res.json(result.rows.map((row) => ({
      id: Number(row.id),
      date: new Date(row.purchase_date).toISOString().slice(0, 10),
      status: row.status,
      supplierId: Number(row.supplier_id),
      supplier: row.supplier,
      productId: Number(row.product_id),
      product: row.product,
      quantity: Number(row.quantity),
      buyingPrice: Number(row.unit_cost),
      totalAmount: Number(row.line_total),
      paidAmount: Number(row.paid_amount)
    })));
  } catch (error) {
    console.error('Could not load product purchases:', error);
    res.status(500).json({ error: 'Unable to load product purchases.' });
  }
});

app.put('/api/product-purchases/:id', async (req: Request, res: Response) => {
  const purchaseId = Number(req.params.id);
  const quantity = Number(req.body?.quantity);
  const unitCost = Number(req.body?.buyingPrice);
  const date = String(req.body?.date ?? '');
  if (!Number.isInteger(purchaseId) || purchaseId <= 0 || !Number.isInteger(quantity) || quantity <= 0
    || !Number.isFinite(unitCost) || unitCost <= 0 || !isValidDate(date)) {
    res.status(400).json({ error: 'Provide a valid purchase ID, positive quantity and cost, and purchase date.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT pp.id, pp.purchase_date, pi.id AS item_id, pi.product_id, pi.quantity AS old_quantity,
         pi.unit_cost AS old_cost, p.name, p.quantity_on_hand, p.average_cost
       FROM product_purchases pp
       JOIN purchase_items pi ON pi.purchase_id = pp.id
       JOIN products p ON p.id = pi.product_id
       WHERE pp.id = $1 AND pp.status = 'received'
       FOR UPDATE OF pp, pi, p`,
      [purchaseId]
    );
    const purchase = found.rows[0];
    if (!purchase) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Received purchase not found.' });
      return;
    }
    const movement = await client.query('SELECT id FROM stock_movements WHERE purchase_item_id = $1 FOR UPDATE', [purchase.item_id]);
    if (!movement.rowCount) throw new Error('Purchase stock movement is missing.');
    const purchaseDate = new Date(`${date}T00:00:00.000Z`);
    const laterStockActivity = await client.query(
      `SELECT 1 FROM stock_movements
       WHERE product_id = $1 AND movement_type <> 'purchase'
         AND occurred_at >= LEAST($2::timestamptz, $3::timestamptz)
         AND id <> $4 LIMIT 1`,
      [purchase.product_id, purchase.purchase_date, purchaseDate, movement.rows[0].id]
    );
    if (laterStockActivity.rowCount) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Purchase cannot be edited after later stock activity; use a supplier return for corrections.' });
      return;
    }
    const oldQuantity = Number(purchase.old_quantity);
    const available = Number(purchase.quantity_on_hand) - oldQuantity + quantity;
    if (available < 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Purchase quantity cannot be reduced below current stock.' });
      return;
    }
    const outstanding = await client.query(
      'SELECT COALESCE(SUM(amount), 0) AS amount FROM supplier_payments WHERE purchase_id = $1',
      [purchaseId]
    );
    const total = quantity * unitCost;
    if (Number(outstanding.rows[0].amount) > total) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Purchase total cannot be lower than payments already recorded.' });
      return;
    }
    const stockValue = Number(purchase.quantity_on_hand) * Number(purchase.average_cost)
      - oldQuantity * Number(purchase.old_cost) + quantity * unitCost;
    if (stockValue < -0.01) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Purchase cannot be edited because it would make inventory valuation invalid.' });
      return;
    }
    const averageCost = available === 0 ? 0 : stockValue / available;
    await client.query(
      'UPDATE product_purchases SET purchase_date = $1, updated_at = NOW() WHERE id = $2',
      [purchaseDate, purchaseId]
    );
    await client.query(
      'UPDATE purchase_items SET quantity = $1, unit_cost = $2 WHERE id = $3',
      [quantity, unitCost, purchase.item_id]
    );
    await client.query(
      `UPDATE stock_movements SET quantity_delta = $1, unit_cost = $2, occurred_at = $3 WHERE id = $4`,
      [quantity, unitCost, purchaseDate, movement.rows[0].id]
    );
    await client.query(
      'UPDATE products SET quantity_on_hand = $1, average_cost = $2, updated_at = NOW() WHERE id = $3',
      [available, averageCost, purchase.product_id]
    );
    await client.query(
      `UPDATE transactions SET amount = $1, occurred_at = $2,
         description = $3 WHERE product_purchase_id = $4`,
      [total, purchaseDate, `${quantity} ${purchase.name} purchased`, purchaseId]
    );
    await client.query('COMMIT');
    res.json({ id: purchaseId, quantity, buyingPrice: unitCost, totalAmount: total });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not update product purchase:', error);
    res.status(500).json({ error: 'The purchase could not be updated.' });
  } finally {
    client.release();
  }
});

app.delete('/api/product-purchases/:id', async (req: Request, res: Response) => {
  const purchaseId = Number(req.params.id);
  if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
    res.status(400).json({ error: 'Invalid purchase ID.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT pp.id, pp.purchase_date, pi.id AS item_id, pi.product_id, pi.quantity, pi.unit_cost,
         p.quantity_on_hand, p.average_cost
       FROM product_purchases pp
       JOIN purchase_items pi ON pi.purchase_id = pp.id
       JOIN products p ON p.id = pi.product_id
       WHERE pp.id = $1 AND pp.status = 'received'
       FOR UPDATE OF pp, pi, p`,
      [purchaseId]
    );
    const purchase = found.rows[0];
    if (!purchase) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Received purchase not found.' });
      return;
    }
    const laterStockActivity = await client.query(
      `SELECT 1 FROM stock_movements
       WHERE product_id = $1 AND movement_type <> 'purchase' AND occurred_at >= $2 LIMIT 1`,
      [purchase.product_id, purchase.purchase_date]
    );
    if (laterStockActivity.rowCount || Number(purchase.quantity_on_hand) < Number(purchase.quantity)) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Purchase cannot be deleted after later stock activity.' });
      return;
    }
    const newQuantity = Number(purchase.quantity_on_hand) - Number(purchase.quantity);
    const stockValue = Number(purchase.quantity_on_hand) * Number(purchase.average_cost)
      - Number(purchase.quantity) * Number(purchase.unit_cost);
    if (stockValue < -0.01) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Purchase cannot be deleted because it would make inventory valuation invalid.' });
      return;
    }
    await client.query('UPDATE supplier_payments SET purchase_id = NULL WHERE purchase_id = $1', [purchaseId]);
    await client.query('DELETE FROM transactions WHERE product_purchase_id = $1', [purchaseId]);
    await client.query('DELETE FROM stock_movements WHERE purchase_item_id = $1', [purchase.item_id]);
    await client.query('DELETE FROM purchase_items WHERE id = $1', [purchase.item_id]);
    await client.query('DELETE FROM product_purchases WHERE id = $1', [purchaseId]);
    await client.query(
      `UPDATE products SET quantity_on_hand = $1, average_cost = $2, updated_at = NOW() WHERE id = $3`,
      [newQuantity, newQuantity === 0 ? 0 : Math.max(0, stockValue) / newQuantity, purchase.product_id]
    );
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not delete product purchase:', error);
    res.status(500).json({ error: 'The purchase could not be deleted.' });
  } finally {
    client.release();
  }
});

app.post('/api/sales', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const productId = Number(body.productId);
  const quantity = Number(body.quantity);
  const unitPrice = Number(body.unitPrice);
  const date = String(body.date ?? new Date().toISOString().slice(0, 10));

  if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity <= 0
    || !Number.isFinite(unitPrice) || unitPrice <= 0 || !isValidDate(date)) {
    res.status(400).json({ error: 'A product, positive whole-number quantity, and positive sale price are required.' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      'SELECT id, name, quantity_on_hand, average_cost FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE',
      [productId]
    );
    const product = selected.rows[0];
    if (!product) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    if (Number(product.quantity_on_hand) < quantity) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Not enough stock available for this sale.' });
      return;
    }

    const total = quantity * unitPrice;
    const cost = Number(product.average_cost);
    const saleDate = new Date(`${date}T00:00:00.000Z`);
    const saleResult = await client.query(
      `INSERT INTO sales (sale_date, status, notes) VALUES ($1, 'completed', $2) RETURNING id`,
      [saleDate, String(body.notes ?? '') || null]
    );
    const saleId = Number(saleResult.rows[0].id);
    const itemResult = await client.query(
      `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost_at_sale)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [saleId, productId, quantity, unitPrice, cost]
    );
    const itemId = Number(itemResult.rows[0].id);
    await client.query(
      `UPDATE products SET quantity_on_hand = quantity_on_hand - $1, updated_at = NOW() WHERE id = $2`,
      [quantity, productId]
    );
    await client.query(
      `INSERT INTO stock_movements (product_id, movement_type, quantity_delta, unit_cost, sale_item_id, occurred_at)
       VALUES ($1, 'sale', $2, $3, $4, $5)`,
      [productId, -quantity, cost, itemId, saleDate]
    );
    await client.query(
      `INSERT INTO transactions (event_type, amount, cash_impact, occurred_at, description, sale_id)
       VALUES ('sale', $1, $1, $2, $3, $4)`,
      [total, saleDate, `${quantity} ${product.name} sold`, saleId]
    );
    await client.query('COMMIT');
    res.status(201).json({ id: saleId, productId, quantity, revenue: total, costOfGoodsSold: quantity * cost });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not record sale:', error);
    res.status(500).json({ error: 'Sale could not be recorded.' });
  } finally {
    client.release();
  }
});

app.get('/api/sales', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.sale_date, s.status, si.id AS item_id, si.product_id, p.name AS product,
         si.quantity, si.unit_price, si.unit_cost_at_sale, si.line_total, si.cost_total
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.id
       JOIN products p ON p.id = si.product_id
       ORDER BY s.sale_date DESC, s.id DESC`
    );
    res.json(result.rows.map((row) => ({
      id: Number(row.id),
      date: new Date(row.sale_date).toISOString().slice(0, 10),
      status: row.status,
      itemId: Number(row.item_id),
      productId: Number(row.product_id),
      product: row.product,
      quantity: Number(row.quantity),
      unitPrice: Number(row.unit_price),
      unitCost: Number(row.unit_cost_at_sale),
      revenue: Number(row.line_total),
      cost: Number(row.cost_total)
    })));
  } catch (error) {
    console.error('Could not load sales:', error);
    res.status(500).json({ error: 'Unable to load sales.' });
  }
});

app.put('/api/sales/:id', async (req: Request, res: Response) => {
  const saleId = Number(req.params.id);
  const productId = Number(req.body?.productId);
  const quantity = Number(req.body?.quantity);
  const unitPrice = Number(req.body?.unitPrice);
  const date = String(req.body?.date ?? '');
  if (!Number.isInteger(saleId) || saleId <= 0 || !Number.isInteger(productId) || productId <= 0
    || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0 || !isValidDate(date)) {
    res.status(400).json({ error: 'Provide a valid sale, product, positive quantity and price, and date.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saleResult = await client.query(
      `SELECT s.id, si.id AS item_id, si.product_id AS old_product_id, si.quantity AS old_quantity
       FROM sales s JOIN sale_items si ON si.sale_id = s.id
       WHERE s.id = $1 AND s.status = 'completed'
       FOR UPDATE OF s, si`,
      [saleId]
    );
    const sale = saleResult.rows[0];
    if (!sale) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Completed sale not found.' });
      return;
    }

    const lockedProducts = await client.query(
      `SELECT id, name, is_active, quantity_on_hand, average_cost FROM products
       WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [[Number(sale.old_product_id), productId]]
    );
    const oldProduct = lockedProducts.rows.find((row) => Number(row.id) === Number(sale.old_product_id));
    const newProduct = lockedProducts.rows.find((row) => Number(row.id) === productId);
    if (!newProduct || !newProduct.is_active) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Active product not found.' });
      return;
    }
    const available = Number(newProduct.quantity_on_hand)
      + (productId === Number(sale.old_product_id) ? Number(sale.old_quantity) : 0);
    if (available < quantity) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Not enough stock available for this sale.' });
      return;
    }
    if (productId !== Number(sale.old_product_id)) {
      await client.query(
        'UPDATE products SET quantity_on_hand = quantity_on_hand + $1, updated_at = NOW() WHERE id = $2',
        [sale.old_quantity, sale.old_product_id]
      );
    }
    const unitCost = Number(newProduct.average_cost);
    const total = quantity * unitPrice;
    const saleDate = new Date(`${date}T00:00:00.000Z`);
    await client.query(
      'UPDATE products SET quantity_on_hand = $1, updated_at = NOW() WHERE id = $2',
      [available - quantity, productId]
    );
    await client.query(
      `UPDATE sales SET sale_date = $1, notes = $2 WHERE id = $3`,
      [saleDate, String(req.body?.notes ?? '') || null, saleId]
    );
    await client.query(
      `UPDATE sale_items SET product_id = $1, quantity = $2, unit_price = $3, unit_cost_at_sale = $4 WHERE id = $5`,
      [productId, quantity, unitPrice, unitCost, sale.item_id]
    );
    await client.query(
      `UPDATE stock_movements SET product_id = $1, quantity_delta = $2, unit_cost = $3, occurred_at = $4
       WHERE sale_item_id = $5`,
      [productId, -quantity, unitCost, saleDate, sale.item_id]
    );
    await client.query(
      `UPDATE transactions SET amount = $1, cash_impact = $1, occurred_at = $2, description = $3
       WHERE sale_id = $4`,
      [total, saleDate, `${quantity} ${newProduct.name} sold`, saleId]
    );
    await client.query('COMMIT');
    res.json({ id: saleId, productId, quantity, revenue: total, costOfGoodsSold: quantity * unitCost });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not update sale:', error);
    res.status(500).json({ error: 'Sale could not be updated.' });
  } finally {
    client.release();
  }
});

app.delete('/api/sales/:id', async (req: Request, res: Response) => {
  const saleId = Number(req.params.id);
  if (!Number.isInteger(saleId) || saleId <= 0) {
    res.status(400).json({ error: 'Invalid sale ID.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT s.id, si.id AS item_id, si.product_id, si.quantity
       FROM sales s JOIN sale_items si ON si.sale_id = s.id
       WHERE s.id = $1 AND s.status = 'completed'
       FOR UPDATE OF s, si`,
      [saleId]
    );
    const sale = found.rows[0];
    if (!sale) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Completed sale not found.' });
      return;
    }
    await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [sale.product_id]);
    await client.query(
      'UPDATE products SET quantity_on_hand = quantity_on_hand + $1, updated_at = NOW() WHERE id = $2',
      [sale.quantity, sale.product_id]
    );
    await client.query('DELETE FROM transactions WHERE sale_id = $1', [saleId]);
    await client.query('DELETE FROM stock_movements WHERE sale_item_id = $1', [sale.item_id]);
    await client.query('DELETE FROM sale_items WHERE id = $1', [sale.item_id]);
    await client.query('DELETE FROM sales WHERE id = $1', [saleId]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not delete sale:', error);
    res.status(500).json({ error: 'Sale could not be deleted.' });
  } finally {
    client.release();
  }
});

app.get('/api/suppliers', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, name FROM suppliers WHERE is_active = TRUE ORDER BY lower(name), id'
    );
    res.json(result.rows.map((row) => ({ id: Number(row.id), name: row.name })));
  } catch (error) {
    console.error('Could not load suppliers:', error);
    res.status(500).json({ error: 'Unable to load suppliers.' });
  }
});

app.post('/api/suppliers', async (req: Request, res: Response) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'Supplier name is required.' });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO suppliers (name, phone, email, address)
       VALUES ($1, $2, $3, $4) RETURNING id, name, phone, email, address`,
      [name, req.body?.phone ?? null, req.body?.email ?? null, req.body?.address ?? null]
    );
    res.status(201).json({ ...result.rows[0], id: Number(result.rows[0].id) });
  } catch (error) {
    console.error('Could not create supplier:', error);
    res.status(409).json({ error: 'Supplier could not be saved. Check that its name is unique.' });
  }
});

app.put('/api/suppliers/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name ?? '').trim();
  if (!Number.isInteger(id) || id <= 0 || !name) {
    res.status(400).json({ error: 'Provide a valid supplier ID and name.' });
    return;
  }
  try {
    const result = await pool.query(
      `UPDATE suppliers SET name = $1, phone = $2, email = $3, address = $4, updated_at = NOW()
       WHERE id = $5 RETURNING id, name, phone, email, address`,
      [name, req.body?.phone ?? null, req.body?.email ?? null, req.body?.address ?? null, id]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'Supplier not found.' });
      return;
    }
    res.json({ ...result.rows[0], id: Number(result.rows[0].id) });
  } catch (error) {
    console.error('Could not update supplier:', error);
    res.status(409).json({ error: 'Supplier could not be updated. Check that its name is unique.' });
  }
});

app.delete('/api/suppliers/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid supplier ID.' });
    return;
  }
  try {
    const result = await pool.query(
      `DELETE FROM suppliers s WHERE s.id = $1
       AND NOT EXISTS (SELECT 1 FROM product_purchases WHERE supplier_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM supplier_payments WHERE supplier_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM supplier_returns WHERE supplier_id = s.id)
       RETURNING s.id`,
      [id]
    );
    if (result.rowCount) {
      res.status(204).end();
      return;
    }
    const exists = await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [id]);
    res.status(exists.rowCount ? 409 : 404).json({
      error: exists.rowCount ? 'Supplier has financial or purchase history and cannot be deleted.' : 'Supplier not found.'
    });
  } catch (error) {
    console.error('Could not delete supplier:', error);
    res.status(500).json({ error: 'Supplier could not be deleted.' });
  }
});

app.post('/api/supplier-returns', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const supplierId = Number(body.supplierId);
  const productId = Number(body.productId);
  const purchaseId = body.purchaseId ? Number(body.purchaseId) : null;
  const quantity = Number(body.quantity);
  const settlementType = String(body.settlementType ?? '');
  const date = String(body.date ?? new Date().toISOString().slice(0, 10));

  if (!Number.isInteger(supplierId) || !Number.isInteger(productId) || !Number.isInteger(quantity) || quantity <= 0
    || !['supplier_credit', 'cash_refund'].includes(settlementType) || !isValidDate(date)
    || (purchaseId !== null && !Number.isInteger(purchaseId))) {
    res.status(400).json({ error: 'Provide a supplier, product, positive quantity, valid settlement type, and date.' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const productResult = await client.query(
      'SELECT id, name, quantity_on_hand, average_cost FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );
    const product = productResult.rows[0];
    if (!product || Number(product.quantity_on_hand) < quantity) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Product not found or return quantity exceeds available stock.' });
      return;
    }

    if (purchaseId !== null) {
      const purchase = await client.query(
        'SELECT id FROM product_purchases WHERE id = $1 AND supplier_id = $2 AND status = $3',
        [purchaseId, supplierId, 'received']
      );
      if (!purchase.rowCount) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'The selected purchase does not belong to this supplier.' });
        return;
      }
    }
    const supplier = await client.query('SELECT id FROM suppliers WHERE id = $1', [supplierId]);
    if (!supplier.rowCount) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'The selected supplier does not exist.' });
      return;
    }

    const unitCost = Number(body.unitCost ?? product.average_cost);
    const amount = Number(body.amount ?? unitCost * quantity);
    if (!Number.isFinite(unitCost) || unitCost < 0 || !Number.isFinite(amount) || amount <= 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Return unit cost and amount must be valid non-negative values.' });
      return;
    }
    const returnDate = new Date(`${date}T00:00:00.000Z`);
    const returned = await client.query(
      `INSERT INTO supplier_returns (supplier_id, purchase_id, product_id, quantity, unit_cost, settlement_type, amount, return_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [supplierId, purchaseId, productId, quantity, unitCost, settlementType, amount, returnDate, body.notes ?? null]
    );
    const returnId = Number(returned.rows[0].id);
    await client.query(
      'UPDATE products SET quantity_on_hand = quantity_on_hand - $1, updated_at = NOW() WHERE id = $2',
      [quantity, productId]
    );
    await client.query(
      `INSERT INTO stock_movements (product_id, movement_type, quantity_delta, unit_cost, supplier_return_id, occurred_at)
       VALUES ($1, 'supplier_return', $2, $3, $4, $5)`,
      [productId, -quantity, Number(product.average_cost), returnId, returnDate]
    );
    const cashImpact = settlementType === 'cash_refund' ? amount : 0;
    await client.query(
      `INSERT INTO transactions (event_type, amount, cash_impact, occurred_at, description, supplier_return_id)
       VALUES ('supplier_return', $1, $2, $3, $4, $5)`,
      [amount, cashImpact, returnDate, `${quantity} ${product.name} returned to supplier`, returnId]
    );
    await client.query('COMMIT');
    res.status(201).json({ id: returnId, amount, settlementType });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not record supplier return:', error);
    res.status(500).json({ error: 'The supplier return could not be saved.' });
  } finally {
    client.release();
  }
});

app.get('/api/supplier-returns', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT sr.*, su.name AS supplier, p.name AS product, t.id AS transaction_id
       FROM supplier_returns sr
       JOIN suppliers su ON su.id = sr.supplier_id
       JOIN products p ON p.id = sr.product_id
       LEFT JOIN transactions t ON t.supplier_return_id = sr.id
       ORDER BY sr.return_date DESC, sr.id DESC`
    );
    res.json(result.rows.map((row) => ({
      id: Number(row.id),
      transactionId: Number(row.transaction_id),
      supplierId: Number(row.supplier_id),
      supplier: row.supplier,
      productId: Number(row.product_id),
      product: row.product,
      purchaseId: row.purchase_id === null ? null : Number(row.purchase_id),
      quantity: Number(row.quantity),
      unitCost: Number(row.unit_cost),
      amount: Number(row.amount),
      settlementType: row.settlement_type,
      date: new Date(row.return_date).toISOString().slice(0, 10),
      notes: row.notes
    })));
  } catch (error) {
    console.error('Could not load supplier returns:', error);
    res.status(500).json({ error: 'Unable to load supplier returns.' });
  }
});

app.put('/api/supplier-returns/:id', async (req: Request, res: Response) => {
  const returnId = Number(req.params.id);
  const supplierId = Number(req.body?.supplierId);
  const quantity = Number(req.body?.quantity);
  const unitCost = Number(req.body?.unitCost);
  const amount = Number(req.body?.amount);
  const settlementType = String(req.body?.settlementType ?? '');
  const date = String(req.body?.date ?? '');
  if (!Number.isInteger(returnId) || returnId <= 0 || !Number.isInteger(supplierId) || supplierId <= 0
    || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0
    || !Number.isFinite(amount) || amount <= 0 || !['supplier_credit', 'cash_refund'].includes(settlementType)
    || !isValidDate(date)) {
    res.status(400).json({ error: 'Provide a valid supplier return with positive quantity and amount, cost, settlement type, and date.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT sr.*, sm.id AS movement_id, p.name, p.quantity_on_hand
       FROM supplier_returns sr
       JOIN stock_movements sm ON sm.supplier_return_id = sr.id
       JOIN products p ON p.id = sr.product_id
       WHERE sr.id = $1 FOR UPDATE OF sr, sm, p`,
      [returnId]
    );
    const item = found.rows[0];
    if (!item) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Supplier return not found.' });
      return;
    }
    const supplier = await client.query('SELECT id FROM suppliers WHERE id = $1', [supplierId]);
    if (!supplier.rowCount) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'The selected supplier does not exist.' });
      return;
    }
    if (item.purchase_id) {
      const purchase = await client.query(
        'SELECT id FROM product_purchases WHERE id = $1 AND supplier_id = $2',
        [item.purchase_id, supplierId]
      );
      if (!purchase.rowCount) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Selected supplier does not match the linked purchase.' });
        return;
      }
    }
    const available = Number(item.quantity_on_hand) + Number(item.quantity) - quantity;
    if (available < 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Return quantity exceeds available stock.' });
      return;
    }
    const returnDate = new Date(`${date}T00:00:00.000Z`);
    await client.query(
      `UPDATE supplier_returns SET supplier_id = $1, quantity = $2, unit_cost = $3,
         amount = $4, settlement_type = $5, return_date = $6, notes = $7 WHERE id = $8`,
      [supplierId, quantity, unitCost, amount, settlementType, returnDate, req.body?.notes ?? null, returnId]
    );
    await client.query(
      'UPDATE products SET quantity_on_hand = $1, updated_at = NOW() WHERE id = $2',
      [available, item.product_id]
    );
    await client.query(
      `UPDATE stock_movements SET quantity_delta = $1, occurred_at = $2 WHERE id = $3`,
      [-quantity, returnDate, item.movement_id]
    );
    await client.query(
      `UPDATE transactions SET amount = $1, cash_impact = $2, occurred_at = $3, description = $4
       WHERE supplier_return_id = $5`,
      [amount, settlementType === 'cash_refund' ? amount : 0, returnDate, `${quantity} ${item.name} returned to supplier`, returnId]
    );
    await client.query('COMMIT');
    res.json({ id: returnId, quantity, amount, settlementType });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not update supplier return:', error);
    res.status(500).json({ error: 'The supplier return could not be updated.' });
  } finally {
    client.release();
  }
});

app.post('/api/stock-adjustments', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const productId = Number(body.productId);
  const quantityDelta = Number(body.quantityDelta);
  const requestedUnitCost = Number(body.unitCost ?? 0);
  if (!Number.isInteger(productId) || !Number.isInteger(quantityDelta) || quantityDelta === 0
    || !Number.isFinite(requestedUnitCost) || requestedUnitCost < 0) {
    res.status(400).json({ error: 'Provide a product, non-zero whole-number stock adjustment, and valid unit cost.' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT id, quantity_on_hand, average_cost FROM products WHERE id = $1 FOR UPDATE',
      [productId]
    );
    const product = result.rows[0];
    if (!product || Number(product.quantity_on_hand) + quantityDelta < 0) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Product not found or adjustment would make stock negative.' });
      return;
    }

    const currentQuantity = Number(product.quantity_on_hand);
    const currentCost = Number(product.average_cost);
    const unitCost = quantityDelta > 0 ? requestedUnitCost : currentCost;
    await client.query(
      `UPDATE products
       SET quantity_on_hand = quantity_on_hand + $1,
           average_cost = CASE
             WHEN $1 > 0 AND quantity_on_hand > 0
               THEN ((quantity_on_hand * average_cost) + ($1 * $2)) / (quantity_on_hand + $1)
             WHEN $1 > 0 THEN $2
             ELSE average_cost
           END,
           updated_at = NOW()
       WHERE id = $3`,
      [quantityDelta, unitCost, productId]
    );
    await client.query(
      `INSERT INTO stock_movements (product_id, movement_type, quantity_delta, unit_cost)
       VALUES ($1, 'adjustment', $2, $3)`,
      [productId, quantityDelta, unitCost]
    );
    await client.query('COMMIT');
    res.status(201).json({ productId, quantityOnHand: currentQuantity + quantityDelta });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not adjust stock:', error);
    res.status(500).json({ error: 'The stock adjustment could not be saved.' });
  } finally {
    client.release();
  }
});

app.get('/api/stock-movements', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT sm.id, sm.product_id, p.name AS product, sm.movement_type, sm.quantity_delta,
         sm.unit_cost, sm.occurred_at
       FROM stock_movements sm JOIN products p ON p.id = sm.product_id
       ORDER BY sm.occurred_at DESC, sm.id DESC`
    );
    res.json(result.rows.map((row) => ({
      id: Number(row.id),
      productId: Number(row.product_id),
      product: row.product,
      movementType: row.movement_type,
      quantityDelta: Number(row.quantity_delta),
      unitCost: Number(row.unit_cost),
      date: new Date(row.occurred_at).toISOString()
    })));
  } catch (error) {
    console.error('Could not load stock movements:', error);
    res.status(500).json({ error: 'Unable to load stock movements.' });
  }
});

app.put('/api/stock-adjustments/:id', async (req: Request, res: Response) => {
  const movementId = Number(req.params.id);
  const quantityDelta = Number(req.body?.quantityDelta);
  const requestedCost = Number(req.body?.unitCost ?? 0);
  if (!Number.isInteger(movementId) || movementId <= 0 || !Number.isInteger(quantityDelta) || quantityDelta === 0
    || !Number.isFinite(requestedCost) || requestedCost < 0) {
    res.status(400).json({ error: 'Provide a valid movement ID, non-zero whole-number adjustment, and non-negative cost.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const movementResult = await client.query(
      `SELECT id, product_id, quantity_delta, unit_cost FROM stock_movements
       WHERE id = $1 AND movement_type = 'adjustment' FOR UPDATE`,
      [movementId]
    );
    const movement = movementResult.rows[0];
    if (!movement) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Stock adjustment not found.' });
      return;
    }
    const productResult = await client.query(
      'SELECT quantity_on_hand, average_cost FROM products WHERE id = $1 FOR UPDATE',
      [movement.product_id]
    );
    const product = productResult.rows[0];
    const currentQuantity = Number(product.quantity_on_hand);
    const oldDelta = Number(movement.quantity_delta);
    const quantityAfterUndo = currentQuantity - oldDelta;
    if (quantityAfterUndo < 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'This adjustment cannot be changed because the stock is no longer available.' });
      return;
    }
    const valueAfterUndo = oldDelta > 0
      ? currentQuantity * Number(product.average_cost) - oldDelta * Number(movement.unit_cost)
      : quantityAfterUndo * Number(product.average_cost);
    if (valueAfterUndo < -0.01 || quantityAfterUndo + quantityDelta < 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Adjustment would make stock quantity or valuation invalid.' });
      return;
    }
    const averageAfterUndo = quantityAfterUndo === 0 ? 0 : Math.max(0, valueAfterUndo) / quantityAfterUndo;
    const unitCost = quantityDelta > 0 ? requestedCost : averageAfterUndo;
    const nextQuantity = quantityAfterUndo + quantityDelta;
    const nextAverage = nextQuantity === 0 ? 0 : quantityDelta > 0
      ? (quantityAfterUndo * averageAfterUndo + quantityDelta * unitCost) / nextQuantity
      : averageAfterUndo;
    await client.query(
      'UPDATE products SET quantity_on_hand = $1, average_cost = $2, updated_at = NOW() WHERE id = $3',
      [nextQuantity, nextAverage, movement.product_id]
    );
    await client.query(
      'UPDATE stock_movements SET quantity_delta = $1, unit_cost = $2 WHERE id = $3',
      [quantityDelta, unitCost, movementId]
    );
    await client.query('COMMIT');
    res.json({ id: movementId, quantityOnHand: nextQuantity });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not update stock adjustment:', error);
    res.status(500).json({ error: 'The stock adjustment could not be updated.' });
  } finally {
    client.release();
  }
});

app.delete('/api/stock-adjustments/:id', async (req: Request, res: Response) => {
  const movementId = Number(req.params.id);
  if (!Number.isInteger(movementId) || movementId <= 0) {
    res.status(400).json({ error: 'Invalid stock adjustment ID.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const movementResult = await client.query(
      `SELECT id, product_id, quantity_delta, unit_cost FROM stock_movements
       WHERE id = $1 AND movement_type = 'adjustment' FOR UPDATE`,
      [movementId]
    );
    const movement = movementResult.rows[0];
    if (!movement) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Stock adjustment not found.' });
      return;
    }
    const productResult = await client.query(
      'SELECT quantity_on_hand, average_cost FROM products WHERE id = $1 FOR UPDATE',
      [movement.product_id]
    );
    const product = productResult.rows[0];
    const currentQuantity = Number(product.quantity_on_hand);
    const delta = Number(movement.quantity_delta);
    const quantity = currentQuantity - delta;
    const value = delta > 0
      ? currentQuantity * Number(product.average_cost) - delta * Number(movement.unit_cost)
      : quantity * Number(product.average_cost);
    if (quantity < 0 || value < -0.01) {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'This adjustment cannot be deleted because the stock is no longer available.' });
      return;
    }
    await client.query(
      'UPDATE products SET quantity_on_hand = $1, average_cost = $2, updated_at = NOW() WHERE id = $3',
      [quantity, quantity === 0 ? 0 : Math.max(0, value) / quantity, movement.product_id]
    );
    await client.query('DELETE FROM stock_movements WHERE id = $1', [movementId]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not delete stock adjustment:', error);
    res.status(500).json({ error: 'The stock adjustment could not be deleted.' });
  } finally {
    client.release();
  }
});

app.post('/api/transactions', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const allowedTypes = new Set(['investment', 'income', 'expense', 'supplier_payment', 'withdrawal', 'adjustment']);
  const type = String(body.type ?? '');
  const amount = Number(body.amount);
  const date = String(body.date ?? new Date().toISOString().slice(0, 10));
  const description = String(body.description ?? '').trim();

  if (!allowedTypes.has(type) || !Number.isFinite(amount) || amount === 0 || !isValidDate(date) || !description) {
    res.status(400).json({ error: 'Provide a valid transaction type, non-zero amount, date, and description.' });
    return;
  }
  if (type === 'supplier_payment' && !Number.isInteger(Number(body.supplierId))) {
    res.status(400).json({ error: 'Select a supplier for this payment.' });
    return;
  }
  const signedAmount = ['expense', 'supplier_payment', 'withdrawal'].includes(type)
    ? -Math.abs(amount)
    : type === 'investment' || type === 'income' ? Math.abs(amount) : amount;
  const occurredAt = new Date(`${date}T00:00:00.000Z`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let transaction;
    if (type === 'investment' || type === 'income' || type === 'withdrawal' || type === 'adjustment') {
      const entryType = type === 'investment'
        ? String(body.category ?? '').toLowerCase().includes('initial') ? 'initial_contribution' : 'additional_contribution'
        : type === 'withdrawal' ? 'owner_withdrawal' : 'cash_adjustment';
      const eventType = type === 'investment' ? 'capital_contribution'
        : type === 'withdrawal' ? 'owner_withdrawal' : 'cash_adjustment';
      const capital = await client.query(
        `INSERT INTO business_capitals (entry_type, amount, occurred_at, description)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [entryType, Math.abs(signedAmount), occurredAt, description]
      );
      transaction = await client.query(
        `INSERT INTO transactions (event_type, amount, cash_impact, occurred_at, description, business_capital_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [eventType, Math.abs(signedAmount), signedAmount, occurredAt, description, capital.rows[0].id]
      );
    } else if (type === 'expense') {
      const expense = await client.query(
        `INSERT INTO expenses (category, amount, expense_date, description)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [String(body.category ?? 'Operating expense'), Math.abs(signedAmount), occurredAt, description]
      );
      transaction = await client.query(
        `INSERT INTO transactions (event_type, amount, cash_impact, occurred_at, description, expense_id)
         VALUES ('operating_expense', $1, $2, $3, $4, $5) RETURNING id`,
        [Math.abs(signedAmount), signedAmount, occurredAt, description, expense.rows[0].id]
      );
    } else {
      const supplierId = Number(body.supplierId);
      const supplier = await client.query('SELECT id FROM suppliers WHERE id = $1 AND is_active = TRUE', [supplierId]);
      if (!supplier.rowCount) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'The selected supplier does not exist.' });
        return;
      }
      const payment = await client.query(
        `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, payment_date, method, reference)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [supplierId, body.purchaseId ? Number(body.purchaseId) : null, Math.abs(signedAmount), occurredAt, body.method ?? null, body.reference ?? null]
      );
      transaction = await client.query(
        `INSERT INTO transactions (event_type, amount, cash_impact, occurred_at, description, supplier_payment_id)
         VALUES ('supplier_payment', $1, $2, $3, $4, $5) RETURNING id`,
        [Math.abs(signedAmount), signedAmount, occurredAt, description, payment.rows[0].id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: Number(transaction.rows[0].id), type, amount: signedAmount, description, date });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not save financial transaction:', error);
    res.status(500).json({ error: 'The transaction could not be saved.' });
  } finally {
    client.release();
  }
});

app.put('/api/transactions/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  const date = String(req.body?.date ?? '');
  const description = String(req.body?.description ?? '').trim();
  if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(amount) || amount === 0
    || !isValidDate(date) || !description) {
    res.status(400).json({ error: 'Provide a non-zero amount, valid date, and description.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [id]);
    const transaction = result.rows[0];
    if (!transaction) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Transaction not found.' });
      return;
    }
    if (transaction.event_type === 'inventory_purchase' || transaction.event_type === 'sale'
      || transaction.event_type === 'supplier_return') {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'Edit this record from Product Investment, Product Management, or the returns workflow.' });
      return;
    }

    const occurredAt = new Date(`${date}T00:00:00.000Z`);
    const signedAmount = transaction.event_type === 'operating_expense' || transaction.event_type === 'supplier_payment'
      || transaction.event_type === 'owner_withdrawal' ? -Math.abs(amount)
      : transaction.event_type === 'cash_adjustment' ? amount : Math.abs(amount);
    if (transaction.business_capital_id) {
      await client.query(
        'UPDATE business_capitals SET amount = $1, occurred_at = $2, description = $3 WHERE id = $4',
        [Math.abs(signedAmount), occurredAt, description, transaction.business_capital_id]
      );
    } else if (transaction.expense_id) {
      await client.query(
        'UPDATE expenses SET amount = $1, expense_date = $2, description = $3, category = $4 WHERE id = $5',
        [Math.abs(signedAmount), occurredAt, description, String(req.body?.category ?? 'Operating expense'), transaction.expense_id]
      );
    } else if (transaction.supplier_payment_id) {
      const supplierId = Number(req.body?.supplierId ?? 0);
      if (!Number.isInteger(supplierId) || supplierId <= 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'Select a valid supplier for this payment.' });
        return;
      }
      const supplier = await client.query('SELECT id FROM suppliers WHERE id = $1', [supplierId]);
      if (!supplier.rowCount) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'The selected supplier does not exist.' });
        return;
      }
      const currentPayment = await client.query(
        'SELECT purchase_id FROM supplier_payments WHERE id = $1 FOR UPDATE',
        [transaction.supplier_payment_id]
      );
      const purchaseId = currentPayment.rows[0]?.purchase_id;
      if (purchaseId) {
        const purchase = await client.query(
          `SELECT pp.supplier_id, pi.line_total FROM product_purchases pp
           JOIN purchase_items pi ON pi.purchase_id = pp.id WHERE pp.id = $1`,
          [purchaseId]
        );
        const otherPayments = await client.query(
          'SELECT COALESCE(SUM(amount), 0) AS amount FROM supplier_payments WHERE purchase_id = $1 AND id <> $2',
          [purchaseId, transaction.supplier_payment_id]
        );
        if (!purchase.rowCount || Number(purchase.rows[0].supplier_id) !== supplierId
          || Number(otherPayments.rows[0].amount) + Math.abs(signedAmount) > Number(purchase.rows[0].line_total)) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'Payment supplier or amount conflicts with the linked purchase balance.' });
          return;
        }
      }
      await client.query(
        `UPDATE supplier_payments SET supplier_id = $1, amount = $2, payment_date = $3,
          method = $4, reference = $5 WHERE id = $6`,
        [supplierId, Math.abs(signedAmount), occurredAt, req.body?.method ?? null, req.body?.reference ?? null, transaction.supplier_payment_id]
      );
    } else {
      await client.query('ROLLBACK');
      res.status(409).json({ error: 'This transaction type cannot be edited here.' });
      return;
    }
    await client.query(
      'UPDATE transactions SET amount = $1, cash_impact = $2, occurred_at = $3, description = $4 WHERE id = $5',
      [Math.abs(signedAmount), signedAmount, occurredAt, description, id]
    );
    await client.query('COMMIT');
    res.json({ id, amount: signedAmount, date, description });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not update transaction:', error);
    res.status(500).json({ error: 'The transaction could not be updated.' });
  } finally {
    client.release();
  }
});

app.delete('/api/transactions/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid transaction ID.' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [id]);
    const transaction = result.rows[0];
    if (!transaction) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Transaction not found.' });
      return;
    }
    await client.query('DELETE FROM transactions WHERE id = $1', [id]);

    if (transaction.sale_id) {
      const sale = await client.query(
        `SELECT si.id AS item_id, si.product_id, si.quantity FROM sale_items si
         WHERE si.sale_id = $1 FOR UPDATE`,
        [transaction.sale_id]
      );
      if (sale.rowCount !== 1) throw new Error('Sale does not contain exactly one editable item.');
      const item = sale.rows[0];
      await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [item.product_id]);
      await client.query(
        'UPDATE products SET quantity_on_hand = quantity_on_hand + $1, updated_at = NOW() WHERE id = $2',
        [item.quantity, item.product_id]
      );
      await client.query('DELETE FROM stock_movements WHERE sale_item_id = $1', [item.item_id]);
      await client.query('DELETE FROM sale_items WHERE id = $1', [item.item_id]);
      await client.query('DELETE FROM sales WHERE id = $1', [transaction.sale_id]);
    } else if (transaction.product_purchase_id) {
      const purchase = await client.query(
        `SELECT pp.purchase_date, pi.id AS item_id, pi.product_id, pi.quantity, pi.unit_cost,
           p.quantity_on_hand, p.average_cost
         FROM product_purchases pp
         JOIN purchase_items pi ON pi.purchase_id = pp.id
         JOIN products p ON p.id = pi.product_id
         WHERE pp.id = $1 FOR UPDATE OF pp, pi, p`,
        [transaction.product_purchase_id]
      );
      if (purchase.rowCount !== 1) throw new Error('Purchase does not contain exactly one editable item.');
      const item = purchase.rows[0];
      const sold = await client.query(
        `SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si.product_id = $1 AND s.status = 'completed' AND s.sale_date >= $2 LIMIT 1`,
        [item.product_id, item.purchase_date]
      );
      if (sold.rowCount || Number(item.quantity_on_hand) < Number(item.quantity)) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Purchase cannot be deleted after related stock has been sold or returned.' });
        return;
      }
      const nextQuantity = Number(item.quantity_on_hand) - Number(item.quantity);
      const nextValue = Number(item.quantity_on_hand) * Number(item.average_cost) - Number(item.quantity) * Number(item.unit_cost);
      if (nextValue < -0.01) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Deleting this purchase would make inventory valuation invalid.' });
        return;
      }
      await client.query('UPDATE supplier_payments SET purchase_id = NULL WHERE purchase_id = $1', [transaction.product_purchase_id]);
      await client.query('DELETE FROM stock_movements WHERE purchase_item_id = $1', [item.item_id]);
      await client.query('DELETE FROM purchase_items WHERE id = $1', [item.item_id]);
      await client.query('DELETE FROM product_purchases WHERE id = $1', [transaction.product_purchase_id]);
      await client.query(
        'UPDATE products SET quantity_on_hand = $1, average_cost = $2, updated_at = NOW() WHERE id = $3',
        [nextQuantity, nextQuantity === 0 ? 0 : Math.max(0, nextValue) / nextQuantity, item.product_id]
      );
    } else if (transaction.supplier_return_id) {
      const returned = await client.query(
        `SELECT sr.id, sr.product_id, sr.quantity, sm.unit_cost
         FROM supplier_returns sr
         JOIN stock_movements sm ON sm.supplier_return_id = sr.id
         WHERE sr.id = $1 FOR UPDATE OF sr, sm`,
        [transaction.supplier_return_id]
      );
      const item = returned.rows[0];
      if (!item) throw new Error('Supplier return source is missing.');
      const productResult = await client.query(
        'SELECT quantity_on_hand, average_cost FROM products WHERE id = $1 FOR UPDATE',
        [item.product_id]
      );
      const product = productResult.rows[0];
      const oldQuantity = Number(product.quantity_on_hand);
      const quantity = Number(item.quantity);
      const nextQuantity = oldQuantity + quantity;
      const nextAverage = nextQuantity === 0 ? 0
        : (oldQuantity * Number(product.average_cost) + quantity * Number(item.unit_cost)) / nextQuantity;
      await client.query(
        'UPDATE products SET quantity_on_hand = $1, average_cost = $2, updated_at = NOW() WHERE id = $3',
        [nextQuantity, nextAverage, item.product_id]
      );
      await client.query('DELETE FROM stock_movements WHERE supplier_return_id = $1', [transaction.supplier_return_id]);
      await client.query('DELETE FROM supplier_returns WHERE id = $1', [transaction.supplier_return_id]);
    } else if (transaction.business_capital_id) {
      await client.query('DELETE FROM business_capitals WHERE id = $1', [transaction.business_capital_id]);
    } else if (transaction.expense_id) {
      await client.query('DELETE FROM expenses WHERE id = $1', [transaction.expense_id]);
    } else if (transaction.supplier_payment_id) {
      await client.query('DELETE FROM supplier_payments WHERE id = $1', [transaction.supplier_payment_id]);
    }

    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Could not delete transaction:', error);
    res.status(500).json({ error: 'The transaction could not be deleted.' });
  } finally {
    client.release();
  }
});

app.get('/api/transactions', async (_req: Request, res: Response) => {
  res.json(await getTransactions());
});

app.get('/api/reports', async (_req: Request, res: Response) => {
  const period = String(_req.query.period ?? 'monthly');
  const selectedDate = String(_req.query.date ?? new Date().toISOString().slice(0, 10));
  if (!['daily', 'weekly', 'monthly'].includes(period)) {
    res.status(400).json({ error: 'Period must be daily, weekly, or monthly.' });
    return;
  }
  if (!isValidDate(selectedDate)) {
    res.status(400).json({ error: 'Date must use YYYY-MM-DD format.' });
    return;
  }
  const transactions = await getTransactions();
  const products = await getProducts();
  res.json(calculateFinancialReport(transactions, products, period as ReportPeriod, selectedDate));
});

initializeDatabase();

app.listen(port, () => {
  console.log(`Twin Treasure backend running on http://localhost:${port}`);
});
