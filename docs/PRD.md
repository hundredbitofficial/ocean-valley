# Ocean Valley product requirements

Source: owner-supplied Ocean Valley PRD v1.0 and V1 development quotation.

## Product

Premium, mobile-first wellness and massage appointment platform for India. Preferred stack: Astro, React, TypeScript, Tailwind, Supabase, Razorpay, GitHub and Vercel. Money is stored as integer paise; timestamps are UTC and shown in `Asia/Kolkata`.

## In scope

- Public home, about, services and service detail, offers, contact, FAQ, booking and legal pages.
- Supabase Auth customer accounts and ownership-protected booking history.
- Active services, categories, service media and add-ons from Supabase.
- Availability rules, exceptions, capacity, holds, coupon validation, booking snapshots and status history.
- Server-side Razorpay order creation and signature/webhook verification.
- Separate protected admin area, catalogue/availability/booking/coupon/settings management, reports and audit history.
- Accurate email/WhatsApp delivery state, responsive accessible UI, SEO, tests and deployment docs.

## Explicit exclusion

The quotation references accommodation and room booking; the PRD explicitly excludes accommodation, room/guest inventory, check-in/check-out, overnight stays and stay-plus-massage packages. The PRD takes precedence; this project implements **appointment bookings only**. No wallet, memberships, branches, medical claims or fake testimonials.

## Truthful content requirements

Do not invent services, prices, durations, opening hours, address/contact details, cancellation/refund promises, legal claims, credentials or testimonials. Show a clear unavailable/setup state until owner-approved database data exists.

## Owner inputs for launch

Verified catalogue and prices, hours/capacity/booking horizon, advance/balance terms, cancellation/refund terms, approved brand/media/copy, business contact/location and legal text, admin identities, Supabase project, Razorpay account, email/WhatsApp providers and deployment/domain approval.
