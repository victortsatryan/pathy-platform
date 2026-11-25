import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { importStoredResult, ResultIntegrityError } from '../src/lib/extractor/actions-large-result.server';

const fixture = process.env.PATHY_EXT02_EGE9_FIXTURE;
const job='10000000-0000-0000-0000-000000000001', user='00000000-0000-0000-0000-000000000001', approval='20000000-0000-4000-8000-000000000001', code='b'.repeat(40), run='42';

describe.skipIf(!fixture)('EGE9 saved result through the real server importer and SQL', () => {
  it('imports all units, preserves evidence, replays safely and rejects tampering', async () => {
    const bytes=readFileSync(fixture!);
    const original=JSON.parse(bytes.toString());
    const digest=createHash('sha256').update(bytes).digest('hex');
    const source=original.source.sha256;
    expect(source).toBe('0ad4e45b2227c920d52ffa3fbb3514b16181d1635f6fb15b16c3cbfc3c4bcf57');
    expect(original.summary).toMatchObject({total_units:38, student_units:20, teacher_private_units:18, requires_manual_review:38});
    const db=new PGlite();
    try {
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TYPE public.app_role AS ENUM ('admin','student');
      CREATE FUNCTION public.has_role(u uuid,r public.app_role) RETURNS boolean LANGUAGE sql AS $$ SELECT u='${user}'::uuid AND r='admin'::public.app_role $$;
      CREATE TABLE public.extractor_jobs(id uuid PRIMARY KEY,file_sha256 text NOT NULL,file_name text NOT NULL,size_bytes bigint,storage_path text,revision int DEFAULT 1,status text,stage text,worker_rule_version text,progress int DEFAULT 0,attempts int DEFAULT 0,error text,updated_at timestamptz DEFAULT now(),result_total_units int,result_summary jsonb,result jsonb);
      CREATE TABLE public.extractor_job_units(id uuid DEFAULT gen_random_uuid(),job_id uuid REFERENCES public.extractor_jobs(id),unit_id text,position int,raw jsonb,review_choice text, UNIQUE(job_id,unit_id));
      GRANT SELECT ON public.extractor_jobs,public.extractor_job_units TO service_role;`);
      await db.exec(readFileSync('supabase/migrations/20261119120000_ext02_batch_jobs.sql','utf8'));
      await db.query('INSERT INTO public.extractor_jobs(id,file_sha256,file_name,size_bytes,storage_path,status) VALUES($1,$2,$3,$4,$5,$6)',[job,source,'x.txt',1,`${source}/x.txt`,'uploaded']);
      await db.exec('SET ROLE service_role');
      await db.query('SELECT public.ext02_reserve_job($1,$2,$3,$4)',[job,user,code,approval]);
      await db.query('SELECT public.ext02_claim_job($1,$2,$3)',[job,run,code]);
      const batches: number[]=[];
      const client={storage:{from:()=>({info:async()=>({data:{size:bytes.length}}),download:async()=>({data:new Blob([bytes])})})},rpc:async(name:string,args:any)=>{
        try {
          if(name==='ext02_begin_large_result') {
            await db.query('SELECT public.ext02_begin_large_result($1,$2,$3::jsonb)',[args.p_job,args.p_run,JSON.stringify(args.p_meta)]);
            if (!batches.length) await expect(db.query('SELECT public.ext02_finish_large_result($1,$2,$3)',[job,run,digest])).rejects.toThrow('Incomplete result');
          }
          else if(name==='ext02_append_large_result') { batches.push(args.p_units.length); await db.query('SELECT public.ext02_append_large_result($1,$2,$3,$4::jsonb)',[args.p_job,args.p_run,args.p_offset,JSON.stringify(args.p_units)]); }
          else if(name==='ext02_finish_large_result') await db.query('SELECT public.ext02_finish_large_result($1,$2,$3)',[args.p_job,args.p_run,args.p_digest]);
          else throw Error('unexpected RPC');
          return {error:null};
        } catch(e:any) { return {error:{code:e.code,message:e.message}}; }
      }};
      await expect(importStoredResult(client,job,run,'f'.repeat(64),bytes.length)).rejects.toBeInstanceOf(ResultIntegrityError);
      await importStoredResult(client,job,run,digest,bytes.length);
      const row=(await db.query<any>('SELECT status,stage,result_total_units,result FROM extractor_jobs WHERE id=$1',[job])).rows[0];
      expect(row).toMatchObject({status:'succeeded',stage:'completed',result_total_units:38,result:{storage:{sha256:digest,size:bytes.length},pipeline_context:original.pipeline_context}});
      expect(batches.length).toBeGreaterThan(0); expect(Math.max(...batches)).toBeLessThanOrEqual(100);
      const rows=(await db.query<any>('SELECT position,unit_id,raw FROM extractor_job_units WHERE job_id=$1 ORDER BY position',[job])).rows;
      expect(rows).toHaveLength(38);
      for(let i=0;i<rows.length;i++) { expect(rows[i].position).toBe(i); expect(rows[i].raw).toEqual(original.units[i]); }
      await importStoredResult(client,job,run,digest,bytes.length);
      expect((await db.query<any>('SELECT count(*)::int AS n FROM extractor_job_units WHERE job_id=$1',[job])).rows[0].n).toBe(38);
      expect((await db.query<any>('SELECT count(*)::int AS n FROM extractor_job_units WHERE job_id=$1 AND review_choice IS NOT NULL',[job])).rows[0].n).toBe(0);
      const altered={...original.units[0],content_text:'forged'};
      await expect(db.query('SELECT public.ext02_append_large_result($1,$2,$3,$4::jsonb)',[job,run,0,JSON.stringify([altered])])).rejects.toThrow('Conflicting batch');
      await db.exec('RESET ROLE; SET ROLE authenticated');
      await expect(db.query('SELECT public.ext02_finish_large_result($1,$2,$3)',[job,run,digest])).rejects.toThrow('permission denied');
      expect(rows.filter((u:any) => u.raw.role==='student_material')).toHaveLength(20);
      expect(rows.filter((u:any) => u.raw.role==='teacher_private')).toHaveLength(18);
      expect(rows.every((u:any) => u.raw.requires_manual_review===true)).toBe(true);
    } finally { await db.close(); }
  }, 180000);
});
