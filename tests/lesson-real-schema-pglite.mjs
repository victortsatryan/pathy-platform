import { PGlite } from '@electric-sql/pglite';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../supabase/migrations/', import.meta.url);
const read = (name) => readFileSync(new URL(name,root),'utf8');
const initial=read('20260424172634_415f0bcc-6914-48ec-b1e1-6756db6bfe3b.sql');
const profile=read('20260612130607_59514b44-7c10-4274-81d3-c295c1b92442.sql');
const lesson=read('20260612140723_afd3a050-3c79-404a-b258-75e255d00c02.sql');
const history=read('20260612141550_1227bd56-b70f-4a64-b703-eb6a8796ab8c.sql');
const security=read('20261118131500_dat04_f05_f06_secure_lesson_attempts.sql');
const atomic=read('20261118143000_dat04_atomic_lesson_completion.sql');
function table(src,name) {
  const m=src.match(new RegExp(`create table (?:if not exists )?public\\.${name}\\s*\\([\\s\\S]*?\\n\\);`,'i'));
  if(!m) throw new Error('missing source table '+name); return m[0];
}
function statement(src,pattern) { const m=src.match(pattern); if(!m) throw new Error('missing source statement '+pattern); return m[0]; }
function policy(src,name) { return statement(src,new RegExp(`create policy "${name}"[\\s\\S]*?;`,'i')); }
const db=new PGlite();
const schemaStatements=[];
let capturingSchema=true;
const originalExec=db.exec.bind(db);
db.exec=async (sql, ...args) => {
  if (capturingSchema) schemaStatements.push(sql);
  return originalExec(sql, ...args);
};
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
CREATE TYPE public.lesson_status AS ENUM ('locked','available','completed','missed','planned','in_progress','skipped','rescheduled');
CREATE TYPE public.difficulty_level AS ENUM ('easy','medium','hard','adaptive');
CREATE TABLE public.subjects(id uuid PRIMARY KEY); CREATE TABLE public.topics(id uuid PRIMARY KEY);
CREATE TABLE public.study_plans(id uuid PRIMARY KEY); CREATE TABLE public.tasks(id uuid PRIMARY KEY);
CREATE TABLE public.materials(id uuid PRIMARY KEY); CREATE TABLE public.diagnostic_sessions(id uuid PRIMARY KEY);
CREATE TABLE public.learning_paths(id uuid PRIMARY KEY); CREATE TABLE public.subject_programs(id uuid PRIMARY KEY);
CREATE TABLE public.learning_objectives(id uuid PRIMARY KEY);`);
for (const [src,name] of [[profile,'student_profiles'],[lesson,'learning_path_items'],[initial,'lessons'],[initial,'task_attempts']]) await db.exec(table(src,name));
await db.exec(statement(lesson,/ALTER TABLE public\.lessons\s+ALTER COLUMN plan_id DROP NOT NULL,[\s\S]*?;/i));
await db.exec('ALTER TABLE public.lessons ALTER COLUMN slot_number DROP NOT NULL');
await db.exec(statement(lesson,/ALTER TABLE public\.task_attempts\s+ADD COLUMN IF NOT EXISTS student_profile_id[\s\S]*?;/i));
for (const [src,name] of [[lesson,'lesson_tasks'],[lesson,'lesson_materials'],[lesson,'lesson_results'],[lesson,'calendar_events'],[profile,'student_topic_progress'],[profile,'student_mistakes'],[history,'student_progress_history']]) await db.exec(table(src,name));
await db.exec(statement(initial,/create or replace function public\.set_updated_at\(\)[\s\S]*?\$\$;/i));
await db.exec(statement(profile,/CREATE OR REPLACE FUNCTION public\.stp_compute_status\(\)[\s\S]*?\$\$;/i));
for (const [src,name] of [[profile,'stp_set_updated_at'],[profile,'stp_status_auto'],[lesson,'lesson_results_set_updated_at'],[lesson,'lpi_set_updated_at'],[lesson,'calendar_events_set_updated_at']]) {
  await db.exec(statement(src,new RegExp(`CREATE TRIGGER ${name}[\\s\\S]*?;`,'i')));
}
await db.exec(statement(security,/ALTER TABLE public\.task_attempts\s+ADD COLUMN IF NOT EXISTS validated_by_server[\s\S]*?;/i));
await db.exec(statement(security,/CREATE UNIQUE INDEX IF NOT EXISTS task_attempts_one_lesson_task_per_user[\s\S]*?;/i));
for(const t of ['student_profiles','lessons','task_attempts','lesson_tasks','lesson_materials','lesson_results','calendar_events','student_topic_progress','student_mistakes','student_progress_history','learning_path_items']) await db.exec(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
for(const [src,name] of [[profile,'student_profiles_select_own'],[profile,'stp_select_own'],[profile,'stp_insert_own'],[profile,'stp_update_own'],[profile,'mistakes_select_own'],[profile,'mistakes_insert_own'],[history,'Students view own progress history'],[history,'Students insert own progress history'],[lesson,'lpi owner all'],[lesson,'ce owner all'],[initial,'Users can view their own lessons'],[initial,'Users can view their own task attempts'],[security,'lt owner read'],[security,'lm owner read'],[security,'lr owner read']]) await db.exec(policy(src,name));
await db.exec('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role');
for (const name of ['lessons','task_attempts','lesson_tasks','lesson_materials','lesson_results']) {
  await db.exec(statement(security,new RegExp(`REVOKE ALL ON TABLE public\\.${name} FROM PUBLIC, anon, authenticated;`,'i')));
  const grant = name === 'task_attempts'
    ? new RegExp(`GRANT SELECT\\s*\\([^)]*\\) ON TABLE public\\.${name} TO authenticated;`,'i')
    : new RegExp(`GRANT SELECT ON TABLE public\\.${name} TO authenticated;`,'i');
  await db.exec(statement(security,grant));
}
await db.exec(statement(security,/ALTER TABLE public\.lessons ALTER COLUMN status SET DEFAULT 'planned';/i));
await db.exec(atomic);
capturingSchema=false;
if (process.env.PATHY_TEST_SCHEMA_DUMP) writeFileSync(process.env.PATHY_TEST_SCHEMA_DUMP,schemaStatements.join(';\n'));
const u='00000000-0000-0000-0000-000000000001', sp='10000000-0000-0000-0000-000000000001', sub='20000000-0000-0000-0000-000000000001', top='30000000-0000-0000-0000-000000000001', l='40000000-0000-0000-0000-000000000001', t='50000000-0000-0000-0000-000000000001';
await db.exec(`INSERT INTO auth.users VALUES('${u}'); INSERT INTO public.subjects VALUES('${sub}'); INSERT INTO public.topics VALUES('${top}'); INSERT INTO public.tasks VALUES('${t}'); INSERT INTO public.student_profiles(id,user_id) VALUES('${sp}','${u}'); INSERT INTO public.lessons(id,user_id,student_profile_id,subject_id,topic_id,lesson_date,title,status) VALUES('${l}','${u}','${sp}','${sub}','${top}','2026-11-18','lesson','planned'); INSERT INTO public.lesson_tasks(lesson_id,task_id,user_id) VALUES('${l}','${t}','${u}');`);
await db.exec('SET ROLE service_role');
await db.query(`INSERT INTO public.task_attempts(user_id,lesson_id,subject_id,task_key,task_id,validated_by_server,is_correct,points_awarded,max_points) VALUES($1,$2,$3,$4::uuid::text,$4::uuid,true,true,1,1)`,[u,l,sub,t]);
await db.exec(`RESET ROLE; SET ROLE authenticated; SET request.jwt.claim.sub='${u}'`);
await assert.rejects(db.query('SELECT correct_answer FROM public.task_attempts'),/permission denied/);
assert.equal((await db.query('SELECT task_id FROM public.task_attempts')).rows.length,1);
await db.exec('RESET ROLE; SET ROLE service_role');
const a=await db.query(`SELECT public.complete_lesson_atomic($1,$2) AS value`,[l,u]);
assert.equal(a.rows[0].value.percent,100);
assert.equal((await db.query('SELECT attempts_count FROM public.student_topic_progress')).rows[0].attempts_count,1);
assert.equal((await db.query(`SELECT public.complete_lesson_atomic($1,$2) AS value`,[l,u])).rows[0].value.already_completed,true);
console.log('PGlite: actual migration table definitions and selected owner policies passed');
await db.close();
