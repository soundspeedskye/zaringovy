-- Edge Functions run their internal data access through the service_role key.
-- Keep browser roles excluded; grant only the tables and operations used by
-- send-push, send-winner-nudge, and deliver-room-notice-push.
grant select on table
  public.profiles,
  public.notifications,
  public.room_posts,
  public.device_push_tokens
to service_role;

grant update (is_enabled) on table public.device_push_tokens to service_role;
