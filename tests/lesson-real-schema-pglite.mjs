import { PGlite } from '@electric-sql/pglite';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../supabase/migrations/', import.meta.url);
const read = (name) => readFileSync(new URL(name,root),'utf8');
const initial=read('20260424172634_415f0bcc-6914-48ec-b1e1-6756db6bfe3b.sql');
const profile=read('20260612130607_59514b44-7c10-4274-81d3-c295c1b92442.sql');
const lesson=read('20260612140723_afd3a050-3c79-404a-b258-75e255d00c02.sql');
const history=read('20260612141550_1227bd56-b70f-4a64-b703-eb6a8796ab8c.sql');
const teachers=read('20260614080420_6c228cef-74f9-48be-b9d9-8ecdbb7fc364.sql');
const teacherProfilePolicy=read('20260821082317_6ca1cfb5-6ea8-4b35-a5a3-5782c5266cdc.sql');
const teacherProgressPolicies=read('20260821083258_987706e4-75d1-4641-a087-46e75ff4a31c.sql');
const teacherLessons=readFileSync(new URL('../drizzle/migrations/0000_teacher_lesson_read_and_safe_pcs_import.sql',import.meta.url),'utf8');
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
for (const name of ['teacher_profiles','teacher_student_links']) await db.exec(table(teachers,name));
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
for(const [src,name] of [[profile,'student_profiles_select_own'],[profile,'student_profiles_insert_own'],[profile,'student_profiles_update_own'],[profile,'student_profiles_delete_own'],[profile,'stp_select_own'],[profile,'stp_insert_own'],[profile,'stp_update_own'],[profile,'stp_delete_own'],[profile,'mistakes_select_own'],[profile,'mistakes_insert_own'],[profile,'mistakes_update_own'],[profile,'mistakes_delete_own'],[history,'Students view own progress history'],[history,'Students insert own progress history'],[lesson,'lpi owner all'],[lesson,'ce owner all'],[initial,'Users can view their own lessons'],[initial,'Users can create their own lessons'],[initial,'Users can view their own task attempts'],[security,'lt owner read'],[security,'lm owner read'],[security,'lr owner read']]) await db.exec(policy(src,name));
await db.exec(statement(teachers,/CREATE OR REPLACE FUNCTION public\.is_teacher_of_student\([\s\S]*?\$\$;/i));
await db.exec(statement(teacherLessons,/CREATE OR REPLACE FUNCTION public\.can_teacher_view_lesson\([\s\S]*?\$\$;/i));
await db.exec('REVOKE EXECUTE ON FUNCTION public.is_teacher_of_student(uuid,uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.is_teacher_of_student(uuid,uuid) TO authenticated,service_role; REVOKE EXECUTE ON FUNCTION public.can_teacher_view_lesson(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.can_teacher_view_lesson(uuid) TO authenticated');
for(const [src,name] of [[teacherProfilePolicy,'student_profiles_select_linked_teacher'],[teacherProgressPolicies,'stp_select_linked_teacher'],[teacherProgressPolicies,'mistakes_select_linked_teacher'],[teacherLessons,'lessons_select_linked_teacher'],[teacherLessons,'lm_select_linked_teacher'],[teacherLessons,'lt_select_linked_teacher'],[teacherLessons,'lr_select_linked_teacher'],[teacherLessons,'ta_select_linked_teacher']]) await db.exec(policy(src,name));
await db.exec('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role');
for (const t of ['student_profiles','student_topic_progress','student_mistakes','learning_path_items','calendar_events']) await db.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.${t} TO authenticated`);
await db.exec('GRANT SELECT,INSERT ON public.student_progress_history TO authenticated');
for (const name of ['lessons','task_attempts','lesson_tasks','lesson_materials','lesson_results']) {
  await db.exec(statement(security,new RegExp(`REVOKE ALL ON TABLE public\\.${name} FROM PUBLIC, anon, authenticated;`,'i')));
  const grant = name === 'task_attempts'
    ? new RegExp(`GRANT SELECT\\s*\\([^)]*\\) ON TABLE public\\.${name} TO authenticated;`,'i')
    : new RegExp(`GRANT SELECT ON TABLE public\\.${name} TO authenticated;`,'i');
  await db.exec(statement(security,grant));
}
await db.exec(statement(security,/ALTER TABLE public\.lessons ALTER COLUMN status SET DEFAULT 'planned';/i));
await db.exec(statement(security,/GRANT INSERT\s*\([^)]*\) ON TABLE public\.lessons TO authenticated;/i));
await db.exec(atomic);
capturingSchema=false;
if (process.env.PATHY_TEST_SCHEMA_DUMP) writeFileSync(process.env.PATHY_TEST_SCHEMA_DUMP,schemaStatements.join(';\n'));
const u='00000000-0000-0000-0000-000000000001', teacher='00000000-0000-0000-0000-000000000002', outsider='00000000-0000-0000-0000-000000000003', tp='60000000-0000-0000-0000-000000000001', sp='10000000-0000-0000-0000-000000000001', sub='20000000-0000-0000-0000-000000000001', top='30000000-0000-0000-0000-000000000001', l='40000000-0000-0000-0000-000000000001', t='50000000-0000-0000-0000-000000000001';
await db.exec(`INSERT INTO auth.users VALUES('${u}'),('${teacher}'),('${outsider}'); INSERT INTO public.subjects VALUES('${sub}'); INSERT INTO public.topics VALUES('${top}'); INSERT INTO public.tasks VALUES('${t}'); INSERT INTO public.student_profiles(id,user_id) VALUES('${sp}','${u}'); INSERT INTO public.teacher_profiles(id,user_id) VALUES('${tp}','${teacher}'); INSERT INTO public.teacher_student_links(teacher_profile_id,student_profile_id) VALUES('${tp}','${sp}'); INSERT INTO public.lessons(id,user_id,student_profile_id,subject_id,topic_id,lesson_date,title,status) VALUES('${l}','${u}','${sp}','${sub}','${top}','2026-11-18','lesson','planned'); INSERT INTO public.lesson_tasks(lesson_id,task_id,user_id) VALUES('${l}','${t}','${u}');`);
await db.exec('SET ROLE service_role');
await db.query(`INSERT INTO public.task_attempts(user_id,lesson_id,subject_id,student_profile_id,task_key,task_id,validated_by_server,is_correct,points_awarded,max_points) VALUES($1,$2,$3,$5,$4::uuid::text,$4::uuid,true,true,1,1)`,[u,l,sub,t,sp]);
await db.exec(`RESET ROLE; SET ROLE authenticated; SET request.jwt.claim.sub='${u}'`);
await assert.rejects(db.query('SELECT correct_answer FROM public.task_attempts'),/permission denied/);
assert.equal((await db.query('SELECT task_id FROM public.task_attempts')).rows.length,1);
await db.exec('RESET ROLE; SET ROLE service_role');
const a=await db.query(`SELECT public.complete_lesson_atomic($1,$2) AS value`,[l,u]);
assert.equal(a.rows[0].value.percent,100);
assert.equal((await db.query('SELECT attempts_count FROM public.student_topic_progress')).rows[0].attempts_count,1);
assert.equal((await db.query(`SELECT public.complete_lesson_atomic($1,$2) AS value`,[l,u])).rows[0].value.already_completed,true);
await assert.rejects(db.query(`SELECT public.complete_lesson_atomic($1,$2)`,[l,teacher]),/Forbidden/);
// Existing owner UPDATE grants are independent of the lesson RPC. Record the
// actual policy boundary without leaving a changed result in the fixture.
await db.exec(`RESET ROLE; SET ROLE authenticated; SET request.jwt.claim.sub='${u}'; BEGIN`);
await db.query('UPDATE public.student_topic_progress SET attempts_count=999 WHERE student_profile_id=$1',[sp]);
assert.equal((await db.query('SELECT attempts_count FROM public.student_topic_progress')).rows[0].attempts_count,999);
await db.exec('ROLLBACK');
await db.exec(`RESET ROLE; SET ROLE authenticated; SET request.jwt.claim.sub='${teacher}'`);
assert.equal((await db.query('SELECT id FROM public.lessons')).rows.length,1);
assert.equal((await db.query('SELECT id FROM public.lesson_tasks')).rows.length,1);
assert.equal((await db.query('SELECT task_id FROM public.task_attempts')).rows.length,1);
assert.equal((await db.query('SELECT id FROM public.lesson_results')).rows.length,1);
await db.exec(`SET request.jwt.claim.sub='${outsider}'`);
assert.equal((await db.query('SELECT id FROM public.lessons')).rows.length,0);
assert.equal((await db.query('SELECT task_id FROM public.task_attempts')).rows.length,0);
console.log('PGlite: actual migration table definitions and selected owner policies passed');
await db.close();
