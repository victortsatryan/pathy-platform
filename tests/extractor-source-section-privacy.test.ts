import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-start',()=>({createServerFn:()=>{const c={middleware:()=>c,inputValidator:()=>c,handler:(fn:unknown)=>fn};return c;}}));
vi.mock('@/integrations/supabase/auth-middleware',()=>({requireSupabaseAuth:{}}));
import { applySourceTopicSections } from '../src/lib/extractor/source-section.functions';
import { parseSourceSections } from '../src/lib/extractor/source-sections';

type Row=Record<string,any>;
const sha='a'.repeat(64), job='11111111-1111-4111-8111-111111111111', subject='s1';
const text='§ 12. Орфоэпия\n'+'Содержимое учебного параграфа с примерами и объяснениями. '.repeat(30);
function setup(sourceChanges:Row={}, allowed=true) {
  const tables:Record<string,Row[]>={
    extractor_jobs:[{id:job,status:'published',file_name:'x.txt',file_sha256:sha,rights_basis:'licensed',subject_id:subject}],
    materials:[{id:'m1',title:'Source',content_text:text,status:'published',is_public:true,extractor_metadata:{job_id:job,unit_id:'u1',source_sha256:sha,role:'student_material',review_status:'human_approved_original'},...sourceChanges}],
    extractor_job_units:[{id:'r1',job_id:job,unit_id:'u1',material_id:'m1',publish_state:'published',review_choice:'keep_original',reviewed_by:'admin',reviewed_at:'2026-11-25',raw:{unit_id:'u1',role:'student_material',source:{sha256:sha},content_text:text}}],
    topics:[{id:'t1',title:'Орфоэпия',subject_id:subject,is_public:true}],
    curriculum_topic_meta:[{topic_id:'t1',review_status:'approved'}],curriculum_topic_aliases:[],material_topic_links:[],
  };
  const sb={rpc:async()=>({data:allowed,error:null}),from:(table:string)=>{
    const conditions:((r:Row)=>boolean)[]=[];let mode='select',payload:Row={},single=false,limit=Infinity,start=0;
    const q:any={
      select:()=>q,eq:(key:string,value:unknown)=>{conditions.push(r=>key.startsWith('extractor_metadata->>')?r.extractor_metadata?.[key.split('->>')[1]]===value:r[key]===value);return q;},
      order:()=>q,limit:(n:number)=>{limit=n;return q;},range:(a:number,b:number)=>{start=a;limit=b-a+1;return q;},
      maybeSingle:()=>{single=true;return q;},single:()=>{single=true;return q;},
      insert:(v:Row)=>{mode='insert';payload=v;return q;},update:(v:Row)=>{mode='update';payload=v;return q;},upsert:(v:Row)=>{mode='upsert';payload=v;return q;},
      then:(resolve:(r:Row)=>unknown)=>{
        let rows=tables[table].filter(r=>conditions.every(f=>f(r))).slice(start,start+limit);
        if(mode==='insert'){const row={id:'derived',...payload};tables[table].push(row);rows=[row];}
        if(mode==='update')rows.forEach(r=>Object.assign(r,payload));
        if(mode==='upsert'){tables[table].push(payload);rows=[payload];}
        return Promise.resolve(resolve({data:single?(rows[0]??null):rows,error:null}));
      },
    }; return q;
  }};
  return {tables,sb};
}
const run=(s:ReturnType<typeof setup>)=>(applySourceTopicSections as any)({data:{job_id:job},context:{supabase:s.sb,userId:'admin'}});

describe('section publication respects source review and privacy',()=>{
  it.each([
    ['unreviewed published source',{extractor_metadata:{job_id:job,source_sha256:sha,role:'student_material',review_status:'auto_extracted_unverified'}}],
    ['private source',{status:'draft',is_public:false,extractor_metadata:{job_id:job,source_sha256:sha,role:'teacher_private',review_status:'human_approved_original'}}],
  ])('does not publish derived text from %s',async(_case,changes)=>{
    const s=setup(changes);await run(s);expect(s.tables.materials).toHaveLength(1);expect(s.tables.material_topic_links).toHaveLength(0);
  });
  it('retains exact approved heading handling for an editor-approved student source',async()=>{
    const s=setup();const result=await run(s);expect(result.created_materials).toBe(1);expect(s.tables.materials[1]).toMatchObject({status:'published',is_public:true,topic_id:'t1'});expect(s.tables.materials[1].content_text).toBe(text.trim());
  });
  it.each(['missing server review','forged metadata','changed content','ambiguous review','wrong source','embedded private block','no rights'])('blocks %s',async(why)=>{
    const s=setup();
    if(why==='missing server review') s.tables.extractor_job_units=[];
    if(why==='forged metadata') s.tables.extractor_job_units[0].reviewed_by=null;
    if(why==='changed content') s.tables.extractor_job_units[0].raw.content_text='different';
    if(why==='ambiguous review') s.tables.extractor_job_units.push({...s.tables.extractor_job_units[0],id:'r2'});
    if(why==='wrong source') s.tables.extractor_job_units[0].raw.source.sha256='b'.repeat(64);
    if(why==='embedded private block') s.tables.extractor_job_units[0].raw.source.source_blocks=[{educational_classification_v06:{role:'teacher_private'}}];
    if(why==='no rights') s.tables.extractor_jobs[0].rights_basis='unknown';
    if(why==='no rights') await expect(run(s)).rejects.toThrow('Права'); else await run(s);
    expect(s.tables.materials).toHaveLength(1);expect(s.tables.material_topic_links).toHaveLength(0);
  });
  it('does not borrow an exact heading from a different reviewed source unit',async()=>{
    const s=setup();
    s.tables.topics[0].title='Орфоэпия и произносительные нормы';
    const second='Контекст. '.repeat(90)+'\n§ 12. Орфоэпия и произносительные нормы\n'+'Короткий учебный текст с примерами и правилами. '.repeat(9);
    s.tables.materials.push({id:'m2',title:'Other',content_text:second,status:'published',is_public:true,extractor_metadata:{job_id:job,unit_id:'u2',source_sha256:sha,role:'student_material',review_status:'human_approved_original'}});
    s.tables.extractor_job_units.push({id:'r2',job_id:job,unit_id:'u2',material_id:'m2',publish_state:'published',review_choice:'keep_original',reviewed_by:'admin',reviewed_at:'2026-11-25',raw:{unit_id:'u2',role:'student_material',source:{sha256:sha},content_text:second}});
    expect(parseSourceSections([{id:'m1',title:'Source',content_text:text},{id:'m2',title:'Other',content_text:second}])[0]).toMatchObject({origin_material_id:'m1',title:'Орфоэпия и произносительные нормы'});
    await run(s);
    expect(s.tables.materials).toHaveLength(2);expect(s.tables.material_topic_links).toHaveLength(0);
  });
  it('requires an administrator',async()=>{const s=setup({},false);await expect(run(s)).rejects.toThrow('администратору');expect(s.tables.materials).toHaveLength(1);});
});
