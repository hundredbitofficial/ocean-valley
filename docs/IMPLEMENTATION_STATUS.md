# Implementation status

## Implemented

- [x] Empty repository scaffolded with patched Astro, React, TypeScript, Tailwind and Vercel.
- [x] Responsive public site, active service/offer data reads, account/auth flows, booking UI and separate admin portal.
- [x] Public active-service API and date/status-filterable admin bookings CSV export.
- [x] Admin create/edit/activate for services, categories, add-ons, weekly availability and offers; date-specific closures/capacity overrides.
- [x] Admin-configurable booking horizon, minimum lead time and unpaid hold duration; booking availability fails closed until a horizon is set.
- [x] Private admin media upload, preview, approve/hide/remove; active service images use short-lived signed URLs.
- [x] Admin refund requests validate captured totals, record idempotency keys, and reconcile through verified Razorpay webhooks.
- [x] Admin booking status changes are transition-checked, reasoned and recorded in booking history; cancellations do not imply refunds.
- [x] Admin bookings are filterable by appointment day in India time and status; failed notifications can be manually re-queued.
- [x] Admin appointments have a searchable master table with status/date filters, guest and phone snapshots, chamber/channel, collection method, gateway ID and CSV export.
- [x] Admins can switch to an interactive chamber calendar, book walk-ins from available time slots, and lock appointment windows against all public services.
- [x] Walk-in dialog supports existing customer accounts or standalone guests, required name/phone, optional email, explicit WhatsApp consent, treatment/chamber/date/time, and full/advance/no counter collection using cash/card/UPI.
- [x] Counter collections are inserted as offline captured payment ledger records in the same Supabase transaction as the appointment; online Razorpay payments are never fabricated.
- [x] Treatment chambers have audited create/edit/archive operations and are allocated against room-level capacity for online and offline appointments.
- [x] Razorpay gateway can be enabled/disabled and set to test/live mode from admin settings; safe configuration is persisted in Supabase and credentials remain server-only, with mode mismatch checks before checkout.
- [x] Customer booking uses an accessible month calendar with live time-slot lookup, and booking requires an authenticated profile with a phone number.
- [x] Customers can cancel future confirmed appointments or reschedule through capacity-checked database RPCs; changes preserve appointment/payment history.
- [x] Admins can record offline appointments for customers with an existing phone profile; the transaction uses the same weekly hours, date exceptions and capacity as online booking, so slots disappear publicly.
- [x] Offline appointment WhatsApp confirmations are queued only for customers who opted in; configuration and delivery remain dependent on the approved provider/template and notification scheduler.
- [x] Admin settings reflect saved booking horizon, minimum lead time and hold duration; service, category, add-on and offer records can be archived without removing historical references.
- [x] New migration records booking channel and schedule-change audit history, enforces phone presence on booking inserts, and provides customer cancellation/rescheduling and admin offline-booking RPCs.
- [x] Reception and payment migration adds guest booking snapshots, chamber allocation, counter payment method ledger fields, and a non-secret public Razorpay gateway configuration setting.
- [x] Catalogue, availability, media and refund mutations produce audit records.
- [x] Supabase schema, least-privilege RLS, private media bucket, slot lookup, transactional booking hold, expiry and webhook RPCs.
- [x] Exact integer-paise quote/coupon/state logic and unit tests.
- [x] Server-side Razorpay order creation, signature verification and webhook idempotency boundary.
- [x] Queue booking confirmation email and consented WhatsApp notifications after payment confirmation; authenticated scheduled dispatcher with bounded retries.
- [x] `.env.example`, architecture, requirements, setup and deployment guidance.
- [x] Lodging scope conflict resolved per PRD: no rooms or stays.

## Remaining before launch

- [ ] Apply migrations and exercise RLS/RPC in owner-approved Supabase project.
- [ ] Configure and test Supabase Auth, admin provisioning, payment credentials and webhook delivery.
- [ ] Validate Razorpay test orders/callbacks/refunds with an owner-controlled test account.
- [ ] Replace setup copy with owner-approved catalogue, brand assets, contacts and policy copy.
- [ ] Apply and validate migrations `202610170005_booking_management.sql` and `202610170006_admin_reception_and_gateway.sql` against the owner-controlled Supabase project.
- [ ] Complete browser/accessibility/mobile QA and production deployment.

## Launch gates

Owner-supplied verified catalogue/prices, schedule/capacity, advance/cancellation/refund rules, contacts, photography, legal content, admin identities and provider accounts are required. The new migration and its RLS/RPC behavior remain unverified against the live Supabase project. No live service has been created, payment charged, migration applied or deployment performed.

## Notifications

Confirmed bookings enqueue email and, only when the customer has opted in and supplied a valid phone number, WhatsApp template messages. A GET endpoint at `/api/cron/notifications` dispatches queued messages in batches of up to 100 and requires `Authorization: Bearer <NOTIFICATION_CRON_SECRET>`. Configure a frequent external scheduler, `NOTIFICATION_CRON_SECRET`, Resend `EMAIL_PROVIDER_API_KEY` and `EMAIL_FROM`, and an approved WhatsApp template plus its provider settings. Temporary failures are retried with increasing delays (up to five attempts); permanent provider 4xx errors and exhausted retries remain failed for manual reconciliation. Delivery is at-least-once if a provider accepts a message but the subsequent database status update fails, so provider-side idempotency or reconciliation may be needed.
