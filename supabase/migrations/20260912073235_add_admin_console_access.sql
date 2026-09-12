-- Administrator access for the operator console. Admin membership lives in its
-- own table instead of a `profiles` column: `profiles_update_self` lets a user
-- write their own row without a column filter, so an `is_admin` column there
-- would let anyone promote themselves. No policy grants users any access to
-- this table, so membership can only be changed out of band.
create table public.admin_users (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  note text,
  granted_at timestamptz not null default now(),
  constraint admin_users_note_length check (note is null or char_length(note) <= 200)
);

alter table public.admin_users enable row level security;

-- RLS helper functions live outside exposed schemas. This one intentionally
-- bypasses RLS for the membership lookup and never trusts user metadata.
create function private.is_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from public.admin_users a where a.user_id = p_user_id
  );
$$;

-- The console calls this to decide whether to render the admin menu. Reading it
-- is the only way a client learns its own admin state; `admin_users` stays
-- invisible to every client role.
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_admin((select auth.uid()));
$$;

-- Report queue. Reporters keep their existing `reports_read_own` access; these
-- permissive policies widen reads to admins and are the only write path for
-- triage besides the RPC below.
create policy reports_read_admin
on public.reports
for select
to authenticated
using (private.is_admin((select auth.uid())));

-- A report names a reporter and a target who usually share no room with the
-- admin, so the queue cannot render without widening profile reads.
create policy profiles_select_admin
on public.profiles
for select
to authenticated
using (private.is_admin((select auth.uid())));

-- Status changes go through this RPC rather than a bare update policy: the
-- `reports_status_time` constraint ties `resolved_at` to the status, and every
-- triage decision has to leave an audit trail.
create function private.update_report_status_impl(
  p_report_id uuid,
  p_status public.report_status,
  p_actor_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_previous public.report_status;
begin
  if not private.is_admin(p_actor_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select status into v_previous
  from public.reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;

  update public.reports
  set status = p_status,
      resolved_at = case
        when p_status in ('resolved', 'dismissed') then now()
        else null
      end
  where id = p_report_id;

  perform private.write_audit_event(
    p_actor_id,
    'report_status_changed',
    'report',
    p_report_id,
    jsonb_build_object('from', v_previous, 'to', p_status)
  );
end;
$$;

create function public.update_report_status(
  p_report_id uuid,
  p_status public.report_status
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select private.update_report_status_impl(p_report_id, p_status, (select auth.uid()));
$$;

grant execute on function private.is_admin(uuid) to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.update_report_status(uuid, public.report_status) to authenticated;
