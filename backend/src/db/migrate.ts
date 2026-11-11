import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set before running database migrations.');
}

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const businessTables = [
  'business_capitals',
  'products',
  'suppliers',
  'product_purchases',
  'purchase_items',
  'sales',
  'sale_items',
  'expenses',
  'supplier_payments',
  'supplier_returns',
  'transactions',
  'stock_movements'
];

const pool = new Pool({ connectionString: databaseUrl });

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [184702912]);

    const trackingTable = await client.query(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`
    );
    const hasTrackingTable = trackingTable.rows[0].exists as boolean;
    const applied = hasTrackingTable
      ? new Set<string>((await client.query('SELECT version FROM public.schema_migrations')).rows.map((row) => String(row.version)))
      : new Set<string>();

    if (!applied.has('001_create_business_schema.sql')) {
      const existing = await client.query(
        `SELECT tablename
         FROM pg_catalog.pg_tables
         WHERE schemaname = 'public'
           AND tablename = ANY($1::text[])
         ORDER BY tablename`,
        [businessTables]
      );
      if (existing.rowCount) {
        throw new Error(
          `Migration stopped without changes: existing business tables need schema review (${existing.rows.map((row) => row.tablename).join(', ')}).`
        );
      }

      const usersTable = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users'`
      );
      if (usersTable.rowCount) {
        const columns = new Set<string>(usersTable.rows.map((row) => String(row.column_name)));
        const requiredColumns = ['id', 'email', 'password_hash', 'created_at'];
        const missing = requiredColumns.filter((column) => !columns.has(column));
        if (missing.length) {
          throw new Error(
            `Migration stopped without changes: existing public.users is missing required authentication columns (${missing.join(', ')}).`
          );
        }
      }
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDirectory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    console.log('Database migrations are up to date.');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [184702912]);
    } finally {
      client.release();
    }
  }
}

runMigrations()
  .catch((error: unknown) => {
    console.error('Database migration failed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
