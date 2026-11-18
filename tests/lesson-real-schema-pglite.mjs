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
const progressFunctions=read('20261118150000_dat04_secure_progress_functions.sql');
const progressGrants=read('20261118151000_dat04_protect_progress_writes.sql');
const diagnostic=read('20260612134933_859e88cc-f627-4d51-9228-293017638b54.sql');
const tasksSource=read('20260424191347_df0b6661-2b38-440b-b832-7559f62a1092.sql');
const progressStatus=read('20260702033204_ab3f1b11-c5df-4656-8f9a-a54e7a8f821e.sql');
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
CREATE TYPE public.diagnostic_type AS ENUM ('entry','weekly');
CREATE TABLE public.subjects(id uuid PRIMARY KEY); CREATE TABLE public.topics(id uuid PRIMARY KEY,subject_id uuid REFERENCES public.subjects(id),is_public boolean NOT NULL DEFAULT true);
CREATE TABLE public.study_plans(id uuid PRIMARY KEY); CREATE TABLE public.materials(id uuid PRIMARY KEY);
CREATE TABLE public.learning_paths(id uuid PRIMARY KEY); CREATE TABLE public.subject_programs(id uuid PRIMARY KEY,subject_id uuid REFERENCES public.subjects(id));
CREATE TABLE public.program_topics(program_id uuid REFERENCES public.subject_programs(id),topic_id uuid REFERENCES public.topics(id));
CREATE TABLE public.student_subjects(id uuid PRIMARY KEY); CREATE TABLE public.diagnostic_tests(id uuid PRIMARY KEY);
CREATE TABLE public.learning_objectives(id uuid PRIMARY KEY);`);
await db.exec(table(tasksSource,'tasks'));
await db.exec(table(initial,'diagnostic_sessions'));
for (const [src,name] of [[profile,'student_profiles'],[lesson,'learning_path_items'],[initial,'lessons'],[initial,'task_attempts']]) await db.exec(table(src,name));
for (const name of ['teacher_profiles','teacher_student_links']) await db.exec(table(teachers,name));
await db.exec(statement(lesson,/ALTER TABLE public\.lessons\s+ALTER COLUMN plan_id DROP NOT NULL,[\s\S]*?;/i));
await db.exec('ALTER TABLE public.lessons ALTER COLUMN slot_number DROP NOT NULL');
await db.exec(statement(lesson,/ALTER TABLE public\.task_attempts\s+ADD COLUMN IF NOT EXISTS student_profile_id[\s\S]*?;/i));
for (const [src,name] of [[lesson,'lesson_tasks'],[lesson,'lesson_materials'],[lesson,'lesson_results'],[lesson,'calendar_events'],[profile,'student_topic_progress'],[profile,'student_mistakes'],[history,'student_progress_history']]) await db.exec(table(src,name));
await db.exec('ALTER TABLE public.student_topic_progress ADD COLUMN program_id uuid REFERENCES public.subject_programs(id) ON DELETE SET NULL');
await db.exec(statement(diagnostic,/ALTER TABLE public\.diagnostic_sessions\s+ADD COLUMN IF NOT EXISTS student_profile_id[\s\S]*?;/i));
for (const name of ['diagnostic_test_tasks','diagnostic_answers','diagnostic_topic_results']) await db.exec(table(diagnostic,name));
await db.exec('ALTER TABLE public.diagnostic_topic_results ENABLE ROW LEVEL SECURITY');
await db.exec(policy(diagnostic,'diag_topic_results_select_own'));
await db.exec(policy(diagnostic,'diag_topic_results_modify_own'));
await db.exec(statement(initial,/create or replace function public\.set_updated_at\(\)[\s\S]*?\$\$;/i));
await db.exec(statement(progressStatus,/CREATE OR REPLACE FUNCTION public\.stp_compute_status\(\)[\s\S]*?\$function\$;/i));
for (const [src,name] of [[profile,'stp_set_updated_at'],[progressStatus,'stp_status_auto'],[lesson,'lesson_results_set_updated_at'],[lesson,'lpi_set_updated_at'],[lesson,'calendar_events_set_updated_at']]) {
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
await db.exec('GRANT SELECT,INSERT,UPDATE,DELETE ON public.diagnostic_topic_results TO authenticated');
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
await db.exec(progressFunctions);
capturingSchema=false;
if (process.env.PATHY_TEST_SCHEMA_DUMP) writeFileSync(process.env.PATHY_TEST_SCHEMA_DUMP,[...schemaStatements,progressGrants].join(';\n'));
const u='00000000-0000-0000-0000-000000000001', teacher='00000000-0000-0000-0000-000000000002', outsider='00000000-0000-0000-0000-000000000003', tp='60000000-0000-0000-0000-000000000001', sp='10000000-0000-0000-0000-000000000001', sub='20000000-0000-0000-0000-000000000001', top='30000000-0000-0000-0000-000000000001', l='40000000-0000-0000-0000-000000000001', t='50000000-0000-0000-0000-000000000001';
await db.exec(`INSERT INTO auth.users VALUES('${u}'),('${teacher}'),('${outsider}'); INSERT INTO public.subjects VALUES('${sub}'); INSERT INTO public.topics(id,subject_id) VALUES('${top}','${sub}'); INSERT INTO public.tasks(id,subject_id,topic_id,task_key,prompt) VALUES('${t}','${sub}','${top}','key','prompt'); INSERT INTO public.student_profiles(id,user_id) VALUES('${sp}','${u}'); INSERT INTO public.teacher_profiles(id,user_id) VALUES('${tp}','${teacher}'); INSERT INTO public.teacher_student_links(teacher_profile_id,student_profile_id) VALUES('${tp}','${sp}'); INSERT INTO public.lessons(id,user_id,student_profile_id,subject_id,topic_id,lesson_date,title,status) VALUES('${l}','${u}','${sp}','${sub}','${top}','2026-11-18','lesson','planned'); INSERT INTO public.lesson_tasks(lesson_id,task_id,user_id) VALUES('${l}','${t}','${u}');`);
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
// Contract phase: the same direct writes are now forbidden. Read policies for
// the learner and linked teacher are retained, and initialization is service-only.
await db.exec('RESET ROLE');
await db.exec(progressGrants);
await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${u}'`);
await assert.rejects(db.query('UPDATE public.student_topic_progress SET attempts_count=999 WHERE student_profile_id=$1',[sp]),/permission denied/);
await assert.rejects(db.query(`INSERT INTO public.student_progress_history(student_profile_id,user_id,old_score,new_score,source) VALUES('${sp}','${u}',0,100,'manual')`),/permission denied/);
await assert.rejects(db.query(`INSERT INTO public.student_mistakes(student_profile_id,mistake_type) VALUES('${sp}','other')`),/permission denied/);
await assert.rejects(db.query('DELETE FROM public.student_mistakes WHERE student_profile_id=$1',[sp]),/permission denied/);
await assert.rejects(db.query(`INSERT INTO public.diagnostic_topic_results(diagnostic_session_id,student_profile_id,subject_id,topic_id) VALUES(gen_random_uuid(),'${sp}','${sub}','${top}')`),/permission denied/);
await assert.rejects(db.query(`SELECT public.seed_student_progress('${u}','${sp}','${sub}',NULL,ARRAY['${top}'::uuid])`),/permission denied/);
await assert.rejects(db.query(`SELECT public.complete_diagnostic_atomic(gen_random_uuid(),'${u}','[]'::jsonb)`),/permission denied/);
await db.exec('RESET ROLE; SET ROLE service_role');
await db.query('SELECT public.seed_student_progress($1,$2,$3,NULL,ARRAY[$4::uuid])',[u,sp,sub,top]);
assert.equal((await db.query('SELECT attempts_count FROM public.student_topic_progress WHERE student_profile_id=$1',[sp])).rows[0].attempts_count,1);
await assert.rejects(db.query('SELECT public.seed_student_progress($1,$2,$3,NULL,ARRAY[$4::uuid])',[outsider,sp,sub,top]),/Forbidden/);
const diag='70000000-0000-0000-0000-000000000001', test='80000000-0000-0000-0000-000000000001';
await db.exec('RESET ROLE');
await db.exec(`INSERT INTO public.diagnostic_tests VALUES('${test}'); INSERT INTO public.diagnostic_test_tasks(diagnostic_test_id,task_id,points) VALUES('${test}','${t}',1); INSERT INTO public.diagnostic_sessions(id,user_id,subject_id,diagnostic_type,student_profile_id,diagnostic_test_id,status) VALUES('${diag}','${u}','${sub}','entry','${sp}','${test}','in_progress')`);
await db.exec('SET ROLE service_role');
const answers=JSON.stringify([{task_id:t,student_answer:'bad',is_correct:false,points_awarded:0,max_points:1,mistake_type:'grammar_error'}]);
const diagnosticResult=await db.query('SELECT public.complete_diagnostic_atomic($1,$2,$3::jsonb) AS value',[diag,u,answers]);
assert.equal(diagnosticResult.rows[0].value.score_percent,0);
const progressAfter=await db.query('SELECT attempts_count,mistakes_count,diagnostic_score,practice_score,mastery_score FROM public.student_topic_progress WHERE student_profile_id=$1',[sp]);
assert.deepEqual(progressAfter.rows[0],{attempts_count:2,mistakes_count:1,diagnostic_score:0,practice_score:100,mastery_score:30});
await db.query('SELECT public.complete_diagnostic_atomic($1,$2,$3::jsonb)',[diag,u,answers]);
assert.equal((await db.query('SELECT attempts_count FROM public.student_topic_progress WHERE student_profile_id=$1',[sp])).rows[0].attempts_count,2);
assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.student_mistakes WHERE source=$1',['diagnostic'])).rows[0].n,1);
await assert.rejects(db.query('SELECT public.complete_diagnostic_atomic($1,$2,$3::jsonb)',[diag,outsider,answers]),/Forbidden/);
// A fresh topic can be initialized without starting a diagnostic, while an
// existing row is never reset during repeated profile initialization.
const top2='30000000-0000-0000-0000-000000000002';
await db.exec('RESET ROLE');
await db.exec(`INSERT INTO public.topics(id,subject_id) VALUES('${top2}','${sub}')`);
await db.exec('SET ROLE service_role');
await db.query('SELECT public.seed_student_progress($1,$2,$3,NULL,ARRAY[$4::uuid,$5::uuid])',[u,sp,sub,top,top2]);
const seeded=await db.query('SELECT topic_id,attempts_count,mastery_score FROM public.student_topic_progress WHERE student_profile_id=$1 ORDER BY topic_id',[sp]);
assert.deepEqual(seeded.rows.map(r=>[r.attempts_count,r.mastery_score]),[[2,30],[0,0]]);
// A failure late in diagnostic processing rolls back answers, topic results,
// progress, history, mistakes and the session state.
const diag2='70000000-0000-0000-0000-000000000002';
await db.exec('RESET ROLE');
await db.exec(`INSERT INTO public.diagnostic_sessions(id,user_id,subject_id,diagnostic_type,student_profile_id,diagnostic_test_id,status) VALUES('${diag2}','${u}','${sub}','entry','${sp}','${test}','in_progress'); CREATE FUNCTION public.test_progress_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected diagnostic failure'; END $$; CREATE TRIGGER test_diagnostic_failure BEFORE INSERT ON public.student_mistakes FOR EACH ROW EXECUTE FUNCTION public.test_progress_fail()`);
await db.exec('SET ROLE service_role');
await assert.rejects(db.query('SELECT public.complete_diagnostic_atomic($1,$2,$3::jsonb)',[diag2,u,answers]),/injected diagnostic failure/);
assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.diagnostic_answers WHERE diagnostic_session_id=$1',[diag2])).rows[0].n,0);
assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.diagnostic_topic_results WHERE diagnostic_session_id=$1',[diag2])).rows[0].n,0);
assert.equal((await db.query('SELECT status FROM public.diagnostic_sessions WHERE id=$1',[diag2])).rows[0].status,'in_progress');
assert.equal((await db.query('SELECT attempts_count FROM public.student_topic_progress WHERE student_profile_id=$1 AND topic_id=$2',[sp,top])).rows[0].attempts_count,2);
await assert.rejects(db.query('SELECT public.complete_diagnostic_atomic($1,$2,$3::jsonb)',[diag2,u,JSON.stringify([JSON.parse(answers)[0],JSON.parse(answers)[0]])]),/Invalid diagnostic task or score/);
const badKey=JSON.stringify([{...JSON.parse(answers)[0],answer_key_snapshot:'stale-key'}]);
await assert.rejects(db.query('SELECT public.complete_diagnostic_atomic($1,$2,$3::jsonb)',[diag2,u,badKey]),/Invalid diagnostic task or score/);
const foreign=JSON.stringify([{...JSON.parse(answers)[0],task_id:'50000000-0000-0000-0000-000000000099'}]);
await assert.rejects(db.query('SELECT public.complete_diagnostic_atomic($1,$2,$3::jsonb)',[diag2,u,foreign]),/Invalid diagnostic task or score/);
// A partially written legacy session is not overwritten or double-counted.
await db.exec('RESET ROLE');
await db.exec(`DROP TRIGGER test_diagnostic_failure ON public.student_mistakes; INSERT INTO public.diagnostic_answers(diagnostic_session_id,task_id,student_answer) VALUES('${diag2}','${t}','historic')`);
await db.exec('SET ROLE service_role');
await assert.rejects(db.query('SELECT public.complete_diagnostic_atomic($1,$2,$3::jsonb)',[diag2,u,answers]),/частичные результаты/);
assert.equal((await db.query('SELECT student_answer FROM public.diagnostic_answers WHERE diagnostic_session_id=$1',[diag2])).rows[0].student_answer,'historic');
await db.exec(`RESET ROLE; SET ROLE authenticated; SET request.jwt.claim.sub='${teacher}'`);
assert.equal((await db.query('SELECT id FROM public.lessons')).rows.length,1);
assert.equal((await db.query('SELECT id FROM public.lesson_tasks')).rows.length,1);
assert.equal((await db.query('SELECT task_id FROM public.task_attempts')).rows.length,1);
assert.equal((await db.query('SELECT id FROM public.lesson_results')).rows.length,1);
assert.equal((await db.query('SELECT topic_id FROM public.student_topic_progress')).rows.length,2);
assert.equal((await db.query('SELECT id FROM public.student_mistakes')).rows.length,1);
await db.exec(`SET request.jwt.claim.sub='${outsider}'`);
assert.equal((await db.query('SELECT id FROM public.lessons')).rows.length,0);
assert.equal((await db.query('SELECT task_id FROM public.task_attempts')).rows.length,0);
console.log('PGlite: actual migration table definitions and selected owner policies passed');
await db.close();
