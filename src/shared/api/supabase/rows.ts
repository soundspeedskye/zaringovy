import type {
  CommentReactionEmoji,
  RoomPostReactionEmoji,
} from '@/shared/api/types';
import type { ExpenseCategory } from '@/shared/model/types';

/** Supabase 테이블·뷰가 돌려주는 행의 모양. 앱 타입과 1:1이 아니다. */
export type JsonObject = Record<string, unknown>;

export type DatabaseExpenseCategory = 'lunch' | 'coffee' | 'snack' | 'dinner' | 'essential' | 'luxury';

export const CATEGORY_TO_DATABASE: Record<ExpenseCategory, DatabaseExpenseCategory> = {
  점심: 'lunch',
  커피: 'coffee',
  간식: 'snack',
  저녁: 'dinner',
  필수품: 'essential',
  사치품: 'luxury',
};

export const CATEGORY_FROM_DATABASE: Record<DatabaseExpenseCategory, ExpenseCategory> = {
  lunch: '점심',
  coffee: '커피',
  snack: '간식',
  dinner: '저녁',
  essential: '필수품',
  luxury: '사치품',
};

export type ProfileRow = {
  id: string;
  nickname: string;
  avatar_key: string | null;
  avatar_path: string | null;
  nickname_changed_at: string | null;
};

export type RoomRow = {
  id: string;
  name: string;
  owner_id: string;
  base_amount: number | string;
  capacity: number;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
};

export type RoomMemberRow = {
  room_id: string;
  user_id: string;
  role: 'owner' | 'member';
  status: 'active' | 'left' | 'removed' | 'account_deleted';
  joined_at: string;
  nickname_change_required: boolean | null;
};

export type PeriodStatusRow = {
  id: string;
  room_id: string;
  week_index: number;
  week_start: string;
  week_end: string;
  selected_day_count: number;
  valid_day_count: number;
  holiday_version_id: string;
  finalized_at: string | null;
  created_at: string;
  state: 'waiting' | 'active' | 'adjustment' | 'settling' | 'archived';
};

export type PeriodDayRow = {
  period_id: string;
  day_on: string;
  is_holiday: boolean;
};

export type PeriodMemberRow = {
  period_id: string;
  user_id: string;
  status: 'active' | 'left' | 'removed' | 'account_deleted';
  joined_at: string;
  joined_on: string;
  is_late_join: boolean;
  eligible_day_count: number;
  applied_limit: number | string;
};

export type PeriodResultRow = {
  period_id: string;
  room_id: string;
  user_id: string;
  nickname_snapshot: string;
  applied_limit: number | string;
  spent_amount: number | string;
  remaining_amount: number | string;
  achieved: boolean;
  is_crown: boolean;
  finalized_at: string;
};

export type RoomMemberStatsRow = {
  room_id: string;
  user_id: string;
  participated_week_count: number;
  achieved_week_count: number;
  crown_count: number;
  current_streak: number;
};

export type InviteCodeRow = {
  room_id: string;
  code: string;
  is_active: boolean;
};

export type ExpenseRow = {
  id: string;
  client_request_id: string;
  period_id: string | null;
  user_id: string;
  amount: number | string;
  point_amount: number | string;
  category: DatabaseExpenseCategory;
  memo: string | null;
  photo_path: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
};

export type CommentRow = {
  id: string;
  client_request_id: string;
  expense_id: string;
  user_id: string;
  body?: string | null;
  reply_to_comment_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
};

export type CommentReactionRow = {
  comment_id: string;
  user_id: string;
  emoji: CommentReactionEmoji;
  created_at: string;
};

export type CommentMentionRow = {
  comment_id: string;
  mentioned_user_id: string;
  start_offset: number;
  end_offset: number;
  display_name: string;
};

export type NotificationRow = {
  id: string;
  user_id: string;
  kind: string;
  actor_id: string | null;
  room_id: string | null;
  period_id: string | null;
  expense_id: string | null;
  comment_id: string | null;
  post_id: string | null;
  body?: string | null;
  route: string;
  read_at: string | null;
  created_at: string;
};

export type WinnerNudgeGrantRow = {
  id: string;
  room_id: string;
  max_send_count: number | null;
  daily_limit: number;
  sent_count: number;
  daily_sent_count: number;
  daily_send_on: string | null;
  last_sent_at: string | null;
  expires_at: string;
};

export type RoomPostRow = {
  id: string;
  client_request_id: string;
  room_id: string;
  period_id: string | null;
  kind: 'notice' | 'post' | 'poll';
  category: 'frugality' | 'secret_purchase' | 'chat' | null;
  author_id: string;
  title: string;
  body: string | null;
  poll_closes_at: string | null;
  photo_path: string | null;
  secret_purchase_amount: number | string | null;
  secret_purchase_occurred_at: string | null;
  secret_purchase_category: DatabaseExpenseCategory | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
};

export type ExpenseReadRow = {
  expense_id: string;
  user_id: string;
  read_at: string;
};

export type RoomPostReadRow = {
  post_id: string;
  user_id: string;
  read_at: string;
};

export type RoomPostCommentRow = {
  id: string;
  client_request_id: string;
  post_id: string;
  author_id: string;
  body: string | null;
  reply_to_comment_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
};

export type RoomPostReactionRow = {
  post_id: string;
  user_id: string;
  emoji: RoomPostReactionEmoji;
  created_at: string;
};

export type RoomPostPollOptionRow = {
  id: string;
  post_id: string;
  body: string;
  position: number;
};

export type RoomPostPollVoteRow = {
  post_id: string;
  option_id: string;
  user_id: string;
  created_at: string;
};

export type PreferenceRow = {
  room_id: string;
  is_hidden: boolean;
};

export type ExpenseExceptionRow = {
  expense_id: string;
  reason: string;
  requested_by: string;
  requested_at: string;
};

export type ExpenseExceptionResponseRow = {
  expense_id: string;
  user_id: string;
  decision: 'approved' | 'held';
  created_at: string;
};
