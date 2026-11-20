import { expect, it, vi } from 'vitest';
const state = vi.hoisted(()=>({ ingest:vi.fn().mockResolvedValue({job_id:'job',count:1}) }));
vi.mock('@tanstack/react-start',()=>({createServerFn:()=>{const c={middleware:()=>c,inputValidator:()=>c,handler:(f:unknown)=>f};return c;}}));
vi.mock('@/integrations/supabase/auth-middleware',()=>({requireSupabaseAuth:{}}));
vi.mock('@/lib/extractor/audit-intake.server',()=>({auditIntakeSchema:{parse:(v:unknown)=>v},importAuditResult:state.ingest}));
import { importBookBatch } from '../src/lib/admin-book-import.functions';
import { importExtractorBatch } from '../src/lib/extractor/extractor.functions';
it('routes both previous audit entry points through the same job intake',async()=>{
 const sb={}, data={job_id:'job',units:[{}],confirmed:true}, context={supabase:sb,userId:'admin'};
 await (importBookBatch as any)({data,context});
 await (importExtractorBatch as any)({data,context});
 expect(state.ingest).toHaveBeenCalledTimes(2);
 expect(state.ingest).toHaveBeenNthCalledWith(1,sb,'admin',data);
 expect(state.ingest).toHaveBeenNthCalledWith(2,sb,'admin',data);
});
