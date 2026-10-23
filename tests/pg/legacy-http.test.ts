import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../scripts/migration/migrate';
import {seedDemo} from '../../scripts/seed-demo';
import {closeDb} from '../../src/lib/db';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:55301';

test('T02/R2: import db/auth/event/email/service sem qualquer socket ou DDL',()=>{
 const output=execFileSync(process.execPath,['--import','tsx','-e',`require('node:net').Socket.prototype.connect=function(){throw new Error('FORBIDDEN_NETWORK_ON_IMPORT')};Promise.all(['db','auth','event','email','service'].map(m=>import('./src/lib/'+m+'.ts'))).then(()=>console.log('IMPORT_NO_IO_OK'));`],{env:{...process.env,DATABASE_URL:'postgresql://unavailable@127.0.0.1:1/unavailable',MIGRATION_DATABASE_URL:undefined},encoding:'utf8'});
 assert.match(output,/IMPORT_NO_IO_OK/);
});

test('T01/T02/R2: cada handler aguarda DTO real; senha errada 401 sem cookie, páginas Recife',async()=>{
 const base=process.env.MIGRATION_DATABASE_URL;assert.ok(base,'PG16 real obrigatório');
 const control=new Pool({connectionString:base});const name='tw_http_'+randomUUID().replace(/-/g,'');await control.query(`CREATE DATABASE ${name}`);const url=new URL(base);url.pathname='/'+name;
 const password=randomBytes(24).toString('base64url'),adminEmail='admin-http@example.invalid';
 process.env.DATABASE_URL=url.toString();process.env.ADMIN_EMAIL=adminEmail;process.env.ADMIN_PASSWORD=password;
 await migrate(url.toString());await seedDemo();await closeDb();
 const app=spawn(process.execPath,process.env.TEST_STANDALONE==='1'?['.next/standalone/server.js']:['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',new URL(origin).port],{stdio:'ignore',env:{...process.env,PORT:new URL(origin).port,HOSTNAME:'127.0.0.1',DATABASE_URL:url.toString(),MIGRATION_DATABASE_URL:undefined,SESSION_SECRET:randomBytes(48).toString('hex'),APP_ORIGIN:origin,EMAIL_MODE:'fake',SES_SEND_ENABLED:'0',NEXT_TELEMETRY_DISABLED:'1'}});
 let cookie='';
 const call=async(path:string,method='GET',body?:unknown)=>{
  const response=await fetch(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();assert.ok(result&&typeof result==='object'&&Object.keys(result).length>0,'Promise serializada/vazio em '+path.replace(/\/[a-f0-9]{64}/g,'/<redacted>'));return {response,result};
 };
 try{
  let ready=false;for(let i=0;i<600;i++){if(app.exitCode!==null)throw new Error('Next encerrou antes do smoke');try{const res=await fetch(origin+'/api/mentor',{signal:AbortSignal.timeout(3000)});if(res.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,500));}assert.ok(ready,'Next deve subir');
  const home=await fetch(origin+'/');assert.equal(home.status,200);assert.match(await home.text(),/em Recife, PE/);
  let reply=await call('/api/admin/login','POST',{email:adminEmail,password:'wrong'});assert.equal(reply.response.status,401);assert.equal(reply.response.headers.get('set-cookie'),null);
  reply=await call('/api/admin/login','POST',{email:adminEmail,password});assert.equal(reply.response.status,200);assert.equal(reply.result.role,'owner');cookie=reply.response.headers.get('set-cookie')!.split(';')[0];
  reply=await call('/api/admin/overview');assert.equal(reply.response.status,200);assert.ok(Array.isArray(reply.result.participants));assert.ok(reply.result.mentors.length>0);
  const mentorId=reply.result.mentors[0].id;assert.equal(typeof mentorId,'string');
  reply=await call('/api/mentor');assert.equal(typeof reply.result.open,'boolean');
  reply=await call('/api/mentor','POST',{email:'mentor-http@example.invalid',trajectory:'Trajetória sintética',specialties:['dados'],availability:'Sem horário',capacity:4,consent:true});assert.equal(reply.response.status,201);assert.match(reply.result.protocol,/^M-/);
  const input={email:'participant-http@example.invalid',goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true};
  reply=await call('/api/participant','POST',input);assert.equal(reply.response.status,201);assert.match(reply.result.protocol,/^TW-/);const token=reply.result.token;assert.equal(typeof token,'string');
  reply=await call('/api/state/'+token);assert.equal(reply.response.status,200);assert.match(reply.result.emailStatus,/NÃO ENVIADA/);assert.equal(reply.response.headers.get('cache-control'),'no-store');
  reply=await call('/api/choice/'+token);assert.equal(reply.response.status,200);assert.ok(reply.result.choices.length>0);const chosen=reply.result.choices[0].mentorId;
  reply=await call('/api/choice/'+token,'POST',{mentorId:chosen});assert.equal(reply.response.status,200);assert.equal(reply.result.status,'Mentoria reservada');assert.match(reply.result.emailStatus,/NÃO ENVIADA/);
  reply=await call('/api/state/'+token);assert.equal(reply.result.status,'Mentoria reservada');
  const statePage=await fetch(origin+'/inscricao/estado/'+token);assert.equal(statePage.status,200);assert.match(await statePage.text(),/reservada/);
  reply=await call('/api/admin/overview');const person=reply.result.participants.find((p:{email:string})=>p.email===input.email);assert.ok(person);assert.equal(person.approvedMentorId,chosen);
  reply=await call('/api/admin/change','POST',{participantId:person.id,action:'cancel'});assert.equal(reply.response.status,200);assert.equal(reply.result.status,'Reserva cancelada');
  reply=await call('/api/participant','POST',{...input,email:'participant-decide@example.invalid'});assert.equal(reply.response.status,201);const secondToken=reply.result.token;
  reply=await call('/api/admin/overview');const second=reply.result.participants.find((p:{email:string})=>p.email==='participant-decide@example.invalid');assert.ok(second);
  reply=await call('/api/admin/decide','POST',{participantId:second.id,mentorId,action:'approve'});assert.equal(reply.response.status,200);assert.equal(reply.result.status,'Par aprovado');
  reply=await call('/api/state/'+secondToken);assert.equal(reply.result.status,'Mentoria reservada');
  reply=await call('/api/admin/change','POST',{mentorId,action:'deactivate'});assert.equal(reply.response.status,200);assert.equal(reply.result.status,'Mentora desativada');
  reply=await call('/api/admin/change','POST',{mentorId,action:'activate'});assert.equal(reply.response.status,200);
  reply=await call('/api/admin/change','POST',{action:'remove-demo'});assert.equal(reply.response.status,200);assert.match(reply.result.status,/desativadas/);
  reply=await call('/api/admin/event');assert.equal(reply.response.status,200);const event={description:reply.result.description,venue:'Recife sintético',agenda:'Texto preservado',speakers:'',date:'2026-11-14',duration:''};
  reply=await call('/api/admin/event','PUT',event);assert.equal(reply.response.status,200);assert.equal(reply.result.venue,event.venue);
  reply=await call('/api/admin/event');assert.equal(reply.result.date,event.date);
  reply=await call('/api/state/'+'f'.repeat(64));assert.equal(reply.response.status,404);
  reply=await call('/api/admin/logout','POST');assert.equal(reply.result.ok,true);assert.match(reply.response.headers.get('set-cookie')!,/Max-Age=0/);cookie='';
  reply=await call('/api/admin/overview');assert.equal(reply.response.status,401);
 }finally{app.kill('SIGTERM');await new Promise<void>(resolve=>{if(app.exitCode!==null)resolve();else app.once('exit',()=>resolve());});await control.end();await closeDb();}
});
