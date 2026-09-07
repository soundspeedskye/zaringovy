import type { SupabaseClient } from "@supabase/supabase-js";

import { translateError } from "./errors";
import { rows } from "./results";
import type {
  CommentReactionRow,
  CommentMentionRow,
  CommentRow,
  ExpenseExceptionResponseRow,
  ExpenseExceptionRow,
  ExpenseRow,
  NotificationRow,
  RoomPostCommentRow,
  RoomPostPollOptionRow,
  RoomPostPollVoteRow,
  RoomPostReactionRow,
  RoomPostRow,
} from "./rows";

/** 스냅샷을 채우는 테이블 조회. 클라이언트 외에는 아무 상태도 쓰지 않는다. */

export const EXPENSE_COLUMNS =
  "id,client_request_id,period_id,user_id,amount,point_amount,category,memo,photo_path,occurred_at,created_at,updated_at,deleted_at,version";
export const COMMENT_COLUMNS =
  "id,client_request_id,expense_id,user_id,body,reply_to_comment_id,created_at,updated_at,deleted_at,version";
export const NOTIFICATION_COLUMNS =
  "id,user_id,kind,actor_id,room_id,period_id,expense_id,comment_id,post_id,route,body,read_at,created_at";
export const ROOM_POST_COLUMNS =
  "id,client_request_id,room_id,period_id,kind,category,author_id,title,body,poll_closes_at,photo_path,secret_purchase_amount,secret_purchase_occurred_at,secret_purchase_category,created_at,updated_at,deleted_at,version";
export const ROOM_POST_COMMENT_COLUMNS =
  "id,client_request_id,post_id,author_id,body,reply_to_comment_id,created_at,updated_at,deleted_at,version";

export async function fetchExpenseRows(
  client: SupabaseClient,
): Promise<ExpenseRow[]> {
  const result = await client
    .from("expenses")
    .select(EXPENSE_COLUMNS)
    .order("created_at", { ascending: false });
  if (result.error) {
    throw translateError(result.error, "지출 데이터를 갱신하지 못했어요.");
  }
  return rows<ExpenseRow>(result.data);
}

export async function fetchCommentRows(
  client: SupabaseClient,
): Promise<CommentRow[]> {
  const result = await client
    .from("comments")
    .select(COMMENT_COLUMNS)
    .order("created_at", { ascending: true });
  if (result.error) {
    throw translateError(result.error, "댓글 데이터를 갱신하지 못했어요.");
  }
  return rows<CommentRow>(result.data);
}

export async function fetchCommentReactionRows(
  client: SupabaseClient,
): Promise<CommentReactionRow[]> {
  const result = await client
    .from("comment_reactions")
    .select("comment_id,user_id,emoji,created_at");
  if (result.error) {
    throw translateError(result.error, "댓글 반응을 갱신하지 못했어요.");
  }
  return rows<CommentReactionRow>(result.data);
}

export async function fetchCommentMentionRows(
  client: SupabaseClient,
  commentIds?: readonly string[],
): Promise<CommentMentionRow[]> {
  let query = client
    .from("comment_mentions")
    .select("comment_id,mentioned_user_id,start_offset,end_offset,display_name")
    .order("comment_id", { ascending: true })
    .order("start_offset", { ascending: true });
  if (commentIds?.length) query = query.in("comment_id", commentIds);
  const result = await query;
  if (result.error) {
    throw translateError(result.error, "댓글 멘션을 갱신하지 못했어요.");
  }
  return rows<CommentMentionRow>(result.data);
}

