import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
const state = vi.hoisted(() => ({ client: null as any, userDb: null as any, dispatch: vi.fn() }));
vi.mock('@/integrations/supabase/client.server',()=>({supabaseAdmin:new Proxy({}, {get:(_t,k)=>state.client[k]})}));
vi.mock('@/lib/extractor/actions-dispatch.server',()=>({dispatchBatch:state.dispatch}));
vi.mock('@tanstack/react-start',()=>({createServerFn:()=>{const c={middleware:()=>c,inputValidator:()=>c,handler:(fn:unknown)=>fn};return c;}}));
vi.mock('@/integrations/supabase/auth-middleware',()=>({requireSupabaseAuth:{}}));
import { resumeExtractorImport } from '../src/lib/extractor/jobs.functions';
import { importStoredResult } from '../src/lib/extractor/actions-large-result.server';

const admin='00000000-0000-0000-0000-000000000001', outsider='00000000-0000-0000-0000-000000000002', job='10000000-0000-0000-0000-000000000001', approval='20000000-0000-4000-8000-000000000001', source='a'.repeat(64), code='b'.repeat(40), oldrun='42';
const units=Array.from({length:175},(_,i)=>({unit_id:`source:${source}:unit:${i}`,source:{sha256:source},role:'student_material',content_text:`item ${i}`,related_unit_ids:[],usable_for_grading:false,usable_for_learning:false,requires_manual_review:true}));
const result={format:'pathy-extraction-result-v1',source:{sha256:source},summary:{total_units:units.length},pipeline_context:{source_sha256:source,source_original_bytes_verified:true,source_block_linkage_complete:false},units};
const bytes=Buffer.from(JSON.stringify(result)); const sha=createHash('sha256').update(bytes).digest('hex');
const invoke=(user=admin)=> (resumeExtractorImport as any)({data:{id:job},context:{supabase:{rpc:async()=>({data:user===admin,error:null}),from:state.userDb.from},userId:user}});

