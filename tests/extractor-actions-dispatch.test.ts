import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@/integrations/supabase/client.server',()=>({supabaseAdmin:{rpc:state.rpc}}));
import { dispatchBatch } from '../src/lib/extractor/actions-dispatch.server';
const job='10000000-0000-4000-8000-000000000001', sha='a'.repeat(40);
beforeEach(()=>{state.rpc.mockReset().mockResolvedValue({error:null});vi.stubEnv('PATHY_ACTIONS_COST_APPROVED','true');vi.stubEnv('PATHY_ACTIONS_APPROVAL_ID','20000000-0000-4000-8000-000000000001');vi.stubEnv('PATHY_ACTIONS_APPROVED_JOB_ID',job);vi.stubEnv('PATHY_ACTIONS_DISPATCH_TOKEN','fixture');vi.stubEnv('PATHY_ACTIONS_CODE_SHA',sha);vi.stubEnv('PATHY_ACTIONS_REPOSITORY_ID','1419587278');});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('batch dispatch',()=>{
 it('requires a cost approval for the exact job before network or DB',async()=>{
  vi.stubEnv('PATHY_ACTIONS_APPROVED_JOB_ID','');const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  await expect(dispatchBatch(job,'admin')).rejects.toThrow('лимита');expect(fetchMock).not.toHaveBeenCalled();expect(state.rpc).not.toHaveBeenCalled();
 });
 it('pins main and sends only the opaque job ID',async()=>{
  const f=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({object:{sha}}))).mockResolvedValueOnce(new Response(null,{status:204}));vi.stubGlobal('fetch',f);
  await dispatchBatch(job,'admin');expect(state.rpc).toHaveBeenCalledWith('ext02_reserve_job',{p_job:job,p_user:'admin',p_sha:sha,p_approval:'20000000-0000-4000-8000-000000000001'});
  const body=JSON.parse(f.mock.calls[1][1].body);expect(body).toEqual({ref:'main',inputs:{job_id:job}});
 });
 it('rejects changed branch head before reservation',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({object:{sha:'b'.repeat(40)}}))));
  await expect(dispatchBatch(job,'admin')).rejects.toThrow('Версия');expect(state.rpc).not.toHaveBeenCalled();
 });
});
