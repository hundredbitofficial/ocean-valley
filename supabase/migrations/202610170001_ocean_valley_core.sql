create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

create or replace function public.is_admin()
returns boolean
language sql stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  whatsapp_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.create_profile_for_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.create_profile_for_user();

create table public.service_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.service_categories(id) on delete set null,
  name text not null,
  slug text not null unique,
  short_description text,
  description text,
  duration_minutes integer not null check (duration_minutes > 0),
  buffer_minutes integer not null default 0 check (buffer_minutes >= 0),
  price_paise bigint not null check (price_paise >= 0),
  advance_type text not null default 'fixed' check (advance_type in ('fixed', 'percentage')),
  advance_value bigint not null default 0 check (advance_value >= 0),
  tax_rate_basis_points integer not null default 0 check (tax_rate_basis_points between 0 and 10000),
  is_active boolean not null default false,
  is_featured boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (advance_type <> 'percentage' or advance_value <= 10000)
);
create index services_public_order_idx on public.services (is_active, sort_order);

create table public.service_media (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  media_type text not null check (media_type in ('image', 'video')),
  storage_path text not null,
  alt_text text,
  caption text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_path)
);
create index service_media_public_idx on public.service_media (service_id, is_active, sort_order);

create table public.service_addons (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  name text not null,
  description text,
  price_paise bigint not null default 0 check (price_paise >= 0),
  extra_duration_minutes integer not null default 0 check (extra_duration_minutes >= 0),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index service_addons_public_idx on public.service_addons (service_id, is_active, sort_order);

create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  slot_interval_minutes integer not null check (slot_interval_minutes > 0),
  capacity integer not null check (capacity > 0),
  is_closed boolean not null default false,
  service_id uuid references public.services(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (is_closed or closes_at > opens_at)
);
create index availability_rules_day_idx on public.availability_rules (weekday, service_id);
create unique index availability_rules_default_unique_idx on public.availability_rules (weekday) where service_id is null;
create unique index availability_rules_service_unique_idx on public.availability_rules (weekday, service_id) where service_id is not null;

create table public.availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  exception_type text not null check (exception_type in ('closed', 'capacity_override')),
  capacity_override integer check (capacity_override is null or capacity_override >= 0),
  reason text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index availability_exceptions_range_idx on public.availability_exceptions using gist (tstzrange(starts_at, ends_at, '[)'));

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text,
  discount_type text not null check (discount_type in ('percentage', 'fixed')),
  discount_value bigint not null check (discount_value >= 0),
  max_discount_paise bigint check (max_discount_paise is null or max_discount_paise >= 0),
  minimum_spend_paise bigint not null default 0 check (minimum_spend_paise >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  max_per_customer integer check (max_per_customer is null or max_per_customer > 0),
  first_booking_only boolean not null default false,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (discount_type <> 'percentage' or discount_value <= 10000)
);
create unique index coupons_code_case_insensitive_idx on public.coupons (upper(code));
create index coupons_active_range_idx on public.coupons (is_active, starts_at, ends_at);

create table public.coupon_services (
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  primary key (coupon_id, service_id)
);
create table public.coupon_categories (
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  category_id uuid not null references public.service_categories(id) on delete cascade,
  primary key (coupon_id, category_id)
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default upper(replace(gen_random_uuid()::text, '-', '')),
  customer_id uuid not null references public.profiles(id) on delete restrict,
  service_id uuid not null references public.services(id) on delete restrict,
  service_name_snapshot text not null,
  duration_minutes_snapshot integer not null check (duration_minutes_snapshot > 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Asia/Kolkata',
  status text not null default 'pending_payment' check (status in ('pending_payment','confirmed','cancelled','completed','no_show','payment_failed','expired')),
  payment_status text not null default 'pending' check (payment_status in ('pending','partially_paid','paid','failed','refunded','partially_refunded')),
  subtotal_paise bigint not null check (subtotal_paise >= 0),
  discount_paise bigint not null default 0 check (discount_paise >= 0),
  tax_paise bigint not null default 0 check (tax_paise >= 0),
  total_paise bigint not null check (total_paise >= 0),
  advance_due_paise bigint not null check (advance_due_paise >= 0),
  balance_due_paise bigint not null check (balance_due_paise >= 0),
  coupon_id uuid references public.coupons(id) on delete set null,
  customer_notes text,
  cancellation_reason text,
  hold_expires_at timestamptz not null default (now() + interval '15 minutes'),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (total_paise = advance_due_paise + balance_due_paise),
  check (discount_paise <= subtotal_paise)
);
create index bookings_customer_created_idx on public.bookings (customer_id, created_at desc);
create index bookings_service_slot_idx on public.bookings (service_id, starts_at, ends_at, status);
create index bookings_hold_expiry_idx on public.bookings (hold_expires_at) where status = 'pending_payment';

create table public.booking_addons (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  addon_id uuid references public.service_addons(id) on delete set null,
  name_snapshot text not null,
  price_paise_snapshot bigint not null check (price_paise_snapshot >= 0),
  extra_duration_minutes_snapshot integer not null default 0 check (extra_duration_minutes_snapshot >= 0)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  provider text not null default 'razorpay',
  provider_order_id text unique,
  provider_payment_id text unique,
  amount_paise bigint not null check (amount_paise >= 0),
  currency text not null default 'INR' check (currency = 'INR'),
  status text not null check (status in ('created','authorized','captured','failed','refunded','partially_refunded')),
  idempotency_key text unique,
  verified_at timestamptz,
  failure_code text,
  failure_description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_booking_idx on public.payments (booking_id, created_at desc);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  provider_refund_id text unique,
  amount_paise bigint not null check (amount_paise > 0),
  reason text,
  status text not null check (status in ('pending','processed','failed')),
  initiated_by uuid references public.profiles(id) on delete set null,
  idempotency_key text not null unique default gen_random_uuid()::text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete restrict,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  discount_paise bigint not null check (discount_paise >= 0),
  status text not null check (status in ('reserved','redeemed','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index coupon_redemptions_usage_idx on public.coupon_redemptions (coupon_id, customer_id, status);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete set null,
  recipient_user_id uuid references public.profiles(id) on delete set null,
  channel text not null check (channel in ('email','whatsapp','in_app')),
  event_type text not null,
  recipient text not null,
  status text not null check (status in ('queued','sent','failed','retrying')),
  provider_message_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications (recipient_user_id, created_at desc);

create table public.booking_status_history (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  old_status text,
  new_status text not null check (new_status in ('pending_payment','confirmed','cancelled','completed','no_show','payment_failed','expired')),
  actor_user_id uuid references public.profiles(id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);
create index booking_history_booking_idx on public.booking_status_history (booking_id, created_at);

create table public.business_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  is_public boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create table public.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'razorpay',
  provider_event_id text not null unique,
  event_type text not null,
  processed_at timestamptz not null default now()
);

create or replace function public.enforce_booking_transition()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending_payment' and new.status in ('confirmed','cancelled','payment_failed','expired'))
      or (old.status = 'payment_failed' and new.status in ('pending_payment','confirmed','cancelled','expired'))
      or (old.status = 'confirmed' and new.status in ('cancelled','completed','no_show'))
    ) then
      raise exception 'Invalid booking status transition';
    end if;
    insert into public.booking_status_history (booking_id, old_status, new_status, actor_user_id, reason)
    values (new.id, old.status, new.status, auth.uid(), new.cancellation_reason);
  end if;
  new.updated_at = now();
  return new;
end
$$;
create trigger booking_status_guard before update on public.bookings
for each row execute function public.enforce_booking_transition();

create or replace function public.reserve_booking(
  p_service_id uuid,
  p_starts_at timestamptz,
  p_addon_ids uuid[] default '{}',
  p_coupon_code text default null,
  p_customer_notes text default null
)
returns table (booking_id uuid, booking_reference text, status text, hold_expires_at timestamptz, subtotal_paise bigint, discount_paise bigint, tax_paise bigint, total_paise bigint, advance_due_paise bigint, balance_due_paise bigint)
language plpgsql security definer set search_path = ''
as $$
declare
  v_service public.services%rowtype;
  v_coupon public.coupons%rowtype;
  v_rule public.availability_rules%rowtype;
  v_customer_id uuid := auth.uid();
  v_addon record;
  v_weekday integer;
  v_slot_local timestamp;
  v_duration integer;
  v_subtotal bigint;
  v_discount bigint := 0;
  v_tax bigint;
  v_total bigint;
  v_advance bigint;
  v_capacity integer;
  v_booking_horizon_days integer;
  v_minimum_lead_minutes integer := 0;
  v_hold_minutes integer := 15;
  v_booking_id uuid;
  v_reference text;
  v_hold timestamptz;
  v_coupon_id uuid;
  v_coupon_code text;
  v_redemptions integer;
begin
  if v_customer_id is null then raise exception 'Sign in is required to reserve a visit'; end if;
  select (value ->> 'days')::integer into v_booking_horizon_days
  from public.business_settings where key = 'booking_horizon_days';
  if v_booking_horizon_days is null then raise exception 'Booking horizon is not configured'; end if;
  select (value ->> 'minutes')::integer into v_minimum_lead_minutes
  from public.business_settings where key = 'minimum_lead_time_minutes';
  v_minimum_lead_minutes := coalesce(v_minimum_lead_minutes, 0);
  select (value ->> 'minutes')::integer into v_hold_minutes
  from public.business_settings where key = 'booking_hold_minutes';
  v_hold_minutes := coalesce(v_hold_minutes, 15);
  if v_booking_horizon_days not between 1 and 365
    or v_minimum_lead_minutes not between 0 and 10080
    or v_hold_minutes not between 5 and 60 then
    raise exception 'Booking settings are invalid';
  end if;
  v_hold := now() + make_interval(mins => v_hold_minutes);
  select * into v_service from public.services s
  where s.id = p_service_id and s.is_active = true
    and (s.category_id is null or exists (
      select 1 from public.service_categories c where c.id = s.category_id and c.is_active = true
    ));
  if not found then raise exception 'This service is not available'; end if;

  v_slot_local := p_starts_at at time zone 'Asia/Kolkata';
  v_weekday := extract(dow from v_slot_local)::integer;
  if p_starts_at <= now() + make_interval(mins => v_minimum_lead_minutes) then raise exception 'Choose a time after the minimum booking lead time'; end if;
  if (p_starts_at at time zone 'Asia/Kolkata')::date >
    (now() at time zone 'Asia/Kolkata')::date + v_booking_horizon_days then
    raise exception 'This appointment is outside the booking horizon';
  end if;

  if exists (
    select 1 from unnest(p_addon_ids) requested(id)
    left join public.service_addons a on a.id = requested.id and a.service_id = p_service_id and a.is_active = true
    where a.id is null
  ) then raise exception 'One or more add-ons are unavailable'; end if;

  v_duration := v_service.duration_minutes + v_service.buffer_minutes;
  v_subtotal := v_service.price_paise;
  for v_addon in
    select id, name, price_paise, extra_duration_minutes
    from public.service_addons
    where id = any(coalesce(p_addon_ids, '{}')) and service_id = p_service_id and is_active = true
  loop
    v_duration := v_duration + v_addon.extra_duration_minutes;
    v_subtotal := v_subtotal + v_addon.price_paise;
  end loop;
  if v_duration <= 0 or v_duration > 1440 then raise exception 'Appointment duration is invalid'; end if;

  select * into v_rule
  from public.availability_rules ar
  where ar.weekday = v_weekday and ar.is_closed = false
    and (ar.service_id = p_service_id or ar.service_id is null)
    and v_slot_local >= (v_slot_local::date + ar.opens_at)
    and v_slot_local + make_interval(mins => v_duration) <= (v_slot_local::date + ar.closes_at)
  order by (ar.service_id is not null) desc
  limit 1;
  if not found then raise exception 'This time is outside configured availability'; end if;
  if extract(second from v_slot_local::time) <> 0
    or mod(
      extract(epoch from (v_slot_local::time - v_rule.opens_at))::integer,
      v_rule.slot_interval_minutes * 60
    ) <> 0 then
    raise exception 'Choose an available appointment time';
  end if;

  select coalesce(min(e.capacity_override), v_rule.capacity) into v_capacity
  from public.availability_exceptions e
  where e.exception_type = 'capacity_override' and e.capacity_override is not null
    and tstzrange(e.starts_at, e.ends_at, '[)') &&
      tstzrange(p_starts_at, p_starts_at + make_interval(mins => v_duration), '[)');
  v_capacity := coalesce(v_capacity, v_rule.capacity);

  if exists (
    select 1 from public.availability_exceptions e
    where e.exception_type = 'closed'
      and tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange(p_starts_at, p_starts_at + make_interval(mins => v_duration), '[)')
  ) then raise exception 'This time is not available'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_service_id::text || ':' || (p_starts_at at time zone 'Asia/Kolkata')::date::text, 0));
  if (
    select count(*) from public.bookings b
    where b.service_id = p_service_id
      and b.starts_at < p_starts_at + make_interval(mins => v_duration)
      and b.ends_at > p_starts_at
      and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()))
  ) >= v_capacity then raise exception 'This appointment time was just taken. Choose another time.'; end if;

  if p_coupon_code is not null and length(trim(p_coupon_code)) > 0 then
    v_coupon_code := upper(trim(p_coupon_code));
    select * into v_coupon from public.coupons c
    where upper(c.code) = v_coupon_code and c.is_active = true
      and (c.starts_at is null or c.starts_at <= now())
      and (c.ends_at is null or c.ends_at > now())
    for update;
    if not found then raise exception 'This offer code is not valid'; end if;
    update public.bookings b
      set status = 'expired'
      where b.status = 'pending_payment' and b.hold_expires_at <= now()
        and exists (
          select 1 from public.coupon_redemptions r
          where r.booking_id = b.id and r.coupon_id = v_coupon.id and r.status = 'reserved'
        );
    update public.coupon_redemptions r set status = 'released', updated_at = now()
      where r.coupon_id = v_coupon.id and r.status = 'reserved'
        and exists (select 1 from public.bookings b where b.id = r.booking_id and b.status = 'expired');
    if exists (select 1 from public.coupon_services cs where cs.coupon_id = v_coupon.id)
      and not exists (select 1 from public.coupon_services cs where cs.coupon_id = v_coupon.id and cs.service_id = p_service_id) then
      raise exception 'This offer does not apply to the selected treatment';
    end if;
    if exists (select 1 from public.coupon_categories cc where cc.coupon_id = v_coupon.id)
      and not exists (select 1 from public.coupon_categories cc where cc.coupon_id = v_coupon.id and cc.category_id = v_service.category_id) then
      raise exception 'This offer does not apply to the selected treatment';
    end if;
    if v_subtotal < v_coupon.minimum_spend_paise then raise exception 'This booking does not meet the offer minimum'; end if;
    select count(*) into v_redemptions from public.coupon_redemptions r
      where r.coupon_id = v_coupon.id and r.status in ('reserved','redeemed');
    if v_coupon.max_redemptions is not null and v_redemptions >= v_coupon.max_redemptions then raise exception 'This offer has reached its usage limit'; end if;
    select count(*) into v_redemptions from public.coupon_redemptions r
      where r.coupon_id = v_coupon.id and r.customer_id = v_customer_id and r.status in ('reserved','redeemed');
    if v_coupon.max_per_customer is not null and v_redemptions >= v_coupon.max_per_customer then raise exception 'You have already used this offer'; end if;
    if v_coupon.first_booking_only and (
      exists (select 1 from public.bookings b where b.customer_id = v_customer_id and b.status in ('confirmed','completed'))
      or exists (
        select 1 from public.coupon_redemptions r
        where r.coupon_id = v_coupon.id and r.customer_id = v_customer_id and r.status in ('reserved','redeemed')
      )
    ) then
      raise exception 'This offer is for a first appointment only';
    end if;
    if v_coupon.discount_type = 'percentage' then
      v_discount := floor(v_subtotal::numeric * v_coupon.discount_value / 10000)::bigint;
      if v_coupon.max_discount_paise is not null then v_discount := least(v_discount, v_coupon.max_discount_paise); end if;
    else
      v_discount := v_coupon.discount_value;
    end if;
    v_discount := least(v_discount, v_subtotal);
    v_coupon_id := v_coupon.id;
  end if;

  v_tax := floor((v_subtotal - v_discount)::numeric * v_service.tax_rate_basis_points / 10000)::bigint;
  v_total := v_subtotal - v_discount + v_tax;
  if v_service.advance_type = 'percentage' then
    v_advance := floor(v_total::numeric * v_service.advance_value / 10000)::bigint;
  else
    v_advance := least(v_total, v_service.advance_value);
  end if;

  insert into public.bookings (
    customer_id, service_id, service_name_snapshot, duration_minutes_snapshot,
    starts_at, ends_at, status, payment_status, subtotal_paise, discount_paise,
    tax_paise, total_paise, advance_due_paise, balance_due_paise, coupon_id,
    customer_notes, hold_expires_at
  ) values (
    v_customer_id, p_service_id, v_service.name, v_duration, p_starts_at,
    p_starts_at + make_interval(mins => v_duration), 'pending_payment', 'pending',
    v_subtotal, v_discount, v_tax, v_total, v_advance, v_total - v_advance,
    v_coupon_id, nullif(left(p_customer_notes, 1000), ''), v_hold
  ) returning id, reference into v_booking_id, v_reference;

  for v_addon in
    select id, name, price_paise, extra_duration_minutes
    from public.service_addons where id = any(coalesce(p_addon_ids, '{}')) and service_id = p_service_id
  loop
    insert into public.booking_addons (booking_id, addon_id, name_snapshot, price_paise_snapshot, extra_duration_minutes_snapshot)
    values (v_booking_id, v_addon.id, v_addon.name, v_addon.price_paise, v_addon.extra_duration_minutes);
  end loop;

  if v_coupon_id is not null then
    insert into public.coupon_redemptions (coupon_id, customer_id, booking_id, discount_paise, status)
    values (v_coupon_id, v_customer_id, v_booking_id, v_discount, 'reserved');
  end if;

  insert into public.booking_status_history (booking_id, old_status, new_status, actor_user_id)
  values (v_booking_id, null, 'pending_payment', v_customer_id);

  return query select v_booking_id, v_reference, 'pending_payment'::text, v_hold, v_subtotal, v_discount, v_tax, v_total, v_advance, v_total - v_advance;
