create table public.treatment_chambers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  chamber_type text not null default 'standard',
  capacity integer not null default 1 check (capacity between 1 and 100),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.treatment_chambers enable row level security;
create policy "Admins manage treatment chambers" on public.treatment_chambers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.treatment_chambers to authenticated;
create trigger touch_treatment_chamber_updated_at before update on public.treatment_chambers
  for each row execute function public.set_updated_at();
create trigger audit_treatment_chamber_changes
  after insert or update or delete on public.treatment_chambers
  for each row execute function public.audit_catalog_change();

insert into public.business_settings (key, value, is_public)
values (
  'payment_gateway',
  '{"provider":"razorpay","enabled":false,"environment":"test","methods":["card","upi","netbanking"]}'::jsonb,
  true
)
on conflict (key) do nothing;

alter table public.bookings alter column customer_id drop not null;
alter table public.bookings
  add column customer_name_snapshot text,
  add column customer_phone_snapshot text,
  add column customer_email_snapshot text,
  add column guest_whatsapp_opt_in boolean not null default false,
  add column chamber_id uuid references public.treatment_chambers(id) on delete set null;
alter table public.payments
  add column payment_method text check (payment_method in ('cash', 'card', 'upi', 'razorpay'));

update public.bookings b
set customer_name_snapshot = coalesce(nullif(trim(p.full_name), ''), nullif(u.raw_user_meta_data ->> 'full_name', '')),
    customer_phone_snapshot = p.phone,
    customer_email_snapshot = u.email
from public.profiles p
left join auth.users u on u.id = p.id
where b.customer_id = p.id
  and (b.customer_name_snapshot is null or b.customer_phone_snapshot is null or b.customer_email_snapshot is null);

create or replace function public.require_booking_phone()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_email text;
begin
  if new.customer_id is null then
    if new.booking_channel <> 'offline'
      or nullif(trim(new.customer_name_snapshot), '') is null
      or nullif(trim(new.customer_phone_snapshot), '') is null then
      raise exception 'An offline booking needs a guest name and phone number';
    end if;
    return new;
  end if;
  select * into v_profile from public.profiles p where p.id = new.customer_id;
  if not found or nullif(trim(v_profile.phone), '') is null then
    raise exception 'Add a phone number to the customer profile before booking';
  end if;
  select u.email into v_email from auth.users u where u.id = new.customer_id;
  new.customer_name_snapshot := coalesce(nullif(trim(v_profile.full_name), ''), new.customer_name_snapshot);
  new.customer_phone_snapshot := v_profile.phone;
  new.customer_email_snapshot := coalesce(v_email, new.customer_email_snapshot);
  return new;
end
$$;

create or replace function public.assign_booking_chamber()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_chamber public.treatment_chambers%rowtype;
  v_occupied integer;
begin
  if new.chamber_id is not null then
    select * into v_chamber from public.treatment_chambers c
    where c.id = new.chamber_id and c.is_active for update;
    if not found then raise exception 'Choose an active treatment chamber'; end if;
    select count(*)::integer into v_occupied from public.bookings b
    where (b.chamber_id = v_chamber.id or b.chamber_id is null) and b.id is distinct from new.id
      and b.starts_at < new.ends_at and b.ends_at > new.starts_at
      and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()));
    if v_occupied >= v_chamber.capacity then raise exception 'This treatment chamber is already booked at that time'; end if;
    return new;
  end if;
  if new.booking_channel <> 'online' or not exists (
    select 1 from public.treatment_chambers c where c.is_active
  ) then return new; end if;
  for v_chamber in
    select * from public.treatment_chambers c where c.is_active order by c.sort_order, c.name
  loop
    perform 1 from public.treatment_chambers c where c.id = v_chamber.id for update;
    select count(*)::integer into v_occupied from public.bookings b
    where (b.chamber_id = v_chamber.id or b.chamber_id is null) and b.id is distinct from new.id
      and b.starts_at < new.ends_at and b.ends_at > new.starts_at
      and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()));
    if v_occupied < v_chamber.capacity then
      new.chamber_id := v_chamber.id;
      return new;
    end if;
  end loop;
  raise exception 'No treatment chamber is available at that time';
