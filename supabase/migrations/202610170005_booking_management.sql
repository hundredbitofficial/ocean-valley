alter table public.bookings
  add column if not exists booking_channel text not null default 'online'
    check (booking_channel in ('online', 'offline'));

create table if not exists public.booking_schedule_history (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  old_starts_at timestamptz not null,
  old_ends_at timestamptz not null,
  new_starts_at timestamptz not null,
  new_ends_at timestamptz not null,
  reason text,
  actor_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.booking_schedule_history enable row level security;
create policy "Customers read own schedule history or admin"
  on public.booking_schedule_history for select to authenticated
  using (exists (
    select 1 from public.bookings b
    where b.id = booking_id and (b.customer_id = (select auth.uid()) or public.is_admin())
  ));
grant select on public.booking_schedule_history to authenticated;
grant insert on public.notifications to authenticated;

create or replace function public.create_profile_for_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end
$$;

create or replace function public.require_booking_phone()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = new.customer_id and nullif(trim(p.phone), '') is not null
  ) then
    raise exception 'Add a phone number to your profile before booking';
  end if;
  return new;
end
$$;
create trigger require_phone_for_booking
  before insert on public.bookings
  for each row execute function public.require_booking_phone();

create or replace function public.customer_cancel_booking(p_booking_id uuid, p_reason text default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in is required'; end if;
  select * into v_booking from public.bookings b
  where b.id = p_booking_id and b.customer_id = auth.uid()
  for update;
  if not found then raise exception 'Appointment was not found'; end if;
  if v_booking.status <> 'confirmed' or v_booking.starts_at <= now() then
    raise exception 'Only future confirmed appointments can be cancelled online';
  end if;
  update public.bookings
  set status = 'cancelled',
      cancellation_reason = coalesce(nullif(left(trim(p_reason), 500), ''), 'Cancelled by customer'),
      cancelled_at = now()
  where id = p_booking_id;
  return true;
end
$$;

create or replace function public.customer_reschedule_booking(
  p_booking_id uuid,
  p_starts_at timestamptz
)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_service_id uuid;
  v_weekday integer;
  v_local timestamp;
  v_rule public.availability_rules%rowtype;
  v_capacity integer;
  v_horizon integer;
  v_lead integer;
begin
  if auth.uid() is null then raise exception 'Sign in is required'; end if;
  select * into v_booking from public.bookings b
  where b.id = p_booking_id and (b.customer_id = auth.uid() or public.is_admin())
  for update;
  if not found then raise exception 'Appointment was not found'; end if;
  if v_booking.status <> 'confirmed' or v_booking.starts_at <= now() then
    raise exception 'Only future confirmed appointments can be rescheduled';
  end if;
  if exists (
    select 1 from public.refunds r join public.payments p on p.id = r.payment_id
    where p.booking_id = p_booking_id and r.status = 'pending'
  ) then raise exception 'This appointment has a pending refund and cannot be rescheduled'; end if;
  if p_starts_at <= now() then raise exception 'Choose a future appointment time'; end if;
  select (value ->> 'days')::integer into v_horizon from public.business_settings where key = 'booking_horizon_days';
  select coalesce((value ->> 'minutes')::integer, 0) into v_lead from public.business_settings where key = 'minimum_lead_time_minutes';
  if v_horizon is null then raise exception 'Booking horizon is not configured'; end if;
  if p_starts_at <= now() + make_interval(mins => v_lead)
    or (p_starts_at at time zone 'Asia/Kolkata')::date >
      (now() at time zone 'Asia/Kolkata')::date + v_horizon then
    raise exception 'Choose a time within the current booking window';
  end if;

  select b.service_id into v_service_id from public.bookings b where b.id = p_booking_id;
  v_local := p_starts_at at time zone 'Asia/Kolkata';
  v_weekday := extract(dow from v_local)::integer;
  select * into v_rule from public.availability_rules ar
  where ar.weekday = v_weekday and not ar.is_closed and (ar.service_id = v_service_id or ar.service_id is null)
    and v_local::time >= ar.opens_at
    and v_local::time + make_interval(mins => v_booking.duration_minutes_snapshot) <= ar.closes_at
    and mod(extract(epoch from (v_local::time - ar.opens_at))::integer, ar.slot_interval_minutes * 60) = 0
  order by (ar.service_id is not null) desc limit 1;
  if not found then raise exception 'Choose a time within the published appointment hours'; end if;
  if exists (
    select 1 from public.availability_exceptions e
    where e.exception_type = 'closed' and tstzrange(e.starts_at, e.ends_at, '[)') &&
      tstzrange(p_starts_at, p_starts_at + make_interval(mins => v_booking.duration_minutes_snapshot), '[)')
  ) then raise exception 'This appointment time is closed'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_service_id::text || ':' ||
    (p_starts_at at time zone 'Asia/Kolkata')::date::text, 0));
  select coalesce(min(e.capacity_override), v_rule.capacity) into v_capacity
  from public.availability_exceptions e
  where e.exception_type = 'capacity_override' and e.capacity_override is not null
    and tstzrange(e.starts_at, e.ends_at, '[)') &&
      tstzrange(p_starts_at, p_starts_at + make_interval(mins => v_booking.duration_minutes_snapshot), '[)');
  v_capacity := coalesce(v_capacity, v_rule.capacity);
  if (
    select count(*) from public.bookings b
    where b.service_id = v_service_id and b.id <> p_booking_id
      and b.starts_at < p_starts_at + make_interval(mins => v_booking.duration_minutes_snapshot)
      and b.ends_at > p_starts_at
      and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()))
  ) >= v_capacity then raise exception 'This appointment time was just taken'; end if;

  insert into public.booking_schedule_history (
    booking_id, old_starts_at, old_ends_at, new_starts_at, new_ends_at, reason, actor_user_id
  ) values (
    p_booking_id, v_booking.starts_at, v_booking.ends_at,
    p_starts_at, p_starts_at + make_interval(mins => v_booking.duration_minutes_snapshot),
    'Customer rescheduled', auth.uid()
  );
  update public.bookings set starts_at = p_starts_at,
    ends_at = p_starts_at + make_interval(mins => v_booking.duration_minutes_snapshot)
  where id = p_booking_id;
  return p_starts_at;