async function setup() {
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE TYPE public.app_role AS ENUM ('admin','student');
 CREATE FUNCTION public.has_role(u uuid,r public.app_role) RETURNS boolean LANGUAGE sql AS $$ SELECT u='${admin}'::uuid AND r='admin'::public.app_role $$;
 CREATE TABLE public.extractor_jobs(id uuid PRIMARY KEY,file_sha256 text NOT NULL,file_name text NOT NULL,size_bytes bigint,storage_path text,revision int DEFAULT 1,status text,stage text,worker_rule_version text,progress int DEFAULT 0,attempts int DEFAULT 0,error text,updated_at timestamptz DEFAULT now(),result_total_units int,result_summary jsonb,result jsonb);
 CREATE TABLE public.extractor_job_units(id uuid DEFAULT gen_random_uuid(),job_id uuid REFERENCES public.extractor_jobs(id),unit_id text,position int,raw jsonb,review_choice text,UNIQUE(job_id,unit_id));
 GRANT SELECT ON public.extractor_jobs,public.extractor_job_units TO service_role;`);
 await db.exec(readFileSync('supabase/migrations/20261119120000_ext02_batch_jobs.sql','utf8'));
 await db.query('INSERT INTO public.extractor_jobs(id,file_sha256,file_name,size_bytes,storage_path,status) VALUES($1,$2,$3,$4,$5,$6)',[job,source,'x.txt',1,`${source}/x.txt`,'uploaded']);
 await db.exec('SET ROLE service_role');
 await db.query('SELECT public.ext02_reserve_job($1,$2,$3,$4)',[job,admin,code,approval]);
 await db.query('SELECT public.ext02_claim_job($1,$2,$3)',[job,oldrun,code]);
 await db.query('SELECT public.ext02_register_result_object($1,$2,$3,$4)',[job,oldrun,sha,bytes.length]);
 let failOnSecond=false; let appends=0; let supplied=bytes; let ambiguous=false;
 state.userDb={from:()=>({select:()=>({eq:()=>({single:async()=>({data:(await db.query('SELECT * FROM extractor_jobs WHERE id=$1',[job])).rows[0],error:null})})})})};
 const client={storage:{from:()=>({list:async()=>({data:ambiguous?[{name:`${sha}.json`},{name:`${'f'.repeat(64)}.json`}]:[{name:`${sha}.json`}]}),info:async()=>({data:{size:supplied.length}}),download:async()=>({data:new Blob([supplied])})})},rpc:async(name:string,a:any)=>{
  try {
   let q:any;
   if(name==='ext02_resume_large_result') q=await db.query('SELECT public.ext02_resume_large_result($1,$2,$3::jsonb) AS value',[a.p_job,a.p_user,a.p_candidate ? JSON.stringify(a.p_candidate) : null]);
   else if(name==='ext02_fail_job') q=await db.query('SELECT public.ext02_fail_job($1,$2,$3)',[a.p_job,a.p_run,a.p_kind]);
   else if(name==='ext02_begin_large_result') q=await db.query('SELECT public.ext02_begin_large_result($1,$2,$3::jsonb)',[a.p_job,a.p_run,JSON.stringify(a.p_meta)]);
   else if(name==='ext02_append_large_result') {appends++; if(failOnSecond && appends===2) return {error:{code:'08000'}}; q=await db.query('SELECT public.ext02_append_large_result($1,$2,$3,$4::jsonb)',[a.p_job,a.p_run,a.p_offset,JSON.stringify(a.p_units)]);}
   else if(name==='ext02_finish_large_result') q=await db.query('SELECT public.ext02_finish_large_result($1,$2,$3)',[a.p_job,a.p_run,a.p_digest]);
   else throw Error(`unexpected ${name}`);
   return {data:q.rows[0]?.value ?? null,error:null};
  } catch(e:any) {return {error:{code:e.code,message:e.message}};}
 }};
 state.client=client;
 return {db,client,failNext:()=>{failOnSecond=true; appends=0;},recover:()=>{failOnSecond=false;},tamper:()=>{supplied=Buffer.from(bytes);supplied[10]^=1;},ambiguity:(value:boolean)=>{ambiguous=value;}};
}

beforeEach(()=>state.dispatch.mockReset());
describe('admin recovery of existing stored import',()=>{
 it.each(['technical','expired'] as const)('resumes a partial import after %s, fencing the old run and preserving review',async(reason)=>{
  const x=await setup();
  try {
   x.failNext(); await expect(importStoredResult(x.client,job,oldrun,sha,bytes.length)).rejects.toThrow(); x.recover();
   expect((await x.db.query<any>('SELECT count(*)::int AS n FROM extractor_job_units')).rows[0].n).toBe(100);
   await x.db.exec(`RESET ROLE; UPDATE extractor_job_units SET review_choice='keep_original' WHERE position=0; SET ROLE service_role`);
   // Jobs from the previous PR revision have result.storage but no registration column.
   if(reason==='technical') await x.db.exec(`RESET ROLE; UPDATE extractor_jobs SET batch_storage=NULL WHERE id='${job}'; SET ROLE service_role`);
   if(reason==='technical') await x.db.query('SELECT public.ext02_fail_job($1,$2,$3)',[job,oldrun,'technical']);
   else await x.db.exec(`RESET ROLE; UPDATE extractor_jobs SET batch_lease_until=now()-interval '1 second' WHERE id='${job}'; SET ROLE service_role`);
   await expect(invoke(outsider)).rejects.toThrow('администратору');
   expect(await invoke()).toEqual({ok:true});
   const row=(await x.db.query<any>('SELECT status,stage,batch_run_id,result_total_units FROM extractor_jobs WHERE id=$1',[job])).rows[0];
   expect(row).toMatchObject({status:'succeeded',stage:'review_required',result_total_units:175});
   expect(row.batch_run_id).toMatch(/^resume:/);
   expect((await x.db.query<any>('SELECT count(*)::int AS n FROM extractor_job_units')).rows[0].n).toBe(175);
   expect((await x.db.query<any>('SELECT review_choice FROM extractor_job_units WHERE position=0')).rows[0].review_choice).toBe('keep_original');
   await expect(x.db.query('SELECT public.ext02_append_large_result($1,$2,$3,$4::jsonb)',[job,oldrun,0,JSON.stringify(units.slice(0,100))])).rejects.toThrow('Invalid lease');
   expect(state.dispatch).not.toHaveBeenCalled();
  } finally {await x.db.close();}
 },30000);
 it('recovers an object recorded before the first batch and rejects concurrent recovery',async()=>{
  const x=await setup(); try {
   await expect(x.db.query('SELECT public.ext02_register_result_object($1,$2,$3,$4)',[job,oldrun,'f'.repeat(64),bytes.length])).rejects.toThrow('Conflicting object');
   await x.db.query('SELECT public.ext02_fail_job($1,$2,$3)',[job,oldrun,'technical']);
   await expect(x.db.query('SELECT public.ext02_reserve_job($1,$2,$3,$4)',[job,admin,code,'20000000-0000-4000-8000-000000000002'])).rejects.toThrow('not eligible');
   await expect(x.db.query('SELECT public.ext02_resume_large_result($1,$2)',[job,outsider])).rejects.toThrow('Forbidden');
   await x.db.exec('RESET ROLE; SET ROLE authenticated');
   await expect(x.db.query('SELECT public.ext02_resume_large_result($1,$2)',[job,admin])).rejects.toThrow('permission denied');
   await x.db.exec('RESET ROLE; SET ROLE service_role');
   const attempts=await Promise.allSettled([x.db.query<any>('SELECT public.ext02_resume_large_result($1,$2) AS value',[job,admin]),x.db.query<any>('SELECT public.ext02_resume_large_result($1,$2) AS value',[job,admin])]);
   expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
   expect(attempts.filter(a=>a.status==='rejected')).toHaveLength(1);
   const d=(attempts.find(a=>a.status==='fulfilled') as PromiseFulfilledResult<any>).value.rows[0].value;
   await importStoredResult(x.client,job,d.run,sha,bytes.length,d.object_run);
   expect((await x.db.query<any>('SELECT count(*)::int AS n FROM extractor_job_units')).rows[0].n).toBe(175);
  } finally {await x.db.close();}
 },30000);
 it('does not trust changed storage bytes during recovery',async()=>{
  const x=await setup(); try {
   await x.db.query('SELECT public.ext02_fail_job($1,$2,$3)',[job,oldrun,'technical']); x.tamper();
   await expect(invoke()).rejects.toThrow('целостности');
   expect((await x.db.query<any>('SELECT status,stage FROM extractor_jobs WHERE id=$1',[job])).rows[0]).toEqual({status:'failed',stage:'integrity_error'});
   expect((await x.db.query<any>('SELECT count(*)::int AS n FROM extractor_job_units')).rows[0].n).toBe(0);
  } finally {await x.db.close();}
 },30000);
 it('finds an unambiguous legacy object when interruption preceded metadata and refuses ambiguous objects',async()=>{
  const x=await setup(); try {
   await x.db.exec(`RESET ROLE; UPDATE extractor_jobs SET batch_storage=NULL WHERE id='${job}'; SET ROLE service_role`);
   await x.db.query('SELECT public.ext02_fail_job($1,$2,$3)',[job,oldrun,'technical']);
   x.ambiguity(true); await expect(invoke()).rejects.toThrow('однозначный');
   expect((await x.db.query<any>('SELECT status FROM extractor_jobs WHERE id=$1',[job])).rows[0].status).toBe('failed');
   x.ambiguity(false); expect(await invoke()).toEqual({ok:true});
   expect((await x.db.query<any>('SELECT count(*)::int AS n FROM extractor_job_units')).rows[0].n).toBe(175);
   expect(state.dispatch).not.toHaveBeenCalled();
  } finally {await x.db.close();}
 },30000);
});