end
$$;

create or replace function public.expire_booking_holds()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.bookings
    set status = 'expired', updated_at = now()
    where status in ('pending_payment','payment_failed')
      and hold_expires_at <= now()
    returning id
  )
  select count(*)::integer into v_count from expired;
  update public.coupon_redemptions r set status = 'released', updated_at = now()
  where r.status = 'reserved'
    and exists (select 1 from public.bookings b where b.id = r.booking_id and b.status = 'expired');
  return v_count;
end
$$;

create or replace function public.get_available_slots(
  p_service_id uuid,
  p_date date,
  p_addon_ids uuid[] default '{}'
)
returns table (starts_at timestamptz, available_spots integer)
language plpgsql security definer set search_path = ''
as $$
declare
  v_service public.services%rowtype;
  v_weekday integer;
  v_duration integer;
  v_rule public.availability_rules%rowtype;
  v_booking_horizon_days integer;
  v_minimum_lead_minutes integer := 0;
begin
  select (value ->> 'days')::integer into v_booking_horizon_days
  from public.business_settings where key = 'booking_horizon_days';
  if v_booking_horizon_days is null
    or v_booking_horizon_days not between 1 and 365
    or p_date > (now() at time zone 'Asia/Kolkata')::date + v_booking_horizon_days then
    return;
  end if;
  select (value ->> 'minutes')::integer into v_minimum_lead_minutes
  from public.business_settings where key = 'minimum_lead_time_minutes';
  v_minimum_lead_minutes := coalesce(v_minimum_lead_minutes, 0);
  if v_minimum_lead_minutes not between 0 and 10080 then return; end if;
  select * into v_service from public.services s
  where s.id = p_service_id and s.is_active = true
    and (s.category_id is null or exists (
      select 1 from public.service_categories c where c.id = s.category_id and c.is_active = true
    ));
  if not found then return; end if;
  v_weekday := extract(dow from p_date)::integer;
  v_duration := v_service.duration_minutes + v_service.buffer_minutes;
  if exists (
    select 1 from unnest(coalesce(p_addon_ids, '{}')) x
    left join public.service_addons a on a.id = x and a.service_id = p_service_id and a.is_active = true
    where a.id is null
  ) then return; end if;
  select v_duration + coalesce(sum(a.extra_duration_minutes), 0) into v_duration
  from public.service_addons a where a.id = any(coalesce(p_addon_ids, '{}'));

  select ar.* into v_rule from public.availability_rules ar
  where ar.weekday = v_weekday and not ar.is_closed and (ar.service_id = p_service_id or ar.service_id is null)
  order by (ar.service_id is not null) desc limit 1;
  if not found then return; end if;

  return query
  with candidates as (
    select (p_date + v_rule.opens_at + make_interval(mins => slot.n * v_rule.slot_interval_minutes))
      at time zone 'Asia/Kolkata' as candidate_start
    from generate_series(
      0,
      greatest(0, floor(extract(epoch from (v_rule.closes_at - v_rule.opens_at)) / 60 / v_rule.slot_interval_minutes)::integer)
    ) as slot(n)
  ),
  eligible as (
    select c.candidate_start,
      coalesce((
        select min(e.capacity_override)
        from public.availability_exceptions e
        where e.exception_type = 'capacity_override'
          and e.capacity_override is not null
          and tstzrange(e.starts_at, e.ends_at, '[)') &&
            tstzrange(c.candidate_start, c.candidate_start + make_interval(mins => v_duration), '[)')
      ), v_rule.capacity) as slot_capacity
    from candidates c
    where c.candidate_start > now() + make_interval(mins => v_minimum_lead_minutes)
      and (c.candidate_start at time zone 'Asia/Kolkata') + make_interval(mins => v_duration) <= (p_date + v_rule.closes_at)
      and not exists (
        select 1 from public.availability_exceptions e
        where e.exception_type = 'closed'
          and tstzrange(e.starts_at, e.ends_at, '[)') &&
            tstzrange(c.candidate_start, c.candidate_start + make_interval(mins => v_duration), '[)')
      )
  )
  select e.candidate_start,
    e.slot_capacity - (
      select count(*)::integer from public.bookings b
      where b.service_id = p_service_id
        and b.starts_at < e.candidate_start + make_interval(mins => v_duration)
        and b.ends_at > e.candidate_start
        and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()))
    ) as available_spots
  from eligible e
  where e.slot_capacity > (
    select count(*)::integer from public.bookings b
    where b.service_id = p_service_id
      and b.starts_at < e.candidate_start + make_interval(mins => v_duration)
      and b.ends_at > e.candidate_start
      and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()))
  )
  order by e.candidate_start;
