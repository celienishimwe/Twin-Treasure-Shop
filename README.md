# Twin Treasure Shop Management

This project contains a Next.js frontend and Express backend with PostgreSQL support for managing business investments, stock, supplier payments, and profit reports.

## Structure

- `frontend/` - Next.js user interface
- `backend/` - Express REST API
- `docker-compose.yml` - PostgreSQL service

## Start the app

1. Start PostgreSQL:
   `docker compose up -d`
2. Copy the backend environment file:
   `Copy-Item backend/.env.example backend/.env` (PowerShell)
3. Set `DATABASE_URL` in `backend/.env` to your local `Twin-Treasure-Shop` database. Do not commit the file or share its password.
4. Install dependencies:
   `npm install`
5. Apply the tracked, additive database migrations (no business seed data is inserted):
   `npm run db:migrate --workspace backend`
6. Run the application:
   `npm run dev`
7. Open `http://localhost:3000`. On first run, create the owner account using an email and a password of at least 10 characters.

The first owner account is stored in PostgreSQL and public account setup is disabled after it is created. Backend startup does not create tables or seed sample business data; run migrations explicitly before starting the application.

Authentication uses an HTTP-only, signed session cookie. Set `SESSION_SECRET` to a private random value (at least 32 characters) and configure `FRONTEND_URL` for the deployed frontend. Production requires `SESSION_SECRET` and uses secure cookies.

## URLs

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:5000`

## Features

- Dashboard overview for business finance
- Money management and investment tracking
- Product management and stock control
- Product investment and supplier transactions
- Transaction history
- Daily, weekly, and monthly profit/loss reports
- English and Kinyarwanda interface translations with a browser-persisted language preference
- Persistent dark/light theme selection
- Tailwind CSS utilities configured for the frontend (existing CSS reset is preserved)
- Toast notifications for successful actions, errors, and sign-in/sign-out

## Record management

- Product Management supports product and sale create, edit, and delete operations.
- Product Investment supports purchase and supplier create, edit, and delete operations, plus supplier returns and stock adjustments.
- Money Management and Transaction History support editing and deleting financial source records; deleting a record also updates its linked ledger and stock rows in a database transaction.
- Dashboard and report pages are derived views; use the linked management menus to change their underlying data.
- Products with stock or sales/purchase history and suppliers with financial/purchase history cannot be hard-deleted. Purchases with later stock activity cannot be edited or deleted because doing so would invalidate weighted-average cost and historical stock.

## Profit and cash calculations

- Gross profit = sales revenue - cost of products sold.
- Net profit/loss = sales revenue − cost of products sold − operating expenses.
- Capital contributions and owner withdrawals affect cash, not profit. Inventory purchases add inventory and supplier payments reduce cash; product cost is counted when the item sells.
- Closing cash balance is the signed total of all recorded cash movements through the selected period's end date.

The report date picker selects a day, the week containing that date (Monday-Sunday), or its calendar month.
