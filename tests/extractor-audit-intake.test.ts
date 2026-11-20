import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({write:vi.fn()}));
vi.mock('@/integrations/supabase/client.server',()=>({supabaseAdmin:{rpc:state.write}}));
import { auditIntakeSchema, importAuditResult } from '../src/lib/extractor/audit-intake.server';
const text='synthetic source', sha=createHash('sha256').update(text).digest('hex');
const job='10000000-0000-4000-8000-000000000001';
const unit={unit_id:'lesson-1',kind:'rule',title:'A title',content_text:' Original text ',pages:[1],source:{sha256:sha},review_status:'needs_review',rights:'unknown',platform:{status:'draft',is_public:false}};
function mockDb(admin=true) {
  const record={id:job,file_sha256:sha,file_name:'source.txt',size_bytes:text.length,storage_path:`${sha}/source.txt`};
  const select:any={select:()=>select,eq:()=>select,single:async()=>({data:record,error:null})};
  return {rpc:vi.fn(async()=>({data:admin,error:null})),from:vi.fn(()=>select),storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://storage.invalid/private'},error:null})})}};
}
beforeEach(()=>{state.write.mockReset().mockResolvedValue({error:null});vi.stubGlobal('fetch',vi.fn(async()=>new Response(text)));});
afterEach(()=>vi.unstubAllGlobals());
describe('manual audit routes use the existing job intake',()=>{
 it('rejects non-admin before reading a job or source',async()=>{
  const db=mockDb(false);await expect(importAuditResult(db,'student',{job_id:job,confirmed:true,units:[unit]})).rejects.toThrow('администратору');
  expect(db.from).not.toHaveBeenCalled();expect(state.write).not.toHaveBeenCalled();
 });
 it('verifies source bytes, preserves original and routes units to review',async()=>{
  const db=mockDb();const result=await importAuditResult(db,'admin',{job_id:job,confirmed:true,units:[unit],envelope_metadata:{format:'pathy-extractor-audit-staging-v1',receipt:'preserve'}});
  expect(result).toEqual({job_id:job,count:1});
  const args=state.write.mock.calls[0][1], raw=args.p_result.units[0];
  expect(args.p_result.audit_envelope_metadata.receipt).toBe('preserve');
  expect(args.p_result.pipeline_context).toMatchObject({mode:'manual_audit',source_block_linkage_complete:false,source_original_bytes_verified:true});
  expect(raw).toMatchObject({content_text:' Original text ',requires_manual_review:true,usable_for_learning:false,usable_for_grading:false,source:{legacy_unit_id:'lesson-1',original_audit_unit:unit}});
  expect(raw.unit_id).toMatch(new RegExp(`^source:${sha}:unit:legacy:`));
 });
 it('fails before writing on altered source, foreign source or duplicate units',async()=>{
  const db=mockDb();vi.stubGlobal('fetch',vi.fn(async()=>new Response('tampered bytes!')));
  await expect(importAuditResult(db,'admin',{job_id:job,confirmed:true,units:[unit]})).rejects.toThrow();
  await expect(importAuditResult(db,'admin',{job_id:job,confirmed:true,units:[{...unit,source:{sha256:'b'.repeat(64)}}]})).rejects.toThrow('SHA');
  await expect(importAuditResult(db,'admin',{job_id:job,confirmed:true,units:[unit,unit]})).rejects.toThrow('повторные');
  expect(state.write).not.toHaveBeenCalled();
 });
 it('does not accept the old bypass payload without a job',()=>{
  expect(auditIntakeSchema.safeParse({confirmed:true,units:[unit]}).success).toBe(false);
 });
});