end
$$;

create or replace function public.process_razorpay_webhook(
  p_event_id text,
  p_event_type text,
  p_order_id text default null,
  p_payment_id text default null,
  p_amount_paise bigint default null,
  p_currency text default null,
  p_refund_id text default null,
  p_refund_amount_paise bigint default null,
  p_refund_payment_id text default null,
  p_refund_internal_id uuid default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_booking public.bookings%rowtype;
begin
  insert into public.provider_events (provider_event_id, event_type)
  values (p_event_id, p_event_type)
  on conflict (provider_event_id) do nothing;
  if not found then return false; end if;

  if p_event_type in ('payment.captured', 'payment.failed') then
    select * into v_payment from public.payments p
    where p.provider_order_id = p_order_id and (p_payment_id is null or p.provider_payment_id is null or p.provider_payment_id = p_payment_id)
    for update;
    if not found then raise exception 'Payment order does not exist'; end if;
    if p_amount_paise is distinct from v_payment.amount_paise or p_currency is distinct from 'INR' then
      raise exception 'Provider payment amount or currency mismatch';
    end if;
    select * into v_booking from public.bookings b where b.id = v_payment.booking_id for update;
    if p_event_type = 'payment.captured' then
      update public.payments set provider_payment_id = p_payment_id, status = 'captured', verified_at = now(), updated_at = now()
      where id = v_payment.id;
      if v_booking.status in ('pending_payment','payment_failed') and v_booking.hold_expires_at > now() then
        update public.bookings set status = 'confirmed', confirmed_at = now(),
          payment_status = case when p_amount_paise >= total_paise then 'paid' else 'partially_paid' end,
          updated_at = now()
        where id = v_booking.id;
        update public.coupon_redemptions set status = 'redeemed', updated_at = now()
        where booking_id = v_booking.id and status = 'reserved';
      elsif v_booking.status in ('pending_payment','payment_failed') then
        update public.bookings set status = 'expired', updated_at = now() where id = v_booking.id;
        update public.coupon_redemptions set status = 'released', updated_at = now()
        where booking_id = v_booking.id and status = 'reserved';
      end if;
    else
      update public.payments set provider_payment_id = coalesce(p_payment_id, provider_payment_id),
        status = 'failed', failure_code = 'provider_payment_failed', updated_at = now()
      where id = v_payment.id;
      if v_booking.status = 'pending_payment' then
        update public.bookings set status = case when hold_expires_at > now() then 'payment_failed' else 'expired' end,
          payment_status = 'failed', updated_at = now()
        where id = v_booking.id;
      end if;
      update public.coupon_redemptions set status = 'released', updated_at = now()
      where booking_id = v_booking.id and status = 'reserved'
        and exists (select 1 from public.bookings b where b.id = v_booking.id and b.status = 'expired');
    end if;
  elsif p_event_type in ('refund.processed', 'refund.failed') then
    update public.refunds r set status = case when p_event_type = 'refund.processed' then 'processed' else 'failed' end,
      provider_refund_id = coalesce(r.provider_refund_id, p_refund_id),
      completed_at = case when p_event_type = 'refund.processed' then now() else null end,
      updated_at = now()
    where r.amount_paise = p_refund_amount_paise
      and (
        r.provider_refund_id = p_refund_id
        or (r.provider_refund_id is null and r.id = p_refund_internal_id)
      )
      and exists (
        select 1 from public.payments p
        where p.id = r.payment_id and p.provider_payment_id = p_refund_payment_id
      );
    if not found then raise exception 'Refund record does not exist'; end if;
    if p_event_type = 'refund.processed' then
      update public.payments p set status = case
        when (select coalesce(sum(r.amount_paise), 0) from public.refunds r where r.payment_id = p.id and r.status = 'processed') >= p.amount_paise then 'refunded'
        else 'partially_refunded'
      end, updated_at = now()
      where p.id = (select r.payment_id from public.refunds r where r.provider_refund_id = p_refund_id);
      update public.bookings b set payment_status = case
        when (select coalesce(sum(r.amount_paise), 0) from public.refunds r join public.payments p on p.id = r.payment_id where p.booking_id = b.id and r.status = 'processed')
          >= (select coalesce(sum(p.amount_paise), 0) from public.payments p where p.booking_id = b.id and p.status in ('captured','refunded','partially_refunded')) then 'refunded'
        else 'partially_refunded'
      end, updated_at = now()
      where b.id = (select p.booking_id from public.payments p join public.refunds r on r.payment_id = p.id where r.provider_refund_id = p_refund_id);
    end if;
  end if;
  return true;
end
$$;

alter table public.profiles enable row level security;
alter table public.service_categories enable row level security;
alter table public.services enable row level security;
alter table public.service_media enable row level security;
alter table public.service_addons enable row level security;
alter table public.availability_rules enable row level security;
alter table public.availability_exceptions enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_addons enable row level security;
alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.coupons enable row level security;
alter table public.coupon_services enable row level security;
alter table public.coupon_categories enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.notifications enable row level security;
alter table public.booking_status_history enable row level security;
alter table public.business_settings enable row level security;
alter table public.audit_logs enable row level security;
alter table public.provider_events enable row level security;

create policy "Profiles visible to owner or admin" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());
create policy "Customers update own contact profile" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "Public reads active categories" on public.service_categories for select to anon, authenticated
  using (is_active or public.is_admin());