end
$$;
create trigger assign_booking_chamber_before_insert
  before insert on public.bookings for each row execute function public.assign_booking_chamber();
create trigger validate_booking_chamber_before_reschedule
  before update of chamber_id, starts_at, ends_at on public.bookings
  for each row when (new.chamber_id is not null)
  execute function public.assign_booking_chamber();

create or replace function public.reject_booking_during_closed_period()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status in ('confirmed', 'pending_payment') and exists (
    select 1 from public.availability_exceptions e
    where e.exception_type = 'closed'
      and tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')
  ) then
    raise exception 'This appointment time was just locked by reception';
  end if;
  return new;
end
$$;
create trigger reject_booking_during_closed_period_before_save
  before insert on public.bookings
  for each row execute function public.reject_booking_during_closed_period();
create trigger reject_booking_during_closed_period_before_reschedule
  before update of starts_at, ends_at, status on public.bookings
  for each row execute function public.reject_booking_during_closed_period();

create or replace function public.admin_lock_appointment_slot(
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_reason text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_service_id uuid;
  v_local_day date;
  v_exception_id uuid;
begin
  if not public.is_admin() then raise exception 'Administrator access is required'; end if;
  if p_starts_at <= now() or p_ends_at <= p_starts_at
    or p_ends_at - p_starts_at > interval '24 hours'
    or nullif(trim(p_reason), '') is null
    or length(trim(p_reason)) > 500 then
    raise exception 'The appointment lock window is invalid';
  end if;
  v_local_day := (p_starts_at at time zone 'Asia/Kolkata')::date;
  while v_local_day <= ((p_ends_at - interval '1 microsecond') at time zone 'Asia/Kolkata')::date
  loop
    for v_service_id in select s.id from public.services s where s.is_active order by s.id
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_service_id::text || ':' || v_local_day::text, 0));
    end loop;
    v_local_day := v_local_day + 1;
  end loop;
  if exists (
    select 1 from public.bookings b
    where b.starts_at < p_ends_at and b.ends_at > p_starts_at
      and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()))
  ) then
    raise exception 'An existing appointment occupies this time';
  end if;
  insert into public.availability_exceptions (starts_at, ends_at, exception_type, reason)
  values (p_starts_at, p_ends_at, 'closed', left(trim(p_reason), 500))
  returning id into v_exception_id;
  return v_exception_id;
end
$$;

drop function public.admin_create_offline_booking(uuid, uuid, timestamptz, text);

create function public.admin_create_offline_booking(
  p_customer_id uuid,
  p_guest_name text,
  p_guest_phone text,
  p_guest_email text,
  p_guest_whatsapp_opt_in boolean,
  p_service_id uuid,
  p_chamber_id uuid,
  p_starts_at timestamptz,
  p_customer_notes text,
  p_collection_type text,
  p_payment_method text
)
returns table (booking_id uuid, booking_reference text, amount_collected_paise bigint)
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
  v_collected bigint;
  v_id uuid;
  v_reference text;
  v_chamber public.treatment_chambers%rowtype;
  v_occupied integer;
