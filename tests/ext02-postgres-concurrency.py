"""Run only against an empty isolated local test database; never production."""
import concurrent.futures
import json
import os
import subprocess

socket = os.environ['PATHY_TEST_PG_SOCKET']
name = os.environ['PATHY_TEST_PG_DATABASE']
if not socket.startswith('/tmp/') or not name.startswith('pathy_test_'):
    raise SystemExit('An isolated local test database is required')
cmd = [os.environ['PATHY_TEST_PSQL'], '-X', '-h', socket, '-p', os.environ['PATHY_TEST_PG_PORT'], '-d', name, '-At', '-v', 'ON_ERROR_STOP=1', '-c']
def query(sql):
    return subprocess.run(cmd + [sql], capture_output=True, text=True)
def must(sql):
    result = query(sql)
    if result.returncode: raise RuntimeError(result.stderr[:500])
    return result.stdout.strip()
assert must('SELECT inet_server_addr() IS NULL') == 't'
u='00000000-0000-0000-0000-000000000001'; job='10000000-0000-0000-0000-000000000001'; sha='a'*64; code='b'*40
must(f"INSERT INTO extractor_jobs(id,file_sha256,file_name,size_bytes,storage_path,status) VALUES('{job}','{sha}','a.txt',1,'{sha}/a.txt','uploaded')")
reserve=f"SET ROLE service_role; SELECT ext02_reserve_job('{job}','{u}','{code}','20000000-0000-4000-8000-000000000001')"
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex: results=list(ex.map(lambda _:query(reserve),range(10)))
assert sum(r.returncode==0 for r in results)==1
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
    claims=list(ex.map(lambda i:query(f"SET ROLE service_role; SELECT ext02_claim_job('{job}','{i}','{code}')"),range(1,11)))
assert sum(r.returncode==0 for r in claims)==1
winning=str(next(i for i,r in enumerate(claims,1) if r.returncode==0))
unit={'unit_id':f'source:{sha}:unit:a','source':{'sha256':sha},'role':'student_material','usable_for_grading':False,'usable_for_learning':False}
payload={'format':'pathy-extraction-result-v1','source':{'sha256':sha},'summary':{'total_units':1},'pipeline_context':{'source_sha256':sha,'source_original_bytes_verified':True,'source_block_linkage_complete':True},'units':[unit]}
raw=json.dumps(payload,separators=(',',':'))
complete=f"SET ROLE service_role; SELECT ext02_complete_job('{job}','{winning}','{raw}'::jsonb)"
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex: results=list(ex.map(lambda _:query(complete),range(10)))
assert all(r.returncode==0 for r in results),[r.stderr for r in results]
assert must("SELECT status,(SELECT count(*) FROM extractor_job_units) FROM extractor_jobs")=='succeeded|1'
print('10 concurrent reservations: one; 10 run claims: one; 10 identical completions: one unit')
# The two manual entry points share this transaction. Concurrent identical
# imports are retries; a changed payload cannot replace history.
manual_job='10000000-0000-0000-0000-000000000002'; other='c'*64
must(f"INSERT INTO extractor_jobs(id,file_sha256,file_name,size_bytes,storage_path,status) VALUES('{manual_job}','{other}','b.txt',1,'{other}/b.txt','uploaded')")
manual_unit={'unit_id':f'source:{other}:unit:legacy:one','source':{'sha256':other,'intake_mode':'manual_audit'},'role':'student_material','requires_manual_review':True,'usable_for_grading':False,'usable_for_learning':False}
manual={'format':'pathy-extraction-result-v1','source':{'sha256':other},'summary':{'total_units':1},'pipeline_context':{'mode':'manual_audit','source_sha256':other,'source_original_bytes_verified':True,'source_block_linkage_complete':False},'units':[manual_unit]}
body=json.dumps(manual,separators=(',',':'))
q=f"SET ROLE service_role; SELECT ext02_import_audit_result('{manual_job}','{u}','{body}'::jsonb)"
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex: results=list(ex.map(lambda _:query(q),range(10)))
assert all(r.returncode==0 for r in results),[r.stderr for r in results]
assert must(f"SELECT count(*) FROM extractor_job_units WHERE job_id='{manual_job}'")=='1'
manual['units'][0]['title']='changed'
changed=json.dumps(manual,separators=(',',':'))
assert query(f"SET ROLE service_role; SELECT ext02_import_audit_result('{manual_job}','{u}','{changed}'::jsonb)").returncode!=0
print('10 concurrent identical audit imports: one unit; changed payload rejected')