create policy "Admins manage categories" on public.service_categories for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Public reads active services" on public.services for select to anon, authenticated
  using ((is_active and (category_id is null or exists (select 1 from public.service_categories c where c.id = category_id and c.is_active))) or public.is_admin());
create policy "Admins manage services" on public.services for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Public reads active media for active services" on public.service_media for select to anon, authenticated
  using (is_active and exists (select 1 from public.services s where s.id = service_id and s.is_active) or public.is_admin());
create policy "Admins manage media" on public.service_media for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Public reads active add-ons for active services" on public.service_addons for select to anon, authenticated
  using (is_active and exists (select 1 from public.services s where s.id = service_id and s.is_active) or public.is_admin());
create policy "Admins manage add-ons" on public.service_addons for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Public reads availability rules" on public.availability_rules for select to anon, authenticated
  using (not is_closed or public.is_admin());
create policy "Admins manage availability rules" on public.availability_rules for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Admins read availability exceptions" on public.availability_exceptions for select to authenticated
  using (public.is_admin());
create policy "Admins manage availability exceptions" on public.availability_exceptions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "Customers read own bookings or admin" on public.bookings for select to authenticated
  using (customer_id = (select auth.uid()) or public.is_admin());
create policy "Customers read booking add-ons or admin" on public.booking_addons for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and (b.customer_id = (select auth.uid()) or public.is_admin())));
create policy "Customers read own payments or admin" on public.payments for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and (b.customer_id = (select auth.uid()) or public.is_admin())));
create policy "Admins manage payments" on public.payments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Customers read own refunds or admin" on public.refunds for select to authenticated
  using (exists (select 1 from public.payments p join public.bookings b on b.id = p.booking_id where p.id = payment_id and (b.customer_id = (select auth.uid()) or public.is_admin())));
