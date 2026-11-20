import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(()=>({ verify:vi.fn(), rpc:vi.fn(), signed:vi.fn(), upload:vi.fn(), importStored:vi.fn() }));
vi.mock('@/lib/extractor/actions-oidc.server',()=>({authenticateBatchOidc:state.verify}));
vi.mock('@/lib/extractor/actions-large-result.server',()=>({importStoredResult:state.importStored,ResultIntegrityError:class extends Error {}}));
vi.mock('@/integrations/supabase/client.server',()=>({supabaseAdmin:{rpc:state.rpc,storage:{from:()=>({createSignedUrl:state.signed,createSignedUploadUrl:state.upload})}}}));
import { batchBridge } from '../src/lib/extractor/actions-bridge.server';
const job='10000000-0000-4000-8000-000000000001', sha='a'.repeat(64);
const req=(body:any,goodHash=true)=>{const raw=JSON.stringify(body);return new Request('https://local/api/ext02-batch',{method:'POST',headers:{authorization:'Bearer fixture','x-pathy-body-sha256':goodHash?createHash('sha256').update(raw).digest('hex'):'b'.repeat(64)},body:raw});};
beforeEach(()=>{state.verify.mockReset().mockResolvedValue({runId:'42',sha:'b'.repeat(40)});state.rpc.mockReset();state.signed.mockReset();state.upload.mockReset();state.importStored.mockReset().mockResolvedValue(undefined);});
describe('batch bridge',()=>{
 it('returns only a scoped source link after a claimed lease',async()=>{
  state.rpc.mockResolvedValue({data:{sha256:sha,filename:'x.txt',size:1,storage_path:`${sha}/x.txt`,revision:1},error:null});
  state.signed.mockResolvedValue({data:{signedUrl:'https://example.invalid/signed'},error:null});
  const response=await batchBridge(req({action:'claim',job_id:job}));
  expect(response.status).toBe(200); expect((await response.json()).source_url).toBe('https://example.invalid/signed');
  expect(state.rpc).toHaveBeenCalledWith('ext02_claim_job',{p_job:job,p_run:'42',p_sha:'b'.repeat(40)});
 });
 it('rejects invalid authentication and records an altered result as an integrity failure',async()=>{
  state.verify.mockRejectedValueOnce(new Error('invalid'));
  expect((await batchBridge(req({action:'claim',job_id:job}))).status).toBe(403); expect(state.rpc).not.toHaveBeenCalled();
  state.rpc.mockResolvedValue({data:null,error:null});
  expect((await batchBridge(req({action:'complete',job_id:job,result:{}},false))).status).toBe(422);
  expect(state.rpc).toHaveBeenCalledWith('ext02_fail_job',{p_job:job,p_run:'42',p_kind:'integrity'});
 });
 it('records a validated database integrity rejection without misclassifying a lease error',async()=>{
  state.rpc.mockResolvedValueOnce({error:{code:'22000'}}).mockResolvedValueOnce({error:null});
  expect((await batchBridge(req({action:'complete',job_id:job,result:{}}))).status).toBe(422);
  expect(state.rpc).toHaveBeenLastCalledWith('ext02_fail_job',{p_job:job,p_run:'42',p_kind:'integrity'});
  state.rpc.mockReset().mockResolvedValue({error:{code:'P0001'}});
  expect((await batchBridge(req({action:'complete',job_id:job,result:{}}))).status).toBe(403);
  expect(state.rpc).toHaveBeenCalledTimes(1);
 });
 it('passes authenticated results to the atomic RPC',async()=>{
  state.rpc.mockResolvedValue({data:null,error:null});
  expect((await batchBridge(req({action:'complete',job_id:job,result:{format:'fixture'}}))).status).toBe(200);
  expect(state.rpc).toHaveBeenCalledWith('ext02_complete_job',{p_job:job,p_run:'42',p_result:{format:'fixture'}});
 });
 it('issues an upload link scoped to the authenticated job, run and digest only',async()=>{
  state.rpc.mockResolvedValue({data:{},error:null}); state.upload.mockResolvedValue({data:{signedUrl:'https://example.invalid/signed'},error:null});
  const response=await batchBridge(req({action:'prepare_result',job_id:job,object:{sha256:sha,size:41422276}}));
  expect(response.status).toBe(200);
  expect(state.rpc).toHaveBeenCalledWith('ext02_claim_job',{p_job:job,p_run:'42',p_sha:'b'.repeat(40)});
  expect(state.rpc).toHaveBeenCalledWith('ext02_register_result_object',{p_job:job,p_run:'42',p_sha:sha,p_size:41422276});
  expect(state.upload).toHaveBeenCalledWith(`ext02-results/${job}/42/${sha}.json`);
 });
 it('does not issue an upload link when the object identity conflicts',async()=>{
  state.rpc.mockResolvedValueOnce({error:null}).mockResolvedValueOnce({error:{code:'P0001'}});
  expect((await batchBridge(req({action:'prepare_result',job_id:job,object:{sha256:sha,size:10}}))).status).toBe(403);
  expect(state.upload).not.toHaveBeenCalled();
 });
 it('checks run and lease before importing the stored result',async()=>{
  state.rpc.mockResolvedValue({error:null});
  expect((await batchBridge(req({action:'complete_stored',job_id:job,object:{sha256:sha,size:41422276}}))).status).toBe(200);
  expect(state.rpc).toHaveBeenCalledWith('ext02_assert_large_job',{p_job:job,p_run:'42',p_sha:'b'.repeat(40)});
  expect(state.importStored).toHaveBeenCalledWith(expect.anything(),job,'42',sha,41422276);
  state.importStored.mockClear(); state.rpc.mockResolvedValue({error:{code:'P0001'}});
  expect((await batchBridge(req({action:'complete_stored',job_id:job,object:{sha256:sha,size:41422276}}))).status).toBe(403);
  expect(state.importStored).not.toHaveBeenCalled();
 });
});
