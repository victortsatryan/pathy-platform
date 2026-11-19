import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticateBatchOidc } from '../src/lib/extractor/actions-oidc.server';

const { privateKey, publicKey } = generateKeyPairSync('rsa',{modulusLength:2048});
const sha='a'.repeat(40), repo='1419587278';
const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
function jwt(overrides:Record<string,unknown>={}) {
 const now=Math.floor(Date.now()/1000);
 const data=enc({alg:'RS256',kid:'k'})+'.'+enc({iss:'https://token.actions.githubusercontent.com',aud:'pathy-ext02-batch-v1',repository:'victortsatryan/pathy-content-pipeline',repository_id:repo,sha,ref:'refs/heads/main',event_name:'workflow_dispatch',workflow_ref:'victortsatryan/pathy-content-pipeline/.github/workflows/pathy-batch-intake.yml@refs/heads/main',run_attempt:'1',run_id:'123',iat:now,exp:now+300,...overrides});
 return data+'.'+sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');
}
afterEach(()=>vi.unstubAllGlobals());
describe('GitHub OIDC boundary',()=>{
 it('accepts only the pinned workflow identity and SHA',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({keys:[{...publicKey.export({format:'jwk'}),kid:'k',alg:'RS256',use:'sig'}]}))));
  expect(await authenticateBatchOidc(jwt(),{sha,repositoryId:repo})).toEqual({runId:'123',sha});
  for (const claims of [{sha:'b'.repeat(40)},{repository_id:'9'},{event_name:'push'},{run_attempt:'2'},{workflow_ref:'other'},{exp:1}])
   await expect(authenticateBatchOidc(jwt(claims),{sha,repositoryId:repo})).rejects.toThrow();
 });
});
