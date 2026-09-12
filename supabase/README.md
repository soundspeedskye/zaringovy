# Jaringoby Supabase contract

The database is the authority for challenge limits, membership capacity, the
`S/E/C/F` boundaries, expense eligibility, comment edit windows, archive
snapshots, and RLS. Mobile clients must not write challenge, membership,
expense, comment, or archive tables directly; call the RPCs below.

## Authentication

- Every app table and RPC requires the `authenticated` database role.
- Anonymous sign-in is disabled in `config.toml`.
- Use a publishable key plus a real user access token. Never ship a secret or
  `service_role` key; app tables explicitly revoke its Data API grants.
- `profiles` rows are created from `auth.users` by a trigger. `nickname` may be
  updated directly by its owner.

### RPC security boundary

Public RPC wrappers are `SECURITY INVOKER`. Their privileged implementations
are `SECURITY DEFINER` functions in the non-exposed `private` schema, use an
empty `search_path`, and validate `auth.uid()` before touching data. The Data
API exposes only `public` and `graphql_public`, so PostgREST cannot route a
client request directly to `private.*`.

The `authenticated` role needs narrowly-scoped `USAGE` on `private` and
`EXECUTE` on the implementation functions because a security-invoker wrapper
executes as its caller. The same applies to the three membership helpers used
inside RLS expressions. It receives no private table access and no schema
`CREATE` privilege. Removing these grants would break the public invoker RPCs;
making the public wrappers security-definer instead would enlarge the exposed
privileged surface.

## Stable enums

| Database value | Korean label |
|---|---|
| `lunch` | 점심 |
| `coffee` | 커피 |
| `snack` | 간식 |
| `dinner` | 저녁 |
| `essential` | 필수품 |
| `luxury` | 사치품 |

Challenge states returned by `challenge_status_view.state` are `waiting`,
`active`, `adjustment`, `settling`, and `archived`. Member statuses are
`active`, `left`, `removed`, and `account_deleted`.

## Public RPCs

All parameter names are part of the client contract.

| RPC | Parameters | Return |
|---|---|---|
| `create_challenge` | `p_name text`, `p_start_on date`, `p_end_on date`, `p_base_amount int8`, `p_capacity int2`, `p_holiday_version text` (nullable selects current), `p_client_request_id uuid` | one `challenges` row; idempotent by creator/request ID |
| `preview_invite` | `p_invite_code text` | JSON object described below; never exposes the feed |
| `join_challenge` | `p_invite_code text` | JSON object described below; serialized capacity check |
| `update_challenge_settings` | `p_challenge_id uuid`, `p_name text?`, `p_capacity int2?` | one `challenges` row; period/budget remain immutable |
| `rotate_invite_code` | `p_challenge_id uuid` | new six-character code as text |
| `leave_challenge` | `p_challenge_id uuid`, `p_successor_user_id uuid?` | caller's `challenge_members` row; owner must supply a successor |
| `delete_challenge` | `p_challenge_id uuid` | boolean; only owner, before `S`, with no shared expense |
| `add_expense` | `p_challenge_id uuid?`, `p_amount int8`, `p_category expense_category`, `p_occurred_at timestamptz`, `p_memo text?`, `p_photo_path text?`, `p_client_request_id uuid` | one `expenses` row; idempotent by user/request ID |
| `update_expense` | `p_expense_id uuid`, `p_amount int8`, `p_category expense_category`, `p_occurred_at timestamptz`, `p_memo text?`, `p_photo_path text?`, `p_expected_version int4` | updated `expenses` row |
| `delete_expense` | `p_expense_id uuid`, `p_expected_version int4` | soft-deleted `expenses` row |
| `add_comment` | `p_expense_id uuid`, `p_body text`, `p_reply_to_comment_id uuid?`, `p_client_request_id uuid` | one `comments` row; idempotent by user/request ID |
| `update_comment` | `p_comment_id uuid`, `p_body text`, `p_expected_version int4` | updated `comments` row; only within five minutes |
| `delete_comment` | `p_comment_id uuid`, `p_expected_version int4` | soft-deleted `comments` row |
| `add_room_post` | `p_room_id uuid`, `p_kind room_post_kind`, `p_body text`, `p_options text[]?`, `p_client_request_id uuid` | one room post; polls require 2–4 distinct options |
| `vote_room_post_poll` | `p_post_id uuid`, `p_option_id uuid` | one vote per active member; a later choice replaces the previous one |
| `finalize_challenge` | `p_challenge_id uuid` | one `challenge_archives` row; idempotent after `F` |

`preview_invite` success:

```json
{
  "ok": true,
  "challenge": {
    "id": "uuid",
    "name": "string",
    "start_on": "YYYY-MM-DD",
    "end_on": "YYYY-MM-DD",
    "starts_at": "timestamptz",
    "ends_at": "timestamptz",
    "base_amount": 50000,
    "currency": "KRW",
    "timezone": "Asia/Seoul",
    "capacity": 10,
    "member_count": 2,
    "selected_day_count": 5,
    "valid_day_count": 4,
    "holiday_version_id": "string"
  },
  "join": {
    "joined_on": "YYYY-MM-DD",
    "eligible_day_count": 3,
    "applied_limit": 30000,
    "is_late_join": true,
    "can_join": true
  },
  "holidays": [{"date": "YYYY-MM-DD", "name": "string"}]
}
```

