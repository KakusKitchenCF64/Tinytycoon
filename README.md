# Tiny Tycoons

A UK-first multi-vendor marketplace where children and students sell products under
parent/guardian and school supervision.

This app is a **single self-contained Node.js file** (`app.js`) so it's easy to host
anywhere that runs Node — no database server, no Docker, no build step. Data is persisted
to a local `data.json` file.

## Requirements

- Node.js 18+

## Run locally

```powershell
npm install
copy .env.example .env
# edit .env: set JWT_SECRET, and Stripe keys if you want payments to work
npm start
```

Visit `http://localhost:4000`.

`npm run dev` runs the app with `node --watch` for auto-restart during development.

## Deploying / hosting

Because everything lives in `app.js` + `package.json`, you can deploy this to almost any
Node host (Render, Railway, Fly.io, a VPS, etc.):

1. Upload `app.js`, `package.json`, `package-lock.json`, and `.env.example`.
2. Set environment variables on the host (`JWT_SECRET`, `PORT`, `STRIPE_*` — see
   `.env.example`). Do not commit a real `.env` file.
3. Run `npm install --omit=dev` then `npm start`.
4. If the host has an ephemeral filesystem (e.g. some serverless/container platforms),
   note that `data.json` will reset on redeploy — use a host with persistent disk (a VPS,
   or a platform with a persistent volume) if you need data to survive deploys.

## Demo accounts (seeded automatically on first run)

| Role | Email | Password |
|---|---|---|
| Admin | admin@tinytycoons.test | Admin123! |
| Buyer | buyer@tinytycoons.test | Buyer123! |
| Individual creator | saban@tinytycoons.test | Creator123! |
| Guardian | guardian@tinytycoons.test | Guardian123! |
| Org coordinator | coordinator@younghigh.test | OrgOwner123! |

## Architecture notes

- **Storage**: All data (users, stores, products, orders, messages, etc.) lives in
  `data.json`, read/written synchronously on each mutation. This is fine for a small
  marketplace/demo but is not safe for high concurrent write volume — see "Known
  limitations" below.
- **Auth**: JWT stored in an httpOnly, SameSite=Lax cookie (`tt_token`), verified on each
  request via middleware.
- **Payments**: Stripe Connect. When `STRIPE_SECRET_KEY` is set, checkout creates a
  PaymentIntent and, on success, transfers each seller's share to their connected account.
  Without Stripe keys configured, checkout is disabled but the rest of the app still runs.
- **Commission**: Configurable by admins from `/dashboard/admin`, with optional per-store
  overrides.
- **Guardian/consent model**: Individual creator registration links a guardian account,
  records consent, and creates the store inactive pending admin approval.
- **Messaging safety**: Messages are scanned for email/phone patterns and flagged (not
  blocked) for moderator review.
- **Product moderation**: Products flow through `draft → pending_review →
  approved/rejected/suspended`.

## Known limitations / production-hardening TODOs

1. **File-based storage**: `data.json` is read/written on every request that mutates
   state. This works for low-to-moderate traffic but has no transactional guarantees
   under concurrent writes and won't scale horizontally (multiple server instances would
   fight over the same file). For real production scale, migrate to a proper database.
2. **Email**: Notification emails are logged to the console instead of sent via a real
   provider.
3. **Image uploads**: Product/store images are plain URL strings; production needs real
   file upload handling with validation.
4. **Compliance**: Full legal/compliance review is required before real-world launch,
   including UK GDPR, the ICO Children's Code, and a Data Protection Impact Assessment
   (DPIA).
5. **Content moderation**: Messaging safety uses a simple regex-based contact-detail
   filter; consider a more robust filter or moderation service for production.

## Scripts

```powershell
npm start   # node app.js
npm run dev # node --watch app.js
```
