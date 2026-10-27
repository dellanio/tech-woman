import assert from 'node:assert/strict';
import {test} from 'node:test';
import {POST as change} from '../../src/app/api/admin/change/route';
import {POST as decide} from '../../src/app/api/admin/decide/route';
import {PUT as event} from '../../src/app/api/admin/event/route';

test('adapters administrativos antigos rejeitam mutação sem Origin antes de consultar sessão/banco',async()=>{
 for(const [path,handler,method] of [['change',change,'POST'],['decide',decide,'POST'],['event',event,'PUT']] as const){
  const response=await handler(new Request(`http://app.example.invalid/api/admin/${path}`,{method,headers:{'content-type':'application/json'},body:'{}'}));
  assert.equal(response.status,403,path);
  assert.equal((await response.json()).error.code,'CSRF_REJECTED',path);
  assert.equal(response.headers.get('cache-control'),'no-store',path);
 }
});
