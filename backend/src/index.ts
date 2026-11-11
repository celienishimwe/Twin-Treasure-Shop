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
       (SELECT sr.settlement_type FROM supplier_returns sr WHERE sr.id = t.supplier_return_id) AS settlement_type
     FROM transactions t
     ORDER BY t.occurred_at DESC, t.id DESC`
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    type: row.type,
    amount: Number(row.cash_impact),
    description: row.description,
    date: new Date(row.occurred_at).toISOString(),
    category: row.event_type,
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
  const otherIncome = sum(inPeriod, (item) => item.type === 'income');
  const costOfProductsSold = inPeriod
    .filter((item) => item.type === 'sale')
    .reduce((total, sale) => total + costOfSale(sale), 0);
  const grossProfit = totalSalesRevenue - costOfProductsSold;
  const netProfit = grossProfit + otherIncome - totalExpenses;
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
  if (!name || !Number.isFinite(sellingPrice) || sellingPrice < 0) {
    res.status(400).json({ error: 'A product name and non-negative selling price are required.' });
    return;
  }
  try {
    const result = await pool.query(
      `INSERT INTO products (name, selling_price)
       VALUES ($1, $2) RETURNING id, name, selling_price, quantity_on_hand, average_cost, updated_at`,
      [name, sellingPrice]
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
