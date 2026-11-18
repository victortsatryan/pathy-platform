import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rpc: vi.fn(), completed: false }));
vi.mock('@tanstack/react-start', () => ({ createServerFn: () => {
  const chain = { middleware: () => chain, inputValidator: () => chain, handler: (fn: unknown) => fn };
  return chain;
} }));
vi.mock('@/integrations/supabase/auth-middleware', () => ({ requireSupabaseAuth: {} }));
vi.mock('@/integrations/supabase/client.server', () => ({ supabaseAdmin: {
  rpc: state.rpc,
  from: () => { const q: any = { select: () => q, eq: async () => ({ data: [{ task_id:'task', points:1, task:{ id:'task', topic_id:'topic', correct_answer:'yes' } }], error:null }) }; return q; },
} }));
import { completeDiagnosticSession } from '../src/lib/diagnostic.functions';
const context = () => ({ userId:'student', supabase:{ from: (table:string) => {
  const q:any = { select: () => q, eq: () => q,
    single: async () => ({ data:{ id:'session', user_id:'student', student_profile_id:'profile', subject_id:'subject', diagnostic_test_id:'test', status:state.completed ? 'completed' : 'in_progress', subject:{slug:'english'} }, error:null }),
    then: (resolve:any) => resolve({ data:[], error:null }),
  }; return q;
} } });
const complete = (answers:any[]) => (completeDiagnosticSession as any)({ context:context(), data:{ session_id:'session', user_id:'attacker', answers } });
beforeEach(() => { state.completed=false; state.rpc.mockReset(); state.rpc.mockResolvedValue({data:{status:'completed'},error:null}); });
describe('diagnostic server authority', () => {
  it('computes scores from the server answer key and binds the RPC to the caller', async () => {
    await complete([{task_id:'task',student_answer:'wrong',is_correct:true,points_awarded:100}]);
    expect(state.rpc).toHaveBeenCalledWith('complete_diagnostic_atomic', expect.objectContaining({p_user_id:'student',p_session_id:'session',p_answers:[expect.objectContaining({is_correct:false,points_awarded:0,max_points:1,answer_key_snapshot:'yes'})]}));
  });
  it('rejects foreign and repeated tasks before the privileged call', async () => {
    await expect(complete([{task_id:'other',student_answer:'yes'}])).rejects.toThrow('не входит');
    await expect(complete([{task_id:'task',student_answer:'yes'},{task_id:'task',student_answer:'yes'}])).rejects.toThrow('Повторяющееся');
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('leaves a completed historical session untouched', async () => {
    state.completed=true;
    expect((await complete([{task_id:'task',student_answer:'yes'}])).session.status).toBe('completed');
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
