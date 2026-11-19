import { describe, expect, it, vi } from 'vitest';
vi.mock('@tanstack/react-start',()=>({createServerFn:()=>{const c={middleware:()=>c,inputValidator:()=>c,handler:(f:unknown)=>f};return c;}}));
vi.mock('@/integrations/supabase/auth-middleware',()=>({requireSupabaseAuth:{}}));
import { previewImport } from '../src/lib/admin-materials.functions';

describe('CSV preview is read-only',()=>{
 it('validates normal and diagnostic rows without creating curriculum or tasks',async()=>{
  const from=vi.fn(()=>{throw new Error('Unexpected table access');});
  const sb={rpc:vi.fn(async()=>({data:true,error:null})),from};
  const data={rows:[{subject_title:'Biology',title:'Cells',material_type:'theory',topic_title:'Cells'},
   {subject_title:'Biology',diagnostic_title:'Entry',exam_task_number:'1',prompt:'Question',correct_answer:'yes',topic_title:'Cells'}]};
  const result=await (previewImport as any)({data,context:{supabase:sb,userId:'admin'}});
  expect(result.errors).toEqual([]);expect(result.created).toBe(2);expect(from).not.toHaveBeenCalled();
 });
 it('rejects non-admin before table access',async()=>{
  const from=vi.fn(); const sb={rpc:vi.fn(async()=>({data:false,error:null})),from};
  await expect((previewImport as any)({data:{rows:[]},context:{supabase:sb,userId:'student'}})).rejects.toThrow('admin');
  expect(from).not.toHaveBeenCalled();
 });
});
