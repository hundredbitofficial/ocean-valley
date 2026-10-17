create or replace function public.audit_catalog_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record jsonb;
  v_changed_fields jsonb;
  v_id text;
begin
  if tg_op = 'DELETE' then
    v_record := to_jsonb(old);
    v_id := v_record ->> 'id';
    v_changed_fields := '[]'::jsonb;
  elsif tg_op = 'INSERT' then
    v_record := to_jsonb(new);
    v_id := v_record ->> 'id';
    select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
      into v_changed_fields from jsonb_object_keys(v_record) as fields(key);
  else
    v_record := to_jsonb(new);
    v_id := v_record ->> 'id';
    select coalesce(jsonb_agg(new_fields.key order by new_fields.key), '[]'::jsonb)
      into v_changed_fields
      from jsonb_each(v_record) as new_fields(key, value)
      where new_fields.value is distinct from (to_jsonb(old) -> new_fields.key);
  end if;

  insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    coalesce(auth.uid(), nullif(v_record ->> 'initiated_by', '')::uuid),
    lower(tg_op),
    tg_table_name,
    v_id,
    jsonb_build_object('changed_fields', v_changed_fields)
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create trigger audit_service_changes
  after insert or update or delete on public.services
  for each row execute function public.audit_catalog_change();
create trigger audit_category_changes
  after insert or update or delete on public.service_categories
  for each row execute function public.audit_catalog_change();
create trigger audit_addon_changes
  after insert or update or delete on public.service_addons
  for each row execute function public.audit_catalog_change();
create trigger audit_service_media_changes
  after insert or update or delete on public.service_media
  for each row execute function public.audit_catalog_change();
create trigger audit_availability_changes
  after insert or update or delete on public.availability_rules
  for each row execute function public.audit_catalog_change();
create trigger audit_availability_exception_changes
  after insert or update or delete on public.availability_exceptions
  for each row execute function public.audit_catalog_change();
create trigger audit_offer_changes
  after insert or update or delete on public.coupons
  for each row execute function public.audit_catalog_change();
create trigger audit_refund_changes
  after insert or update or delete on public.refunds
  for each row execute function public.audit_catalog_change();
create trigger audit_business_setting_changes
  after insert or update or delete on public.business_settings
  for each row execute function public.audit_catalog_change();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger touch_profile_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger touch_category_updated_at before update on public.service_categories
  for each row execute function public.set_updated_at();
create trigger touch_service_updated_at before update on public.services
  for each row execute function public.set_updated_at();
create trigger touch_media_updated_at before update on public.service_media
  for each row execute function public.set_updated_at();
create trigger touch_addon_updated_at before update on public.service_addons
  for each row execute function public.set_updated_at();
create trigger touch_availability_updated_at before update on public.availability_rules
  for each row execute function public.set_updated_at();
create trigger touch_exception_updated_at before update on public.availability_exceptions
  for each row execute function public.set_updated_at();
create trigger touch_coupon_updated_at before update on public.coupons
  for each row execute function public.set_updated_at();
create trigger touch_booking_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();
create trigger touch_payment_updated_at before update on public.payments
  for each row execute function public.set_updated_at();
create trigger touch_refund_updated_at before update on public.refunds
  for each row execute function public.set_updated_at();
create trigger touch_redemption_updated_at before update on public.coupon_redemptions
  for each row execute function public.set_updated_at();
create trigger touch_notification_updated_at before update on public.notifications
  for each row execute function public.set_updated_at();
create trigger touch_business_setting_updated_at before update on public.business_settings
  for each row execute function public.set_updated_at();

create or replace function public.validate_business_setting()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_value_text text;
  v_value integer;
  v_property text;
  v_minimum integer;
  v_maximum integer;
begin
  if jsonb_typeof(new.value) is distinct from 'object' then
    raise exception 'Business setting value must be a JSON object';
  end if;
  if new.key = 'booking_horizon_days' then
    v_property := 'days';
    v_minimum := 1;
    v_maximum := 365;
  elsif new.key = 'minimum_lead_time_minutes' then
    v_property := 'minutes';
    v_minimum := 0;
    v_maximum := 10080;
  elsif new.key = 'booking_hold_minutes' then
    v_property := 'minutes';
    v_minimum := 5;
    v_maximum := 60;
  else
    return new;
  end if;

  v_value_text := new.value ->> v_property;
  if jsonb_object_length(new.value) <> 1 or v_value_text is null or v_value_text !~ '^[0-9]+$' then
    raise exception 'Booking setting value is invalid';
  end if;
  v_value := v_value_text::integer;
  if v_value < v_minimum or v_value > v_maximum or new.is_public then
    raise exception 'Booking setting is outside its permitted range or visibility';
  end if;
  return new;
end
$$;
create trigger validate_business_setting_before_save
  before insert or update on public.business_settings
  for each row execute function public.validate_business_setting();

create or replace function public.reserve_refund(
  p_payment_id uuid,
  p_amount_paise bigint,
  p_request_id uuid,
  p_reason text,
  p_actor_id uuid
)
returns table (refund_id uuid, already_exists boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_existing public.refunds%rowtype;
  v_refund_id uuid;
  v_reserved_amount bigint;
begin
  if p_amount_paise <= 0 or p_request_id is null or p_actor_id is null then
    raise exception 'Refund request is invalid';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = p_actor_id and u.raw_app_meta_data ->> 'role' = 'admin'
  ) then
    raise exception 'Administrator access is required';
  end if;

  select * into v_payment
  from public.payments p
  where p.id = p_payment_id
  for update;
  if not found or v_payment.provider_payment_id is null
    or v_payment.status not in ('captured', 'partially_refunded') then
    raise exception 'Only a captured payment can be refunded';
  end if;

  select r.* into v_existing
  from public.refunds r
  where r.idempotency_key = p_request_id::text
  for update;
  if found then
    if v_existing.payment_id <> p_payment_id
      or v_existing.amount_paise <> p_amount_paise
      or v_existing.initiated_by <> p_actor_id then
      raise exception 'Refund request id was already used for a different request';
    end if;
    return query select v_existing.id, true;
    return;
  end if;

  select coalesce(sum(r.amount_paise), 0)::bigint into v_reserved_amount
  from public.refunds r
  where r.payment_id = p_payment_id and r.status in ('pending', 'processed');
  if p_amount_paise > v_payment.amount_paise - v_reserved_amount then
    raise exception 'Refund exceeds the unrefunded payment amount';
  end if;

  insert into public.refunds (payment_id, amount_paise, reason, status, initiated_by, idempotency_key)
  values (p_payment_id, p_amount_paise, nullif(left(p_reason, 500), ''), 'pending', p_actor_id, p_request_id::text)
  returning id into v_refund_id;
  return query select v_refund_id, false;
end
$$;

revoke all on function public.reserve_refund(uuid, bigint, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reserve_refund(uuid, bigint, uuid, text, uuid) to service_role;