export async function fetchRoomPostRows(
  client: SupabaseClient,
): Promise<RoomPostRow[]> {
  const result = await client
    .from("room_posts")
    .select(ROOM_POST_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(200);
  if (result.error)
    throw translateError(result.error, "기록을 갱신하지 못했어요.");
  return rows<RoomPostRow>(result.data);
}

export async function fetchRoomPostCommentRows(
  client: SupabaseClient,
): Promise<RoomPostCommentRow[]> {
  const result = await client
    .from("room_post_comments")
    .select(ROOM_POST_COMMENT_COLUMNS)
    .order("created_at", { ascending: true });
  if (result.error)
    throw translateError(result.error, "기록 댓글을 갱신하지 못했어요.");
  return rows<RoomPostCommentRow>(result.data);
}

export async function fetchRoomPostReactionRows(
  client: SupabaseClient,
): Promise<RoomPostReactionRow[]> {
  const result = await client
    .from("room_post_reactions")
    .select("post_id,user_id,emoji,created_at");
  if (result.error)
    throw translateError(result.error, "기록 반응을 갱신하지 못했어요.");
  return rows<RoomPostReactionRow>(result.data);
}

export async function fetchExpenseReadRows(
  client: SupabaseClient,
): Promise<import("./rows").ExpenseReadRow[]> {
  const result = await client
    .from("expense_reads")
    .select("expense_id,user_id,read_at");
  if (result.error)
    throw translateError(result.error, "읽음 상태를 갱신하지 못했어요.");
  return rows<import("./rows").ExpenseReadRow>(result.data);
}

export async function fetchRoomPostReadRows(
  client: SupabaseClient,
): Promise<import("./rows").RoomPostReadRow[]> {
  const result = await client
    .from("room_post_reads")
    .select("post_id,user_id,read_at");
  if (result.error)
    throw translateError(result.error, "읽음 상태를 갱신하지 못했어요.");
  return rows<import("./rows").RoomPostReadRow>(result.data);
}

export async function fetchRoomPostPollOptionRows(
  client: SupabaseClient,
): Promise<RoomPostPollOptionRow[]> {
  const result = await client
    .from("room_post_poll_options")
    .select("id,post_id,body,position")
    .order("position", { ascending: true });
  if (result.error)
    throw translateError(result.error, "투표 선택지를 갱신하지 못했어요.");
  return rows<RoomPostPollOptionRow>(result.data);
}

export async function fetchRoomPostPollVoteRows(
  client: SupabaseClient,
): Promise<RoomPostPollVoteRow[]> {
  const result = await client
    .from("room_post_poll_votes")
    .select("post_id,option_id,user_id,created_at");
  if (result.error)
    throw translateError(result.error, "투표 결과를 갱신하지 못했어요.");
  return rows<RoomPostPollVoteRow>(result.data);
}

export async function fetchNotificationRows(
  client: SupabaseClient,
): Promise<NotificationRow[]> {
  const result = await client
    .from("notifications")
    .select(NOTIFICATION_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(100);
  if (result.error) {
    throw translateError(result.error, "소식 데이터를 갱신하지 못했어요.");
  }
  return rows<NotificationRow>(result.data);
}

export async function fetchWinnerNudgeGrantRows(client: SupabaseClient): Promise<import("./rows").WinnerNudgeGrantRow[]> {
  const result = await client
    .from("winner_nudge_grants")
    .select("id,room_id,max_send_count,daily_limit,sent_count,daily_sent_count,daily_send_on,last_sent_at,expires_at")
    .order("expires_at", { ascending: false });
  if (result.error) throw translateError(result.error, "우승자 발송권을 불러오지 못했어요.");
  return rows<import("./rows").WinnerNudgeGrantRow>(result.data);
}

export async function fetchExceptionRows(
  client: SupabaseClient,
): Promise<ExpenseExceptionRow[]> {
  const result = await client
    .from("expense_exceptions")
    .select("expense_id,reason,requested_by,requested_at");
  if (result.error) {
    throw translateError(result.error, "예외 데이터를 갱신하지 못했어요.");
  }
  return rows<ExpenseExceptionRow>(result.data);
}

export async function fetchExceptionResponseRows(
  client: SupabaseClient,
): Promise<ExpenseExceptionResponseRow[]> {
  const result = await client
    .from("expense_exception_approvals")
    .select("expense_id,user_id,decision,created_at");
  if (result.error) {
    throw translateError(result.error, "예외 승인 데이터를 갱신하지 못했어요.");
  }
  return rows<ExpenseExceptionResponseRow>(result.data);
}
