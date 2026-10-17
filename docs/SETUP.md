# Setup and deployment

## Local development

1. Install Node.js 22.22+ and npm.
2. Copy `.env.example` to `.env`. Set Supabase URL and publishable key only for an owner-approved project.
3. Run `npm install`, then `npm run dev`.
4. Validate with `npm run check`, `npm test`, and `npm run build`.

The marketing site and empty states work without credentials. Booking and authentication must remain unavailable until the required server/database operations are configured.
After applying the migrations and creating the initial administrator, set the booking horizon in `/admin/settings`; no appointment slots are returned before an owner-selected horizon is saved. Review the lead-time and hold-duration values there as well. Customers must sign in and save a phone number before they can reserve. Add treatment chambers from `/admin/chambers` to enable room-level allocation. Reception can book an existing account or a standalone walk-in, record consent-based WhatsApp/email notification preferences, collect cash/card/UPI, and lock a slot; all booking/payment and capacity writes are checked against Supabase.

## Supabase

Use an owner-controlled Supabase project. Authenticate the Supabase CLI locally, then run `npx supabase link --project-ref <project-ref>` and review/apply versioned migrations with `npx supabase db push`. Migration `202610170005_booking_management.sql` adds required phone enforcement and customer change operations; `202610170006_admin_reception_and_gateway.sql` adds standalone offline guests, treatment chambers, counter payment records, and the public non-secret Razorpay setting. Configure the public URL/publishable key in the site and the service-role key only in the trusted runtime. The service-role key is required for Razorpay reconciliation/refunds and signing active public media; it must never be exposed to browser code. Razorpay key ID/secret and webhook secret must be configured as server-only variables, including `RAZORPAY_ENVIRONMENT` matching the key prefix. Admin can enable/disable checkout and choose test/live mode in `/admin/settings`; the database stores only this safe metadata, never the secrets. Enable checkout only after test orders, webhook handling, and refunds have been validated. Provision initial admin identities through a trusted project owner process, never via public registration. Validate RLS and storage access in a development project before production. Schedule `select public.expire_booking_holds();` from Supabase Cron or another authenticated service-role scheduler at a short interval so stale booking and coupon holds are released. The local project URL/key are in ignored `.env.local`; they are not committed. A prior Supabase CLI link attempt reported that the authenticated account lacked project privileges, so remote migration application and RPC behavior have not been verified here.

To publish treatment visuals, use **Admin → Media** to upload an image or MP4/WebM video for its service and approve it for public display. Approved images appear on treatment cards and details; videos play on the matching treatment detail page. The service itself must also be active, and `SUPABASE_SERVICE_ROLE_KEY` must be configured server-side so private files can be served with signed URLs. Unapproved media remains private.

## Razorpay and notifications

Use Razorpay test credentials first. Keep key secret and webhook secret server-only. After deploying the endpoint, configure `payment.captured`, `payment.failed`, `refund.processed`, and `refund.failed` webhooks, and verify provider callbacks before marking a booking paid or refund processed. Admin refund requests require an authorized admin session, a captured payment, a server-checked unrefunded balance, and a request idempotency key.

Booking confirmation messages are queued after capture. Configure Resend with `EMAIL_PROVIDER_API_KEY` and `EMAIL_FROM`; configure official WhatsApp Cloud API using `WHATSAPP_PROVIDER_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, an approved `WHATSAPP_CONFIRMATION_TEMPLATE`, `WHATSAPP_TEMPLATE_LANGUAGE`, and `WHATSAPP_GRAPH_API_VERSION`. WhatsApp is only sent for accounts with an explicit opt-in and a valid phone number. Set a strong `NOTIFICATION_CRON_SECRET` and schedule an HTTP GET to `/api/cron/notifications` with `Authorization: Bearer <secret>` (for example, every minute). Provider failures do not imply delivery; inspect and reconcile failed or uncertain notifications.

## Vercel

The project is configured for Astro's Vercel adapter. Connect the existing GitHub repository, configure preview/production environment variables independently, apply reviewed Supabase migrations, deploy HTTPS, and configure provider webhooks only after the production endpoint is verified. Domain/DNS, live payments, billing and account changes require owner approval and are not performed here.
