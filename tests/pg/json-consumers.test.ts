import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {withDb} from './identity-harness.test';
import {actorOf} from './agenda-api-kit';

// Inventory of all pre-existing readJson consumers, including creation/patching.
const consumers = [
  [
    "admin/change",
    "POST"
  ],
  [
    "admin/decide",
    "POST"
  ],
  [
    "admin/event",
    "PUT"
  ],
  [
    "choice/[token]",
    "POST"
  ],
  [
    "v1/admin/enrollments/[id]/reassign",
    "POST"
  ],
  [
    "v1/admin/matches",
    "POST"
  ],
  [
    "v1/admin/matches/[id]",
    "PATCH"
  ],
  [
    "v1/admin/mentors",
    "POST"
  ],
  [
    "v1/admin/mentors/[id]",
    "PATCH"
  ],
  [
    "v1/admin/participants",
    "POST"
  ],
  [
    "v1/admin/participants/[id]",
    "PATCH"
  ],
  [
    "v1/admin/users",
    "POST"
  ],
  [
    "v1/admin/users/[id]",
    "PATCH"
  ],
  [
    "v1/admin/users/[id]/temporary-password",
    "POST"
  ],
  [
    "v1/auth/login",
    "POST"
  ],
  [
    "v1/auth/password/change",
    "POST"
  ],
  [
    "v1/auth/password/forgot",
    "POST"
  ],
  [
    "v1/auth/password/reset",
    "POST"
  ],
  [
    "v1/cohorts/[id]",
    "PATCH"
  ],
  [
    "v1/me/enrollments",
    "POST"
  ],
  [
    "v1/me/profiles/mentor",
    "POST"
  ],
  [
    "v1/me/profiles/participant",
    "POST"
  ],
  [
    "v1/mentor-topics/[id]",
    "PATCH"
  ],
  [
    "v1/mentor-topics/[id]/cohorts",
    "POST"
  ],
  [
    "v1/mentors/[mentorId]/topics",
    "POST"
  ],
  [
    "v1/mentors/[mentorId]/topics/reorder",
    "POST"
  ],
  [
    "v1/registrations/mentors",
    "POST"
  ],
  [
    "v1/registrations/participants",
    "POST"
  ],
  [
    "v1/topics",
    "POST"
  ],
  [
    "v1/topics/[id]",
    "PATCH"
  ]
] as const;

test('all existing readJson consumers: malformed and oversized ASCII/UTF8 retain 400 INVALID_JSON',()=>withDb(async({db})=>{
  const admin = await actorOf(db,['admin']);
  for (const [path, method] of consumers) {
    const module = await import('../../src/app/api/'+path+'/route');
    const params = {id:randomUUID(),mentorId:'1',token:'synthetic-token'};
    for (const body of ['{','"'+'a'.repeat(65535)+'"','"'+'é'.repeat(32768)+'"','"'+'🚀'.repeat(16384)+'"']) {
      const request = new Request('http://app.example.invalid/api/'+path,{method,headers:{
        Origin:'http://app.example.invalid','Content-Type':'application/json',Cookie:`tw_session=${admin.token}`,
        'X-CSRF-Token':admin.csrf,'Idempotency-Key':randomUUID(),'If-Match':'1',
      },body});
      const response: Response = await module[method](request,{params:Promise.resolve(params)});
      assert.equal(response.status,400,`${method} ${path}, bytes=${Buffer.byteLength(body)}`);
      assert.deepEqual((await response.json()).error,{code:'INVALID_JSON',message:'Envie um JSON válido.',fields:[]},path);
      assert.equal(response.headers.get('cache-control'),'no-store',path);
    }
  }
},{MENTOR_DEADLINE:'2099-01-01T00:00:00.000Z'}));
