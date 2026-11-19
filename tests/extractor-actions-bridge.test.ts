import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(()=>({ verify:vi.fn(), rpc:vi.fn(), signed:vi.fn() }));
vi.mock('@/lib/extractor/actions-oidc.server',()=>({authenticateBatchOidc:state.verify}));
vi.mock('@/integrations/supabase/client.server',()=>({supabaseAdmin:{rpc:state.rpc,storage:{from:()=>({createSignedUrl:state.signed})}}}));
import { batchBridge } from '../src/lib/extractor/actions-bridge.server';
const job='10000000-0000-4000-8000-000000000001', sha='a'.repeat(64);
const req=(body:any,goodHash=true)=>{const raw=JSON.stringify(body);return new Request('https://local/api/ext02-batch',{method:'POST',headers:{authorization:'Bearer fixture','x-pathy-body-sha256':goodHash?createHash('sha256').update(raw).digest('hex'):'b'.repeat(64)},body:raw});};
beforeEach(()=>{state.verify.mockReset().mockResolvedValue({runId:'42',sha:'b'.repeat(40)});state.rpc.mockReset();state.signed.mockReset();});
describe('batch bridge',()=>{
 it('returns only a scoped source link after a claimed lease',async()=>{
  state.rpc.mockResolvedValue({data:{sha256:sha,filename:'x.txt',size:1,storage_path:`${sha}/x.txt`,revision:1},error:null});
  state.signed.mockResolvedValue({data:{signedUrl:'https://example.invalid/signed'},error:null});
  const response=await batchBridge(req({action:'claim',job_id:job}));
  expect(response.status).toBe(200); expect((await response.json()).source_url).toBe('https://example.invalid/signed');
  expect(state.rpc).toHaveBeenCalledWith('ext02_claim_job',{p_job:job,p_run:'42',p_sha:'b'.repeat(40)});
 });
 it('rejects invalid authentication and altered result before any database write',async()=>{
  state.verify.mockRejectedValueOnce(new Error('invalid'));
  expect((await batchBridge(req({action:'claim',job_id:job}))).status).toBe(403); expect(state.rpc).not.toHaveBeenCalled();
  expect((await batchBridge(req({action:'complete',job_id:job,result:{}},false))).status).toBe(403); expect(state.rpc).not.toHaveBeenCalled();
 });
 it('passes authenticated results to the atomic RPC',async()=>{
  state.rpc.mockResolvedValue({data:null,error:null});
  expect((await batchBridge(req({action:'complete',job_id:job,result:{format:'fixture'}}))).status).toBe(200);
  expect(state.rpc).toHaveBeenCalledWith('ext02_complete_job',{p_job:job,p_run:'42',p_result:{format:'fixture'}});
 });
});
