import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  attempts: [] as any[], assigned: true, completed: false, owner: 'student',
  rpc: vi.fn(),
}));
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = { middleware: () => chain, inputValidator: () => chain, handler: (fn: unknown) => fn };
    return chain;
  },
}));
vi.mock('@/integrations/supabase/auth-middleware', () => ({ requireSupabaseAuth: {} }));
vi.mock('@/integrations/supabase/client.server', () => ({
  supabaseAdmin: {
    rpc: state.rpc,
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        maybeSingle: async () => ({ data: state.attempts.find(a => Object.entries(filters).every(([k,v]) => a[k] === v)) ?? null, error: null }),
        single: async () => ({ data: table === 'tasks' ? { correct_answer: 'yes', subject_id: 'subject' } : null, error: null }),
        insert: async (row: any) => { state.attempts.push({ ...row, id: 'attempt' }); return { error: null }; },
      };
      return q;
    },
  },
}));
import { submitLessonTaskAttempt, completeLesson } from '../src/lib/lesson.functions';

const context = () => ({ userId: 'student', supabase: {
  from: (table: string) => {
    const q: any = { select: () => q, eq: () => q,
      single: async () => ({ data: { user_id: state.owner, status: state.completed ? 'completed' : 'planned', student_profile_id: 'profile' }, error: null }),
      maybeSingle: async () => ({ data: table === 'lesson_tasks' && state.assigned ? { task_id: 'task' } : null, error: null }) };
    return q;
  },
} });
const submit = (answer = 'yes') => (submitLessonTaskAttempt as any)({ data: { lesson_id:'lesson', task_id:'task', student_answer:answer }, context:context() });

beforeEach(() => { state.attempts=[]; state.assigned=true; state.completed=false; state.owner='student'; state.rpc.mockReset(); });
describe('authenticated lesson server functions', () => {
  it('rejects unowned lessons and unassigned tasks before privileged writes', async () => {
    state.owner='other'; await expect(submit()).rejects.toThrow('Forbidden');
    state.owner='student'; state.assigned=false; await expect(submit()).rejects.toThrow('не входит');
    expect(state.attempts).toHaveLength(0);
  });
  it('preserves an unverified historical attempt and returns the trusted winning attempt on retry', async () => {
    state.attempts.push({ user_id:'student', lesson_id:'lesson', task_id:'task', validated_by_server:false });
    expect(await submit()).toMatchObject({ is_correct:true, already_submitted:false });
    expect(await submit('different')).toMatchObject({ is_correct:true, already_submitted:true });
    expect(state.attempts).toHaveLength(2);
  });
  it('binds the atomic completion RPC to the authenticated user and has no partial-write fallback', async () => {
    state.rpc.mockResolvedValue({ data:null, error:{ message:'RPC unavailable' } });
    await expect((completeLesson as any)({ data:{ lesson_id:'lesson', user_id:'attacker' }, context:context() })).rejects.toThrow('RPC unavailable');
    expect(state.rpc).toHaveBeenCalledWith('complete_lesson_atomic',{ p_lesson_id:'lesson', p_user_id:'student' });
    expect(state.attempts).toHaveLength(0);
  });
});
