import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('@tanstack/react-start', () => ({ createServerFn: () => {
  const chain = { middleware: () => chain, inputValidator: () => chain, handler: (fn: unknown) => fn }; return chain;
} }));
vi.mock('@/integrations/supabase/auth-middleware', () => ({ requireSupabaseAuth: {} }));
vi.mock('@/integrations/supabase/client.server', () => ({ supabaseAdmin: { rpc: async (name:string, args:any) => {
  try { const r = await state.db.query(`SELECT public.${name}($1,$2,$3::uuid[],$4::uuid[]) AS value`, [args.p_lesson_id,args.p_user_id,args.p_material_ids,args.p_task_ids]); return {data:r.rows[0].value,error:null}; }
  catch (error:any) { return {data:null,error}; }
} } }));
import { buildLessonFromPathItem } from '../src/lib/lesson.functions';
const u='00000000-0000-0000-0000-000000000001', l='40000000-0000-0000-0000-000000000001', topic='30000000-0000-4000-8000-000000000001', oldTask='50000000-0000-0000-0000-000000000001', newTask='50000000-0000-0000-0000-000000000002', oldMat='60000000-0000-0000-0000-000000000001', newMat='60000000-0000-0000-0000-000000000002';
beforeAll(async () => {
  const db = state.db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.lessons(id uuid primary key,user_id uuid,status text);
    CREATE TABLE public.lesson_tasks(lesson_id uuid,task_id uuid,order_index int,points int,is_required boolean,user_id uuid);
    CREATE TABLE public.lesson_materials(lesson_id uuid,material_id uuid,order_index int,is_required boolean,user_id uuid);
    CREATE TABLE public.task_attempts(lesson_id uuid); CREATE TABLE public.lesson_results(lesson_id uuid,score int);
    INSERT INTO public.lessons VALUES('${l}','${u}','completed');
    INSERT INTO public.lesson_tasks VALUES('${l}','${oldTask}',7,3,true,'${u}');
    INSERT INTO public.lesson_materials VALUES('${l}','${oldMat}',8,true,'${u}');
    INSERT INTO public.task_attempts VALUES('${l}'); INSERT INTO public.lesson_results VALUES('${l}',42);`);
  const atomic=readFileSync(new URL('../supabase/migrations/20261118143000_dat04_atomic_lesson_completion.sql',import.meta.url),'utf8');
  const assignment=atomic.match(/CREATE OR REPLACE FUNCTION public\.lock_lesson_assignment\(\)[\s\S]*?CREATE TRIGGER lock_lesson_materials_before_change[\s\S]*?;/)![0];
  await db.exec(assignment);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261118144500_dat04_initialize_lesson_assignments.sql',import.meta.url),'utf8'));
});
afterAll(async () => { await state.db.close(); });
it.each(['completed','planned'])('opens a completed route lesson with a %s lookup without changing history', async (lookupStatus) => {
  const sb={from:(table:string) => {
    const q:any={select:()=>q,eq:()=>q,or:()=>q,in:()=>q,order:()=>q,
      single:async()=>({data:{id:'path',student_profile_id:'profile',subject_id:'subject',topic_id:topic},error:null}),
      maybeSingle:async()=>({data:table==='lessons'?{id:l,status:lookupStatus}:{mastery_score:0},error:null}),
      limit:async()=>({data:table==='materials'?[{id:newMat}]:table==='tasks'?[{id:newTask}]:[],error:null})}; return q;
  }};
  const result=await (buildLessonFromPathItem as any)({data:{path_item_id:'path'},context:{userId:u,supabase:sb}});
  expect(result).toMatchObject({lesson_id:l});
  expect((await state.db.query('SELECT task_id,order_index,points FROM lesson_tasks')).rows).toEqual([{task_id:oldTask,order_index:7,points:3}]);
  expect((await state.db.query('SELECT material_id,order_index FROM lesson_materials')).rows).toEqual([{material_id:oldMat,order_index:8}]);
  expect((await state.db.query('SELECT score FROM lesson_results')).rows).toEqual([{score:42}]);
  expect((await state.db.query('SELECT count(*)::int AS n FROM task_attempts')).rows[0].n).toBe(1);
});