create policy "Admins manage refunds" on public.refunds for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "Public reads active offers" on public.coupons for select to anon, authenticated
  using (is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()) or public.is_admin());
create policy "Admins manage offers" on public.coupons for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Admins manage service offer rules" on public.coupon_services for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Admins manage category offer rules" on public.coupon_categories for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Customers read own coupon uses or admin" on public.coupon_redemptions for select to authenticated
  using (customer_id = (select auth.uid()) or public.is_admin());
create policy "Customers read own notifications or admin" on public.notifications for select to authenticated
  using (recipient_user_id = (select auth.uid()) or public.is_admin());
create policy "Admins manage notifications" on public.notifications for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Customers read own status history or admin" on public.booking_status_history for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and (b.customer_id = (select auth.uid()) or public.is_admin())));
create policy "Public reads explicitly public business settings" on public.business_settings for select to anon, authenticated
  using (is_public or public.is_admin());
create policy "Admins manage business settings" on public.business_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Admins read audit logs" on public.audit_logs for select to authenticated using (public.is_admin());
create policy "Admins write audit logs" on public.audit_logs for insert to authenticated with check (public.is_admin());

revoke all on public.bookings, public.booking_addons, public.payments, public.refunds, public.coupon_redemptions,
  public.booking_status_history, public.notifications, public.audit_logs from anon, authenticated;
