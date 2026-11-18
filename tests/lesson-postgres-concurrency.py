import concurrent.futures,subprocess,json,time,os

socket=os.environ["PATHY_TEST_PG_SOCKET"]
port=os.environ["PATHY_TEST_PG_PORT"]
database=os.environ["PATHY_TEST_PG_DATABASE"]
binary=os.environ["PATHY_TEST_PSQL"]
if not socket.startswith("/tmp/") or not database.startswith("pathy_test_"):
 raise SystemExit("An isolated local test socket and pathy_test_ database are required")
p=[binary,'-X','-h',socket,'-p',port,'-d',database,'-At','-v','ON_ERROR_STOP=1','-c']
u='00000000-0000-0000-0000-000000000001';pr='10000000-0000-0000-0000-000000000001';s='20000000-0000-0000-0000-000000000001';topic='30000000-0000-0000-0000-000000000001'
def lesson(i): return f'40000000-0000-0000-0000-{i:012d}'
def task(i): return f'50000000-0000-0000-0000-{i:012d}'
def q(sql): return subprocess.run(p+[sql],capture_output=True,text=True)
def must(sql):
 r=q(sql)
 if r.returncode: raise RuntimeError(r.stderr[:500])
 return r.stdout
assert must("SELECT inet_server_addr() IS NULL").strip()=="t"
must(f"INSERT INTO auth.users VALUES('{u}'); INSERT INTO subjects(id) VALUES('{s}'); INSERT INTO topics(id,subject_id) VALUES('{topic}','{s}'); INSERT INTO student_profiles(id,user_id) VALUES('{pr}','{u}');")
for i in range(1,6):
 must(f"INSERT INTO tasks(id,subject_id,topic_id,task_key,prompt) VALUES('{task(i)}','{s}','{topic}','{task(i)}','test'); INSERT INTO lessons(id,user_id,student_profile_id,subject_id,topic_id,lesson_date,title,status) VALUES('{lesson(i)}','{u}','{pr}','{s}','{topic}','2026-11-18','lesson','planned'); INSERT INTO lesson_tasks(lesson_id,task_id,user_id) VALUES('{lesson(i)}','{task(i)}','{u}');")
