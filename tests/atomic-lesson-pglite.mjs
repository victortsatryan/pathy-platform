import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Isolated database: replicate the relevant column types, nullability,
// uniqueness, checks, foreign keys, role grants and owner policies from the
// checked-in migrations. The migrations under test are executed verbatim.
const db = new PGlite();
const migration = readFileSync(new URL('../supabase/migrations/20261118143000_dat04_atomic_lesson_completion.sql', import.meta.url),'utf8');
const uid='00000000-0000-0000-0000-000000000001';
const other='00000000-0000-0000-0000-000000000002';
const profile='10000000-0000-0000-0000-000000000001';
const subject='20000000-0000-0000-0000-000000000001';
const topic='30000000-0000-0000-0000-000000000001';
const lesson='40000000-0000-0000-0000-000000000001';
const task='50000000-0000-0000-0000-000000000001';
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated,anon; GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
CREATE TYPE public.lesson_status AS ENUM ('locked','available','completed','missed','planned','in_progress','skipped','rescheduled');
CREATE TABLE public.student_profiles(id uuid PRIMARY KEY, user_id uuid NOT NULL);
CREATE TABLE public.subjects(id uuid PRIMARY KEY);
CREATE TABLE public.topics(id uuid PRIMARY KEY);
CREATE TABLE public.tasks(id uuid PRIMARY KEY);
CREATE TABLE public.learning_path_items(id uuid PRIMARY KEY,user_id uuid NOT NULL,status text NOT NULL DEFAULT 'planned');
CREATE TABLE public.lessons(id uuid PRIMARY KEY,user_id uuid NOT NULL,student_profile_id uuid REFERENCES public.student_profiles(id),subject_id uuid NOT NULL REFERENCES public.subjects(id),topic_id uuid REFERENCES public.topics(id),learning_path_item_id uuid REFERENCES public.learning_path_items(id),status public.lesson_status NOT NULL DEFAULT 'planned');
CREATE TABLE public.lesson_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,order_index integer NOT NULL DEFAULT 0,points integer NOT NULL DEFAULT 1,is_required boolean NOT NULL DEFAULT true,user_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(lesson_id,task_id));
CREATE TABLE public.lesson_materials(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,material_id uuid NOT NULL,order_index integer NOT NULL DEFAULT 0,is_required boolean NOT NULL DEFAULT true,user_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(lesson_id,material_id));
CREATE TABLE public.task_attempts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,lesson_id uuid REFERENCES public.lessons(id) ON DELETE CASCADE,subject_id uuid NOT NULL REFERENCES public.subjects(id),task_key text NOT NULL,student_answer jsonb,correct_answer jsonb,is_correct boolean,student_profile_id uuid REFERENCES public.student_profiles(id),task_id uuid REFERENCES public.tasks(id),points_awarded integer NOT NULL DEFAULT 0,max_points integer NOT NULL DEFAULT 1,checked_by text NOT NULL DEFAULT 'auto',mistake_type text,validated_by_server boolean NOT NULL DEFAULT false);
CREATE UNIQUE INDEX task_attempts_one_lesson_task_per_user ON public.task_attempts(user_id,lesson_id,task_id) WHERE lesson_id IS NOT NULL AND task_id IS NOT NULL AND validated_by_server;
CREATE TABLE public.lesson_results(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lesson_id uuid NOT NULL UNIQUE REFERENCES public.lessons(id) ON DELETE CASCADE,student_profile_id uuid NOT NULL REFERENCES public.student_profiles(id),user_id uuid NOT NULL,score integer NOT NULL DEFAULT 0,max_score integer NOT NULL DEFAULT 0,score_percent integer NOT NULL DEFAULT 0,completed_tasks integer NOT NULL DEFAULT 0,correct_tasks integer NOT NULL DEFAULT 0,wrong_tasks integer NOT NULL DEFAULT 0,summary text);
CREATE TABLE public.student_topic_progress(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_profile_id uuid NOT NULL REFERENCES public.student_profiles(id),subject_id uuid NOT NULL REFERENCES public.subjects(id),topic_id uuid NOT NULL REFERENCES public.topics(id),mastery_score integer NOT NULL DEFAULT 0 CHECK(mastery_score BETWEEN 0 AND 100),diagnostic_score integer,practice_score integer,status text NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','weak','learning','stable','mastered','needs_review')),last_activity_at timestamptz,attempts_count integer NOT NULL DEFAULT 0,mistakes_count integer NOT NULL DEFAULT 0,UNIQUE(student_profile_id,topic_id));
CREATE TABLE public.student_progress_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_profile_id uuid NOT NULL REFERENCES public.student_profiles(id),user_id uuid NOT NULL,subject_id uuid REFERENCES public.subjects(id),topic_id uuid REFERENCES public.topics(id),old_score integer NOT NULL DEFAULT 0,new_score integer NOT NULL DEFAULT 0,delta integer GENERATED ALWAYS AS (new_score-old_score) STORED,source text NOT NULL CHECK(source IN ('diagnostic','lesson','manual','teacher','ai','system')),source_ref_id uuid);
CREATE TABLE public.student_mistakes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),student_profile_id uuid NOT NULL REFERENCES public.student_profiles(id),subject_id uuid REFERENCES public.subjects(id),topic_id uuid REFERENCES public.topics(id),task_id uuid,mistake_type text NOT NULL CHECK(mistake_type IN ('concept_gap','careless_error','calculation_error','grammar_error','misread_task','no_strategy','vocabulary_gap','memory_gap','other')),source text);
CREATE TABLE public.calendar_events(id uuid PRIMARY KEY,lesson_id uuid REFERENCES public.lessons(id),user_id uuid NOT NULL,status text NOT NULL DEFAULT 'planned');
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lesson_tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lesson_materials ENABLE ROW LEVEL SECURITY; ALTER TABLE public.task_attempts ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lesson_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE public.student_topic_progress ENABLE ROW LEVEL SECURITY; ALTER TABLE public.student_mistakes ENABLE ROW LEVEL SECURITY; ALTER TABLE public.student_progress_history ENABLE ROW LEVEL SECURITY; ALTER TABLE public.learning_path_items ENABLE ROW LEVEL SECURITY; ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Students view own profile" ON public.student_profiles FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY "stp_select_own" ON public.student_topic_progress FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.student_profiles sp WHERE sp.id=student_profile_id AND sp.user_id=auth.uid()));
CREATE POLICY "stp_insert_own" ON public.student_topic_progress FOR INSERT TO authenticated WITH CHECK(EXISTS(SELECT 1 FROM public.student_profiles sp WHERE sp.id=student_profile_id AND sp.user_id=auth.uid()));
CREATE POLICY "stp_update_own" ON public.student_topic_progress FOR UPDATE TO authenticated USING(EXISTS(SELECT 1 FROM public.student_profiles sp WHERE sp.id=student_profile_id AND sp.user_id=auth.uid())) WITH CHECK(EXISTS(SELECT 1 FROM public.student_profiles sp WHERE sp.id=student_profile_id AND sp.user_id=auth.uid()));
CREATE POLICY "mistakes_select_own" ON public.student_mistakes FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.student_profiles sp WHERE sp.id=student_profile_id AND sp.user_id=auth.uid()));
CREATE POLICY "mistakes_insert_own" ON public.student_mistakes FOR INSERT TO authenticated WITH CHECK(EXISTS(SELECT 1 FROM public.student_profiles sp WHERE sp.id=student_profile_id AND sp.user_id=auth.uid()));
CREATE POLICY "Students view own progress history" ON public.student_progress_history FOR SELECT TO authenticated USING(auth.uid()=user_id);
CREATE POLICY "Students insert own progress history" ON public.student_progress_history FOR INSERT TO authenticated WITH CHECK(auth.uid()=user_id);
CREATE POLICY "lpi owner all" ON public.learning_path_items FOR ALL TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
CREATE POLICY "ce owner all" ON public.calendar_events FOR ALL TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
CREATE POLICY "Users can view their own lessons" ON public.lessons FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY "lt owner read" ON public.lesson_tasks FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY "lm owner read" ON public.lesson_materials FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY "lr owner read" ON public.lesson_results FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY "Users can view their own task attempts" ON public.task_attempts FOR SELECT TO authenticated USING(user_id=auth.uid());
GRANT SELECT ON public.lessons,public.lesson_tasks,public.lesson_materials,public.task_attempts,public.lesson_results TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
INSERT INTO public.student_profiles VALUES('${profile}','${uid}'); INSERT INTO public.subjects VALUES('${subject}'); INSERT INTO public.topics VALUES('${topic}'); INSERT INTO public.tasks VALUES('${task}');
INSERT INTO public.lessons(id,user_id,student_profile_id,subject_id,topic_id,status) VALUES('${lesson}','${uid}','${profile}','${subject}','${topic}','planned');
INSERT INTO public.lesson_tasks(lesson_id,task_id,user_id) VALUES('${lesson}','${task}','${uid}');
`);
await db.exec(migration);
await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${uid}'`);
await assert.rejects(db.query(`SELECT public.complete_lesson_atomic('${lesson}','${uid}')`),/permission denied/);
await db.exec('RESET ROLE; REVOKE INSERT, UPDATE, DELETE ON public.lesson_results FROM service_role; SET ROLE service_role');
await assert.rejects(db.query(`SELECT public.complete_lesson_atomic('${lesson}','${other}')`),/Forbidden/);
await assert.rejects(db.query(`SELECT public.complete_lesson_atomic('${lesson}','${uid}')`),/Ответьте/);
await assert.rejects(db.query(`INSERT INTO public.lesson_results(lesson_id,student_profile_id,user_id) VALUES('${lesson}','${profile}','${uid}')`),/permission denied/);
// Historical, unverified attempts must neither satisfy a required task nor
// collide with a new trusted attempt for the same lesson and task.
await db.query(`INSERT INTO public.task_attempts(user_id,lesson_id,subject_id,task_key,task_id,validated_by_server,is_correct) VALUES($1,$2,$3,$4::uuid::text,$4::uuid,false,true)`,[uid,lesson,subject,task]);
await assert.rejects(db.query(`SELECT public.complete_lesson_atomic($1,$2)`,[lesson,uid]),/Ответьте/);
await db.query(`INSERT INTO public.task_attempts(user_id,lesson_id,subject_id,task_key,task_id,validated_by_server,is_correct,points_awarded,max_points) VALUES($1,$2,$3,$4::uuid::text,$4::uuid,true,true,1,1)`,[uid,lesson,subject,task]);
const first=await db.query(`SELECT public.complete_lesson_atomic($1,$2) AS result`,[lesson,uid]);
assert.equal(first.rows[0].result.percent,100);
assert.equal(first.rows[0].result.already_completed,false);
const second=await db.query(`SELECT public.complete_lesson_atomic($1,$2) AS result`,[lesson,uid]);
assert.equal(second.rows[0].result.already_completed,true);
const progress=await db.query(`SELECT attempts_count,mistakes_count FROM public.student_topic_progress`);
assert.deepEqual(progress.rows,[{attempts_count:1,mistakes_count:0}]);
assert.equal((await db.query(`SELECT count(*)::integer AS n FROM public.task_attempts`)).rows[0].n,2);
await assert.rejects(db.query(`INSERT INTO public.task_attempts(user_id,lesson_id,subject_id,task_key,task_id,validated_by_server) VALUES($1,$2,$3,$4::uuid::text,$4::uuid,true)`,[uid,lesson,subject,task]),/завершено/);
await assert.rejects(db.query(`UPDATE public.task_attempts SET is_correct=false WHERE lesson_id=$1 AND validated_by_server`,[lesson]),/завершено/);
await assert.rejects(db.query(`DELETE FROM public.task_attempts WHERE lesson_id=$1 AND validated_by_server`,[lesson]),/завершено/);
// A failing downstream write rolls back the result and progress together.
const lesson2='40000000-0000-0000-0000-000000000002';
const task2='50000000-0000-0000-0000-000000000002';
await db.exec('RESET ROLE');
await db.exec(`INSERT INTO public.tasks VALUES('${task2}'); INSERT INTO public.lessons(id,user_id,student_profile_id,subject_id,topic_id,status) VALUES('${lesson2}','${uid}','${profile}','${subject}','${topic}','planned'); INSERT INTO public.lesson_tasks(lesson_id,task_id,user_id) VALUES('${lesson2}','${task2}','${uid}'); INSERT INTO public.task_attempts(user_id,lesson_id,subject_id,task_key,task_id,validated_by_server,is_correct,points_awarded,max_points) VALUES('${uid}','${lesson2}','${subject}','${task2}','${task2}',true,false,0,1); CREATE FUNCTION public.test_fail_mistake() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected failure'; END$$; CREATE TRIGGER test_fail BEFORE INSERT ON public.student_mistakes FOR EACH ROW EXECUTE FUNCTION public.test_fail_mistake();`);
await db.exec('SET ROLE service_role');
await assert.rejects(db.query(`SELECT public.complete_lesson_atomic($1,$2)`,[lesson2,uid]),/injected failure/);
assert.equal((await db.query(`SELECT count(*)::integer AS n FROM public.lesson_results WHERE lesson_id=$1`,[lesson2])).rows[0].n,0);
assert.equal((await db.query(`SELECT status FROM public.lessons WHERE id=$1`,[lesson2])).rows[0].status,'planned');
assert.equal((await db.query(`SELECT attempts_count FROM public.student_topic_progress`)).rows[0].attempts_count,1);
// Existing completed history remains readable; a partially saved historical
// result is never replayed and double-counted automatically.
const legacy='40000000-0000-0000-0000-000000000003';
const partial='40000000-0000-0000-0000-000000000004';
await db.exec('RESET ROLE');
await db.exec(`INSERT INTO public.lessons(id,user_id,student_profile_id,subject_id,status) VALUES('${legacy}','${uid}','${profile}','${subject}','completed'),('${partial}','${uid}','${profile}','${subject}','planned'); INSERT INTO public.lesson_results(lesson_id,student_profile_id,user_id,score,max_score,score_percent,summary) VALUES('${legacy}','${profile}','${uid}',2,3,67,'historic'),('${partial}','${profile}','${uid}',1,1,100,'partial');`);
await db.exec('SET ROLE service_role');
const oldResult=await db.query(`SELECT public.complete_lesson_atomic($1,$2) AS result`,[legacy,uid]);
assert.equal(oldResult.rows[0].result.summary,'historic');
assert.equal(oldResult.rows[0].result.already_completed,true);
await assert.rejects(db.query(`SELECT public.complete_lesson_atomic($1,$2)`,[partial,uid]),/проверка администратора/);
assert.equal((await db.query(`SELECT attempts_count FROM public.student_topic_progress`)).rows[0].attempts_count,1);
console.log('PGlite: permissions, historical attempts, required task, completion, retry, rollback and late attempt passed');
await db.close();