begin
  if not public.is_admin() then raise exception 'Administrator access is required'; end if;
  if p_customer_id is not null then
    if nullif(trim(coalesce(p_guest_name, '')), '') is not null
      or nullif(trim(coalesce(p_guest_phone, '')), '') is not null then
      raise exception 'Choose either an existing customer or enter a new guest';
    end if;
    select * into v_profile from public.profiles p where p.id = p_customer_id;
    if not found or nullif(trim(v_profile.phone), '') is null then
      raise exception 'Choose a customer profile with a phone number';
    end if;
    p_guest_name := v_profile.full_name;
    p_guest_phone := v_profile.phone;
    select u.email into p_guest_email from auth.users u where u.id = p_customer_id;
    p_guest_whatsapp_opt_in := v_profile.whatsapp_opt_in;
  elsif nullif(trim(coalesce(p_guest_name, '')), '') is null
    or nullif(trim(coalesce(p_guest_phone, '')), '') is null then
    raise exception 'A walk-in guest name and phone number are required';
  end if;
  if length(trim(p_guest_name)) > 120 or length(trim(p_guest_phone)) > 30
    or length(coalesce(p_guest_email, '')) > 254
    or regexp_replace(p_guest_phone, '[^0-9]', '', 'g') !~ '^[1-9][0-9]{7,14}$'
    or (p_guest_email is not null and p_guest_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Guest contact details are invalid';
  end if;
  if p_collection_type is null or p_collection_type not in ('none', 'advance', 'full') then raise exception 'Choose a valid collection amount'; end if;
  if p_collection_type <> 'none' and coalesce(p_payment_method not in ('cash', 'card', 'upi'), true) then
    raise exception 'Choose cash, card or UPI for a counter payment';
  end if;
  if p_collection_type = 'none' and p_payment_method is not null then
    raise exception 'A payment method is not needed when no money is collected';
  end if;
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
  if exists (select 1 from public.treatment_chambers c where c.is_active) then
    if p_chamber_id is null then raise exception 'Choose a treatment chamber'; end if;
    select * into v_chamber from public.treatment_chambers c
      where c.id = p_chamber_id and c.is_active for update;
    if not found then raise exception 'Choose an active treatment chamber'; end if;
    select count(*)::integer into v_occupied from public.bookings b
      where (b.chamber_id = p_chamber_id or b.chamber_id is null)
        and b.starts_at < p_starts_at + make_interval(mins => v_duration)
        and b.ends_at > p_starts_at
        and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()));
    if v_occupied >= v_chamber.capacity then raise exception 'This treatment chamber is already booked at that time'; end if;
  elsif p_chamber_id is not null then
    raise exception 'The selected treatment chamber is not available';
  end if;

  v_subtotal := v_service.price_paise;
  v_tax := floor(v_subtotal::numeric * v_service.tax_rate_basis_points / 10000)::bigint;
  v_total := v_subtotal + v_tax;
  v_advance := case when v_service.advance_type = 'percentage'
    then floor(v_total::numeric * v_service.advance_value / 10000)::bigint
    else least(v_total, v_service.advance_value) end;
  v_collected := case p_collection_type
    when 'full' then v_total
    when 'advance' then v_advance
    else 0 end;
  insert into public.bookings (
    customer_id, customer_name_snapshot, customer_phone_snapshot, customer_email_snapshot,
    guest_whatsapp_opt_in, service_id, chamber_id, service_name_snapshot, duration_minutes_snapshot,
    starts_at, ends_at, status, payment_status, subtotal_paise, tax_paise, total_paise,
    advance_due_paise, balance_due_paise, customer_notes, confirmed_at, booking_channel
  ) values (
    p_customer_id, left(trim(p_guest_name), 120), left(trim(p_guest_phone), 30), nullif(trim(p_guest_email), ''),
    coalesce(p_guest_whatsapp_opt_in, false), p_service_id, p_chamber_id, v_service.name, v_duration,
    p_starts_at, p_starts_at + make_interval(mins => v_duration), 'confirmed',
    case when v_collected >= v_total and v_total > 0 then 'paid'
      when v_collected > 0 then 'partially_paid' else 'pending' end,
    v_subtotal, v_tax, v_total, v_advance, v_total - v_advance,
    nullif(left(p_customer_notes, 1000), ''), now(), 'offline'
  ) returning id, reference into v_id, v_reference;
  if v_collected > 0 then
    insert into public.payments (booking_id, provider, amount_paise, currency, status, payment_method, verified_at)
    values (v_id, 'offline', v_collected, 'INR', 'captured', p_payment_method, now());
  end if;
  insert into public.booking_status_history (booking_id, old_status, new_status, actor_user_id, reason)
  values (v_id, null, 'confirmed', auth.uid(), 'Offline walk-in booking');
  return query select v_id, v_reference, v_collected;
end
$$;

revoke all on function public.admin_create_offline_booking(uuid, text, text, text, boolean, uuid, uuid, timestamptz, text, text, text) from public, anon;
grant execute on function public.admin_create_offline_booking(uuid, text, text, text, boolean, uuid, uuid, timestamptz, text, text, text) to authenticated;
revoke all on function public.admin_lock_appointment_slot(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.admin_lock_appointment_slot(timestamptz, timestamptz, text) to authenticated;
