import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {withDb} from './identity-harness.test';

const freePort = () => new Promise<number>((resolve,reject) => {
  const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
    const address=server.address();server.close(()=>typeof address==='object'&&address?resolve(address.port):reject(new Error('porta indisponível')));
  });
});

test('JSON guard over real Next HTTP: oversized uploads return INVALID_JSON without resetting subsequent requests',()=>withDb(async({runtimeUrl})=>{
  const port=await freePort(),origin=`http://127.0.0.1:${port}`;
  const standalone=process.env.TEST_STANDALONE==='1';
  const child=spawn(process.execPath,standalone?['.next/standalone/server.js']:['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',String(port)],{
    stdio:'ignore',env:{...process.env,DATABASE_URL:runtimeUrl,MIGRATION_DATABASE_URL:undefined,HOSTNAME:'127.0.0.1',PORT:String(port),APP_ORIGIN:origin,MENTOR_DEADLINE:'2099-01-01T00:00:00.000Z',NEXT_TELEMETRY_DISABLED:'1'},
  });
  try {
    let ready=false;
    for(let i=0;i<180;i++){
      assert.equal(child.exitCode,null,'web vivo');
      try {if((await fetch(origin+'/api/v1/auth/session',{signal:AbortSignal.timeout(2000)})).status===401){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,1000));
    }
    assert.ok(ready,'web pronto');
    // Real fetch pooling, repeated transitions across adapters: cancellation of the
    // incoming stream used to destroy the keep-alive socket after a 400 response.
    for(let i=0;i<10;i++)for(const path of ['/api/admin/login','/api/mentor','/api/participant']){
      const raw=JSON.stringify({padding:'🚀'.repeat(65537)});
      const send=(body:string)=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(60000)});
      const large=await send(raw);
      assert.equal(large.status,400,path);
      assert.equal((await large.json()).error.code,'INVALID_JSON',path);
      const small=await send('{}');
      assert.equal(small.status,path.includes('login')?401:400,path);
      assert.equal(typeof (await small.json()).error,'string',path);
    }
  } finally {
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
  }
},{MENTOR_DEADLINE:'2099-01-01T00:00:00.000Z'}));