end
$$;

create or replace function public.admin_create_offline_booking(
  p_customer_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_customer_notes text default null
)
returns table (booking_id uuid, booking_reference text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_service public.services%rowtype;
  v_profile public.profiles%rowtype;
  v_local timestamp;
  v_weekday integer;
  v_rule public.availability_rules%rowtype;
  v_capacity integer;
  v_duration integer;
  v_subtotal bigint;
  v_tax bigint;
  v_total bigint;
  v_advance bigint;
  v_id uuid;
  v_reference text;
begin
  if not public.is_admin() then raise exception 'Administrator access is required'; end if;
  select * into v_profile from public.profiles p where p.id = p_customer_id;
  if not found or nullif(trim(v_profile.phone), '') is null then raise exception 'Choose a customer profile with a phone number'; end if;
  select * into v_service from public.services s where s.id = p_service_id and s.is_active;
  if not found then raise exception 'This service is not available'; end if;
  v_duration := v_service.duration_minutes + v_service.buffer_minutes;
  v_local := p_starts_at at time zone 'Asia/Kolkata';
  v_weekday := extract(dow from v_local)::integer;
  if p_starts_at <= now() then raise exception 'Choose a future appointment time'; end if;
  select * into v_rule from public.availability_rules ar
  where ar.weekday = v_weekday and not ar.is_closed and (ar.service_id = p_service_id or ar.service_id is null)
    and v_local::time >= ar.opens_at
    and v_local::time + make_interval(mins => v_duration) <= ar.closes_at
    and mod(extract(epoch from (v_local::time - ar.opens_at))::integer, ar.slot_interval_minutes * 60) = 0
  order by (ar.service_id is not null) desc limit 1;
  if not found then raise exception 'The requested time is outside published appointment hours'; end if;
  if exists (
    select 1 from public.availability_exceptions e
    where e.exception_type = 'closed' and tstzrange(e.starts_at, e.ends_at, '[)') &&
      tstzrange(p_starts_at, p_starts_at + make_interval(mins => v_duration), '[)')
  ) then raise exception 'The requested time is closed'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_service_id::text || ':' ||
    (p_starts_at at time zone 'Asia/Kolkata')::date::text, 0));
  select coalesce(min(e.capacity_override), v_rule.capacity) into v_capacity
  from public.availability_exceptions e
  where e.exception_type = 'capacity_override' and e.capacity_override is not null
    and tstzrange(e.starts_at, e.ends_at, '[)') &&
      tstzrange(p_starts_at, p_starts_at + make_interval(mins => v_duration), '[)');
  v_capacity := coalesce(v_capacity, v_rule.capacity);
  if (select count(*) from public.bookings b
      where b.service_id = p_service_id and b.starts_at < p_starts_at + make_interval(mins => v_duration)
        and b.ends_at > p_starts_at
        and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()))) >= v_capacity then
    raise exception 'This appointment time was just taken';
  end if;

  v_subtotal := v_service.price_paise;
  v_tax := floor(v_subtotal::numeric * v_service.tax_rate_basis_points / 10000)::bigint;
  v_total := v_subtotal + v_tax;
  v_advance := case when v_service.advance_type = 'percentage'
    then floor(v_total::numeric * v_service.advance_value / 10000)::bigint
    else least(v_total, v_service.advance_value) end;
  insert into public.bookings (
    customer_id, service_id, service_name_snapshot, duration_minutes_snapshot,
    starts_at, ends_at, status, payment_status, subtotal_paise, tax_paise, total_paise,
    advance_due_paise, balance_due_paise, customer_notes, confirmed_at, booking_channel
  ) values (
    p_customer_id, p_service_id, v_service.name, v_duration, p_starts_at,
    p_starts_at + make_interval(mins => v_duration), 'confirmed', 'pending',
    v_subtotal, v_tax, v_total, v_advance, v_total - v_advance,
    nullif(left(p_customer_notes, 1000), ''), now(), 'offline'
  ) returning id, reference into v_id, v_reference;
  insert into public.booking_status_history (booking_id, old_status, new_status, actor_user_id)
  values (v_id, null, 'confirmed', auth.uid());
  return query select v_id, v_reference;
end
$$;

grant execute on function public.customer_cancel_booking(uuid, text) to authenticated;
grant execute on function public.customer_reschedule_booking(uuid, timestamptz) to authenticated;
grant execute on function public.admin_create_offline_booking(uuid, uuid, timestamptz, text) to authenticated;
revoke all on function public.customer_cancel_booking(uuid, text) from public, anon;
revoke all on function public.customer_reschedule_booking(uuid, timestamptz) from public, anon;
revoke all on function public.admin_create_offline_booking(uuid, uuid, timestamptz, text) from public, anon;
