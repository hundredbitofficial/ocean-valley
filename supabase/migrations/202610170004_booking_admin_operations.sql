create or replace function public.enforce_booking_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending_payment' and new.status in ('confirmed','cancelled','payment_failed','expired'))
      or (old.status = 'payment_failed' and new.status in ('pending_payment','confirmed','cancelled','expired'))
      or (old.status = 'confirmed' and new.status in ('cancelled','completed','no_show'))
    ) then
      raise exception 'Invalid booking status transition';
    end if;
    v_reason := nullif(current_setting('app.booking_transition_reason', true), '');
    insert into public.booking_status_history (booking_id, old_status, new_status, actor_user_id, reason)
    values (new.id, old.status, new.status, auth.uid(), coalesce(v_reason, new.cancellation_reason));
  end if;
  new.updated_at = now();
  return new;
end
$$;

create or replace function public.admin_update_booking_status(
  p_booking_id uuid,
  p_status text,
  p_reason text default null
)
returns table (booking_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;
  if p_status is null or p_status not in ('cancelled','completed','no_show') then
    raise exception 'Unsupported booking status';
  end if;
  if p_status = 'cancelled' and nullif(trim(p_reason), '') is null then
    raise exception 'A cancellation reason is required';
  end if;
  if p_reason is not null and length(trim(p_reason)) > 500 then
    raise exception 'Reason must be 500 characters or fewer';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'Appointment could not be found'; end if;
  if v_booking.status = p_status then raise exception 'Appointment already has this status'; end if;
  if p_status = 'cancelled' and v_booking.status not in ('pending_payment','payment_failed','confirmed') then
    raise exception 'This appointment cannot be cancelled in its current state';
  end if;
  if p_status = 'cancelled' and v_booking.status = 'pending_payment'
    and exists (
      select 1 from public.payments p
      where p.booking_id = p_booking_id and p.status in ('created','captured')
    ) then
    raise exception 'This appointment has an unresolved payment attempt and cannot be cancelled yet';
  end if;
  if p_status in ('completed','no_show') and v_booking.status <> 'confirmed' then
    raise exception 'Only confirmed appointments can be completed or marked no-show';
  end if;

  perform set_config('app.booking_transition_reason', coalesce(nullif(trim(p_reason), ''), ''), true);
  update public.bookings
  set status = p_status,
      cancellation_reason = case when p_status = 'cancelled' then nullif(trim(p_reason), '') else cancellation_reason end
  where id = p_booking_id;

  if p_status = 'cancelled' then
    update public.coupon_redemptions
      set status = 'released', updated_at = now()
      where booking_id = p_booking_id and status = 'reserved';
  end if;
  return query select p_booking_id, p_status;
end
$$;

revoke all on function public.admin_update_booking_status(uuid, text, text) from public, anon;
grant execute on function public.admin_update_booking_status(uuid, text, text) to authenticated;

create or replace function public.admin_requeue_notification(p_notification_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notification public.notifications%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;
  select * into v_notification from public.notifications where id = p_notification_id for update;
  if not found then raise exception 'Notification could not be found'; end if;
  if v_notification.status <> 'failed' then raise exception 'Only failed notifications can be retried'; end if;

  update public.notifications
  set status = 'queued', attempt_count = 0, next_attempt_at = now(), last_error = null
  where id = p_notification_id;
  return p_notification_id;
end
$$;

revoke all on function public.admin_requeue_notification(uuid) from public, anon;
grant execute on function public.admin_requeue_notification(uuid) to authenticated;
