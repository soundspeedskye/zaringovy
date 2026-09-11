import { getSupabaseClient } from '@/shared/api/supabase-client';

/** 인증된 사용자의 마지막 앱 활동 시각을 서버에 기록한다. */
export async function recordAppActivity(): Promise<void> {
  const { error } = await getSupabaseClient().rpc('record_app_activity');
  if (error) throw error;
}
