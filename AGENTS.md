# Jingles POS Agent Guide

## Repository purpose

This repository is the local-first point-of-sale application. It is an npm-workspaces TypeScript monorepo:

- `packages/shared`: shared POS types and contracts.
- `packages/backend`: Express API, Prisma, local SQLite data, catalog integration, and upstream sync.
- `packages/web`: React/Vite POS interface.
- `packages/electron`: desktop runtime, device settings, backups, local API process, and packaging.

Read `POS_DATABASE_STRUCTURE_REFERENCE.md` and the relevant source before changing database or synchronization behavior. The separate Jingles Inventory repository is the upstream inventory system of record; keep API, identifiers, event formats, and sync behavior compatible with it.

## Working rules

- Use npm workspaces and the existing package structure. Do not introduce another package manager.
- Put cross-package contracts in `packages/shared`; do not duplicate domain types.
- Make the smallest coherent change and preserve unrelated worktree changes.
- Do not commit credentials, sync tokens, database URLs, runtime SQLite databases, backups, logs, or build artifacts.
- Do not add or upgrade production dependencies without explaining the need and packaging impact.
- Use Context7 when current third-party library documentation is needed.
- DBHub is for read-only development diagnostics. Never use it to mutate data or schema.

## POS invariants

- A completed sale must keep the sale header, lines, payments, inventory events, totals, and sync event consistent.
- Returns, refunds, shift cash counts, vouchers, and held-sale restoration must preserve their existing authorization and audit behavior.
- Validate branch, terminal, user, shift, product, price, stock, and tender state at the service boundary; do not rely only on UI validation.
- Preserve established currency rounding behavior and add tests for discounts, tax, tendered amount, change, refunds, and margin calculations.
- Upstream and offline operations must be idempotent, ordered where required, replay-safe, and conflict-visible.
- Treat sync events and conflict history as append-only unless an existing documented maintenance workflow explicitly says otherwise.
- Keep the desktop local API bound and configured as designed; do not expose it to the network without an explicit security review.

## Database and migrations

- `packages/backend/prisma/schema.prisma` is the canonical POS SQLite schema.
- Create a new migration for schema changes. Never rewrite an applied migration.
- Never run `prisma migrate reset`, `db:reset`, drop tables, truncate data, or delete/replace a runtime database without explicit user approval and a verified backup/target.
- Review generated SQL before applying a migration. Account for existing installations, defaults, nullability, indexes, uniqueness, and restart/upgrade behavior.
- Preserve desktop database path configuration, backup/restore support, WAL-related files, and packaged migration assets.
- Use a transaction or the existing atomic service boundary for sale, payment, return, stock, shift, and sync mutations.
- Changes to the local schema or sync payload must be checked against the inventory repository's contract.

## Commands

Run commands from the repository root unless a command says otherwise.

```powershell
npm install
npm run build:shared
npm run build:backend
npm run build:web
npm run build:electron
npm run build:desktop
npm test
```

Targeted verification:

```powershell
npm run test:backend
npm run test:web
npm run test:electron
npm run build
```

Database commands are run in `packages/backend`:

```powershell
npm run prisma:generate
npm run prisma:migrate
npm run prisma:studio
```

Do not run `npm run db:reset` unless the user explicitly requests a destructive development reset.

## Verification expectations

- Start with the tests closest to the changed code, then run the affected workspace tests.
- Run `npm run build:desktop` for shared-contract, backend, Electron, native-module, or packaging changes.
- For schema changes, verify Prisma generation, inspect migration SQL, and test upgrading an existing database.
- For sales changes, test cash and non-cash payment, discounts, held sales, returns, stock effects, and retry/idempotency behavior.
- For sync changes, test reconnect, duplicate delivery, ordering, conflict, token failure, and upstream unavailability.
- For UI flows, prefer durable Playwright tests or existing component tests over manual-only validation.
- Report tests that were not run and the reason.

## Code review rules

- Flag any path that can produce a sale/payment/stock mismatch or bypass authorization, auditing, or transaction boundaries.
- Flag destructive migrations, unsafe runtime database replacement, unbounded queries, and non-idempotent sync changes.
- Flag secrets, production tokens, customer data, or payment details added to code, fixtures, logs, screenshots, or configuration.
- Flag changes that break packaged Electron paths, native-module rebuilding, backups, or existing database upgrades.
