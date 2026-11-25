import { describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({db:null as any}));
vi.mock('@/integrations/supabase/client.server',()=>({supabaseAdmin:new Proxy({}, {get:(_t,k)=>state.db[k]})}));
vi.mock('@tanstack/react-start',()=>({createServerFn:()=>{const c={middleware:()=>c,inputValidator:()=>c,handler:(fn:unknown)=>fn};return c;}}));
vi.mock('@/integrations/supabase/auth-middleware',()=>({requireSupabaseAuth:{}}));
import { setPublishedExtractorMaterialsTopic, addPublishedExtractorMaterialTopicLinks } from '../src/lib/extractor/jobs.functions';
type Row=Record<string,any>;
const job='job', subject='subject', topic='topic', sha='a'.repeat(64), text='Текст учебной единицы';
function setup(admin=true) {
  const tables:Record<string,Row[]>={
    extractor_jobs:[{id:job,status:'published',subject_id:subject,file_sha256:sha,rights_basis:'licensed'}],
    topics:[{id:topic,subject_id:subject}],curriculum_topic_meta:[{topic_id:topic,review_status:'approved'}],
    materials:[{id:'m',subject_id:subject,topic_id:null,content_text:text,status:'published',is_public:true,extractor_metadata:{job_id:job,unit_id:'u',source_sha256:sha,role:'student_material',review_status:'human_approved_original'}}],
    extractor_job_units:[{id:'r',job_id:job,unit_id:'u',material_id:'m',publish_state:'published',review_choice:'keep_original',reviewed_by:'admin',reviewed_at:'2026-11-25',raw:{unit_id:'u',role:'student_material',source:{sha256:sha},content_text:text}}],
    lesson_materials:[],material_topic_links:[],
  };
  let writes=0;
  const sb={rpc:async()=>({data:admin,error:null}),from:(table:string)=>{
    const conditions:((r:Row)=>boolean)[]=[];let mode='select',payload:Row={},single=false;
    const q:any={select:()=>q,eq:(key:string,v:unknown)=>{conditions.push(r=>key.startsWith('extractor_metadata->>')?r.extractor_metadata?.[key.split('->>')[1]]===v:r[key]===v);return q;},
      in:(key:string,vs:unknown[])=>{conditions.push(r=>vs.includes(r[key]));return q;},is:(key:string,v:unknown)=>{conditions.push(r=>r[key]===v);return q;},
      limit:()=>q,maybeSingle:()=>{single=true;return q;},single:()=>{single=true;return q;},
      update:(v:Row)=>{mode='update';payload=v;return q;},upsert:(v:Row[])=>{mode='upsert';payload=v;return q;},
      then:(resolve:(r:Row)=>unknown)=>{let rows=tables[table].filter(r=>conditions.every(f=>f(r)));
        if(mode==='update'){writes++;rows.forEach(r=>Object.assign(r,payload));}
        if(mode==='upsert'){writes++;for(const x of payload as Row[])if(!tables[table].some(r=>r.material_id===x.material_id&&r.topic_id===x.topic_id))tables[table].push(x);}
        return Promise.resolve(resolve({data:single?(rows[0]??null):rows,error:null}));},};return q;
  }};
  return {tables,sb,writes:()=>writes};
}
const call=(fn:unknown,s:ReturnType<typeof setup>,topicId:string|null=topic)=>{state.db=s.sb;return (fn as any)({data:{job_id:job,material_ids:['m'],topic_id:topicId},context:{supabase:s.sb,userId:'admin'}})};
describe('topic assignment requires approved topic and independently reviewed source',()=>{
  it.each([["primary",setPublishedExtractorMaterialsTopic],["secondary",addPublishedExtractorMaterialTopicLinks]] as const)('%s rejects a draft topic with no writes',async(_name,fn)=>{
    const s=setup();s.tables.curriculum_topic_meta[0].review_status='draft';await expect(call(fn,s)).rejects.toThrow();expect(s.writes()).toBe(0);
  });
  it.each([["primary",setPublishedExtractorMaterialsTopic],["secondary",addPublishedExtractorMaterialTopicLinks]] as const)('%s rejects metadata-only approval with no server review',async(_name,fn)=>{
    const s=setup();s.tables.extractor_job_units=[];await expect(call(fn,s)).rejects.toThrow();expect(s.writes()).toBe(0);
  });
  it.each([["primary",setPublishedExtractorMaterialsTopic],["secondary",addPublishedExtractorMaterialTopicLinks]] as const)('%s accepts a reviewed source and an approved topic',async(_name,fn)=>{
    const s=setup();await call(fn,s);expect(s.tables.materials[0].topic_id).toBe(topic);expect(s.tables.materials[0].content_text).toBe(text);
  });
  it.each([["primary",setPublishedExtractorMaterialsTopic],["secondary",addPublishedExtractorMaterialTopicLinks]] as const)('%s denies users without admin role',async(_name,fn)=>{
    const s=setup(false);await expect(call(fn,s)).rejects.toThrow('администратору');expect(s.writes()).toBe(0);
  });
  it.each(['private','embedded private','altered text','duplicate review','unknown rights','missing reviewer','cross subject','retired topic'])("rejects %s with no writes",async(why)=>{
    const s=setup();
    if(why==='private')s.tables.extractor_job_units[0].raw.role='teacher_private';
    if(why==='embedded private')s.tables.extractor_job_units[0].raw.source.source_blocks=[{source:{private_role:'teacher_private'}}];
    if(why==='altered text')s.tables.materials[0].content_text='changed';
    if(why==='duplicate review')s.tables.extractor_job_units.push({...s.tables.extractor_job_units[0],id:'r2'});
    if(why==='unknown rights')s.tables.extractor_jobs[0].rights_basis='unknown';
    if(why==='missing reviewer')s.tables.extractor_job_units[0].reviewed_by=null;
    if(why==='cross subject')s.tables.topics[0].subject_id='other';
    if(why==='retired topic')s.tables.curriculum_topic_meta[0].review_status='retired';
    await expect(call(addPublishedExtractorMaterialTopicLinks,s)).rejects.toThrow();expect(s.writes()).toBe(0);
  });
  it('primary assignment and re-run preserve history without duplicate writes',async()=>{
    const s=setup();expect(await call(setPublishedExtractorMaterialsTopic,s)).toEqual({updated:1,unchanged:0});const writes=s.writes();
    expect(await call(setPublishedExtractorMaterialsTopic,s)).toEqual({updated:0,unchanged:1});expect(s.writes()).toBe(writes);
    expect(s.tables.materials[0].extractor_metadata.topic_assignment_history).toHaveLength(1);
  });
  it('clearing the primary preserves history and does not silently delete secondary links',async()=>{
    const s=setup();await call(addPublishedExtractorMaterialTopicLinks,s);s.tables.extractor_job_units=[];
    await call(setPublishedExtractorMaterialsTopic,s,null);
    expect(s.tables.materials[0].topic_id).toBeNull();
    expect(s.tables.materials[0].extractor_metadata.topic_assignment_history).toMatchObject([{topic_id:topic,by:'admin'},{topic_id:null,by:'admin'}]);
    expect(s.tables.material_topic_links).toHaveLength(1);
  });
});