def attempt(i): return f"INSERT INTO task_attempts(user_id,lesson_id,subject_id,task_key,task_id,validated_by_server,is_correct,points_awarded,max_points) VALUES('{u}','{lesson(i)}','{s}','{task(i)}','{task(i)}',true,true,1,1)"
def complete(i): return f"SET ROLE service_role; SELECT complete_lesson_atomic('{lesson(i)}','{u}')"
must(attempt(1))
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex: rs=list(ex.map(lambda _:q(complete(1)),range(20)))
vals=[json.loads(x.stdout.splitlines()[-1]) for x in rs if not x.returncode]
assert len(vals)==20 and sum(not x['already_completed'] for x in vals)==1
assert must('SELECT (SELECT count(*) FROM lesson_results),(SELECT attempts_count FROM student_topic_progress),(SELECT count(*) FROM student_progress_history)').strip()=='1|1|1'
print('20 concurrent completions: 1 first, 19 repeats, 1 result, progress +1')
a=subprocess.Popen(p+[f'BEGIN; {attempt(2)}; SELECT pg_sleep(1); COMMIT;'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);time.sleep(.2);start=time.monotonic();b=q(complete(2));elapsed=time.monotonic()-start;out,err=a.communicate();assert not a.returncode and not b.returncode and elapsed>.5 and json.loads(b.stdout.splitlines()[-1])['score']==1
print('completion vs pending attempt: waited for commit, counted once')
must(attempt(3));must(attempt(4))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex: rs=list(ex.map(lambda i:q(complete(i)),[3,4]))
assert all(x.returncode==0 for x in rs),[x.stderr for x in rs]
assert must('SELECT attempts_count FROM student_topic_progress').strip()=='4'
print('2 concurrent lessons, same topic: no lost increments')
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex: submissions=list(ex.map(lambda _:q(attempt(5)),range(10)))
assert sum(r.returncode==0 for r in submissions)==1
assert all('duplicate key' in r.stderr for r in submissions if r.returncode)
print('10 concurrent submits: one trusted attempt')
must(f"INSERT INTO tasks(id,subject_id,topic_id,task_key,prompt) VALUES('{task(6)}','{s}','{topic}','{task(6)}','test'); INSERT INTO lesson_tasks(lesson_id,task_id,user_id,is_required) VALUES('{lesson(5)}','{task(6)}','{u}',false)")
holder=subprocess.Popen(p+[f"BEGIN; {complete(5)}; SELECT pg_sleep(1); COMMIT;"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
time.sleep(.2)
late=q(f"INSERT INTO task_attempts(user_id,lesson_id,subject_id,task_key,task_id,validated_by_server) VALUES('{u}','{lesson(5)}','{s}','{task(6)}','{task(6)}',true)")
out,err=holder.communicate()
assert not holder.returncode and late.returncode and 'завершено' in late.stderr
assert must('SELECT attempts_count FROM student_topic_progress').strip()=='5'
print('completion vs late optional attempt: late write rejected')
dt='60000000-0000-0000-0000-000000000001'; ds='70000000-0000-0000-0000-000000000001'
must(f"INSERT INTO diagnostic_tests(id) VALUES('{dt}'); INSERT INTO diagnostic_test_tasks(diagnostic_test_id,task_id,points) VALUES('{dt}','{task(1)}',1); INSERT INTO diagnostic_sessions(id,user_id,subject_id,student_profile_id,diagnostic_test_id,diagnostic_type,status) VALUES('{ds}','{u}','{s}','{pr}','{dt}','entry','in_progress')")
payload=json.dumps([dict(task_id=task(1),student_answer='wrong',is_correct=False,points_awarded=0,max_points=1,mistake_type='other',answer_key_snapshot=None)])
diag=f"SET ROLE service_role; SELECT complete_diagnostic_atomic('{ds}','{u}','{payload}'::jsonb)"
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex: rs=list(ex.map(lambda _:q(diag),range(10)))
assert all(x.returncode==0 for x in rs),[x.stderr for x in rs]
assert must(f"SELECT attempts_count,mistakes_count,(SELECT count(*) FROM diagnostic_answers WHERE diagnostic_session_id='{ds}'),(SELECT count(*) FROM student_mistakes WHERE source='diagnostic') FROM student_topic_progress").strip()=='6|1|1|1'
print('10 concurrent diagnostics: one answer, one mistake, progress +1')
ds2='70000000-0000-0000-0000-000000000002'
must(f"INSERT INTO tasks(id,subject_id,topic_id,task_key,prompt) VALUES('{task(7)}','{s}','{topic}','{task(7)}','test'); INSERT INTO lessons(id,user_id,student_profile_id,subject_id,topic_id,lesson_date,title,status) VALUES('{lesson(7)}','{u}','{pr}','{s}','{topic}','2026-11-18','lesson','planned'); INSERT INTO lesson_tasks(lesson_id,task_id,user_id) VALUES('{lesson(7)}','{task(7)}','{u}'); INSERT INTO diagnostic_sessions(id,user_id,subject_id,student_profile_id,diagnostic_test_id,diagnostic_type,status) VALUES('{ds2}','{u}','{s}','{pr}','{dt}','entry','in_progress'); {attempt(7)}")
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
 rs=list(ex.map(q,[diag.replace(ds,ds2),complete(7)]))
assert all(x.returncode==0 for x in rs),[x.stderr for x in rs]
assert must('SELECT attempts_count,mistakes_count FROM student_topic_progress').strip()=='8|2'
print('concurrent diagnostic and lesson on same topic: both increments preserved')
