# Architecture

- Astro server-rendered app with the Vercel adapter and React islands for client interaction.
- Shared `SiteLayout` and CSS token system; routes are organized by public, account, admin and API concerns.
- Supabase public anon access is restricted by RLS; server-only integrations use private environment variables and must not expose service-role credentials.
- SQL migrations are versioned under `supabase/migrations`. Trusted functions are `SECURITY DEFINER` only where required and explicitly authorize admins.
- Business rules for integer-paise quotes and booking state transitions live in `src/lib/booking.ts` and are unit tested. The database transaction/RPC is authoritative for reservation capacity.
- Administrator catalogue writes are validated at the server API boundary and protected by Supabase RLS; audit entries record changed field names without copying business content into audit metadata.
- Service media stays in a private Supabase Storage bucket. Admin previews use authenticated signed URLs; public pages can sign only active media associated with active services.
- Razorpay refund requests validate captured payment and outstanding refund totals, persist an idempotency key before contacting the provider, and leave uncertain provider outcomes pending for reconciliation.
- Provider absence must fail closed: no simulated booking, payment, refund or notification success.
- No accommodation or stay data model, route, UI, or availability logic exists.
