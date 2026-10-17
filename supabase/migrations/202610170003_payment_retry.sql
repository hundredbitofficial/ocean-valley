create unique index payments_one_created_attempt_per_booking_idx
  on public.payments (booking_id)
  where status = 'created';

create or replace function public.prepare_booking_payment(
  p_booking_id uuid,
  p_customer_id uuid
)
returns table (
  payment_id uuid,
  provider_order_id text,
  amount_paise bigint,
  booking_reference text,
  order_in_progress boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype;
begin
  select * into v_booking
  from public.bookings b
  where b.id = p_booking_id
  for update;
  if not found or v_booking.customer_id <> p_customer_id then
    raise exception 'Appointment could not be found';
  end if;
  if v_booking.status not in ('pending_payment', 'payment_failed')
    or v_booking.hold_expires_at <= now() then
    raise exception 'Appointment hold has expired or is not payable';
  end if;
  if v_booking.advance_due_paise <= 0 then
    raise exception 'Required advance amount is not configured';
  end if;

  if v_booking.status = 'payment_failed' then
    update public.bookings set status = 'pending_payment', payment_status = 'pending' where id = v_booking.id;
  end if;

  select * into v_payment
  from public.payments p
  where p.booking_id = v_booking.id and p.status = 'created'
  limit 1
  for update;
  if found then
    return query select v_payment.id, v_payment.provider_order_id,
      v_payment.amount_paise, v_booking.reference, v_payment.provider_order_id is null;
    return;
  end if;

  insert into public.payments (
    booking_id, provider, amount_paise, currency, status, idempotency_key
  ) values (
    v_booking.id, 'razorpay', v_booking.advance_due_paise, 'INR', 'created', gen_random_uuid()::text
  )
  returning * into v_payment;
  return query select v_payment.id, null::text, v_payment.amount_paise, v_booking.reference, false;
end
$$;

revoke all on function public.prepare_booking_payment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.prepare_booking_payment(uuid, uuid) to service_role;

alter table public.notifications
  add column next_attempt_at timestamptz not null default now();
create unique index notifications_booking_channel_event_idx
  on public.notifications (booking_id, channel, event_type);

create or replace function public.claim_notifications(p_batch_size integer default 20)
returns table (
  notification_id uuid,
  booking_id uuid,
  channel text,
  event_type text,
  recipient text,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_batch_size not between 1 and 100 then
    raise exception 'Notification batch size is invalid';
  end if;
  return query
  with picked as (
    select n.id from public.notifications n
    where n.status in ('queued', 'retrying')
      and n.attempt_count < 5
      and n.next_attempt_at <= now()
    order by n.next_attempt_at, n.created_at
    for update skip locked
    limit p_batch_size
  )
  update public.notifications n
  set status = 'retrying', attempt_count = n.attempt_count + 1, updated_at = now()
  from picked
  where n.id = picked.id
  returning n.id, n.booking_id, n.channel, n.event_type, n.recipient, n.attempt_count;
end
$$;
revoke all on function public.claim_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_notifications(integer) to service_role;
