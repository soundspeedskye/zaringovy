-- The recipient can see a grant as soon as settlement finalizes, without an
-- app restart. RLS on the table limits the realtime payload to its winner.
do $realtime_setup$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'winner_nudge_grants'
    ) then
    alter publication supabase_realtime add table public.winner_nudge_grants;
  end if;
end
$realtime_setup$;

-- The public entry point is definer-owned so callers cannot invoke the private
-- implementation directly. The implementation still checks auth.uid(), which
-- remains the requesting user's JWT identity inside a SECURITY DEFINER call.
create or replace function public.send_winner_nudge(p_room_id uuid, p_body text)
returns jsonb
language sql
security definer
set search_path = ''
as $$ select private.send_winner_nudge_impl(p_room_id, p_body); $$;

revoke all on function public.send_winner_nudge(uuid, text) from public, anon, service_role;
grant execute on function public.send_winner_nudge(uuid, text) to authenticated;