`preview_invite` failure returns `{"ok":false,"error_code":"..."}`.
`join_challenge` success returns
`{"ok":true,"member":{...challenge_members row...},"idempotent":boolean}`.
Join failures use `INVALID_CODE`, `RATE_LIMITED`, `CHALLENGE_CLOSED`,
`CAPACITY_FULL`, `NO_ELIGIBLE_DAYS`, or `ALREADY_PARTICIPATED`.

## Read model

| Relation | Important columns / use |
|---|---|
| `profiles` | `id`, `nickname`, `avatar_path`, `notifications_enabled` |
| `holiday_calendar_versions` | server dataset `id`, coverage, source, `is_current` |
| `korean_holidays` | `(version_id, holiday_on)`, `name` |
| `challenges` | fixed dates/amount/timezone/version plus `capacity`, `owner_id`, `S/E/C/F` timestamps |
| `challenge_days` | immutable selected-day snapshot with `is_holiday`, `holiday_name` |
| `challenge_members` | `joined_at`, `joined_on`, `eligible_day_count`, `applied_limit`, late/status/role |
| `invite_codes` | active room code; readable only by active members |
| `expenses` | single personal/challenge record, six-value category, photo path, optimistic `version`, soft-delete/exclusion fields |
| `comments` | expense thread, optional single `reply_to_comment_id`, optimistic `version`, soft deletion |
| `challenge_status_view` | challenge metadata plus server-derived `state` |
| `challenge_member_progress` | nickname, applied/spent/remaining amounts, progress, achieved, `is_crown` (ties allowed) |
| `challenge_archives` | frozen conditions JSON, overall result, crown user IDs, C/F times |
| `challenge_member_results` | frozen per-member calculation/result rows |
| `user_challenge_preferences` | per-user hide and notification settings |
| `reports`, `blocks` | safety controls scoped by RLS |
| `notifications` | owner-only kind/actor/entity/route/read state; `winner_nudge`에는 80자 이하 본문도 저장 |
| `room_posts`, `room_post_poll_options`, `room_post_poll_votes` | member-scoped board posts and single-choice poll data; direct writes are RPC-only |
| `device_push_tokens` | owner-only iOS/Android token registration and enable state |

Members can read all room expenses/comments including records created before
they joined. Non-members cannot read room rows or private photos.

## Room nickname uniqueness

Nicknames stay globally non-unique. Inside one room they must differ, because a
room's posts, comments, and expenses identify their author by nickname alone.

- `update_my_nickname` rejects a nickname already held by another **active**
  member of any room the caller belongs to, raising `ROOM_NICKNAME_TAKEN`.
  Comparison ignores case, surrounding whitespace, and Unicode composition.
- Joining (`join_room`, and `switch_room` through it) never fails on a duplicate.
  The later arrival's `room_members.nickname_change_required` is set instead,
  inside the same transaction that locks the room, so concurrent joins settle
  consistently and only the newcomer is marked.
- A marked member may not write in that room. Enforcement is a `BEFORE` trigger
  on the participation tables (expenses, comments, comment reactions/mentions,
  expense exceptions and approvals, room posts, post comments/reactions/polls),
  so no RPC — present or future — can bypass it. It raises
  `NICKNAME_CHANGE_REQUIRED` with SQLSTATE `42501`. `is_active_period_member`
  carries the same rule so the `expense-photos` upload policy is closed too.
  Reading, marking read, leaving the room, and editing the profile stay open.
- The seven-day nickname cooldown still applies. Only a member the server itself
  sees as marked may change a nickname inside that window; a client-supplied
  flag is never trusted. A successful change clears the mark and restarts the
  cooldown from that moment.

`supabase/tests/nickname_uniqueness_test.sql` covers these rules; run it against
a local stack with `supabase db reset` followed by `psql -f`.

## Storage

- `expense-photos` is private, 10 MiB. Upload challenge photos to
  `{challenge-id}/{auth-user-id}/{unique-object-name}` before calling
  `add_expense`; personal paths use `personal/{auth-user-id}/{name}`.
- `profile-images` is private, 5 MiB. Paths are
  `{auth-user-id}/{unique-object-name}`.
- Allowed MIME types: JPEG, PNG, WebP, HEIC, HEIF.
- A referenced, non-deleted expense photo cannot be overwritten or deleted;
  upload a new path, update the expense before `C`, then delete the orphan.

## Notifications

- Successful joins create `member_joined` rows for existing active members and
  `capacity_full` for the owner when the last seat is filled.
- Comments on another member's expense create `expense_comment`; replies create
  `comment_reply` for the referenced author. Dedupe keys make retries harmless.
- Notification rows contain only identifiers and a route such as
  `/challenges/{id}/expenses/{id}`. Comment text is never copied into them.
- Clients subscribe to `notifications` over Realtime, filter by `user_id`, and
  may update only `read_at`.
- Time-boundary/limit notifications and FCM delivery workers are implemented in
  the mobile repository; the production project now has the FCM migration,
  Secret, and Edge Function deployments described in the push operations guide.

## Holiday ingestion

No unofficial production calendar is seeded. An operator must insert one
published `holiday_calendar_versions` row with complete coverage and its
`korean_holidays` rows, then mark that version `is_current = true`.