grant select on public.profiles, public.service_categories, public.services, public.service_media, public.service_addons,
  public.availability_rules, public.availability_exceptions, public.bookings, public.booking_addons, public.payments,
  public.refunds, public.coupons, public.coupon_redemptions, public.notifications, public.booking_status_history,
  public.business_settings, public.audit_logs, public.coupon_services, public.coupon_categories to authenticated;
grant select on public.service_categories, public.services, public.service_media, public.service_addons,
  public.availability_rules, public.coupons, public.business_settings to anon;
grant update (full_name, phone, whatsapp_opt_in) on public.profiles to authenticated;
grant insert, update, delete on public.service_categories, public.services, public.service_media,
  public.service_addons, public.availability_rules, public.availability_exceptions,
  public.coupons, public.coupon_services, public.coupon_categories, public.business_settings to authenticated;
grant all on public.provider_events to service_role;
grant execute on function public.reserve_booking(uuid, timestamptz, uuid[], text, text) to authenticated;
revoke all on function public.reserve_booking(uuid, timestamptz, uuid[], text, text) from public, anon;
grant execute on function public.get_available_slots(uuid, date, uuid[]) to anon, authenticated;
revoke all on function public.expire_booking_holds() from public, anon, authenticated;
grant execute on function public.expire_booking_holds() to service_role;
revoke all on function public.process_razorpay_webhook(text, text, text, text, bigint, text, text, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.process_razorpay_webhook(text, text, text, text, bigint, text, text, bigint, text, uuid) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('service-media', 'service-media', false, 52428800, array['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm'])
on conflict (id) do nothing;
create policy "Admins read service media files" on storage.objects for select to authenticated
  using (bucket_id = 'service-media' and public.is_admin());
create policy "Admins upload service media files" on storage.objects for insert to authenticated
  with check (bucket_id = 'service-media' and public.is_admin());
create policy "Admins update service media files" on storage.objects for update to authenticated
  using (bucket_id = 'service-media' and public.is_admin())
  with check (bucket_id = 'service-media' and public.is_admin());
create policy "Admins delete service media files" on storage.objects for delete to authenticated
  using (bucket_id = 'service-media' and public.is_admin());
