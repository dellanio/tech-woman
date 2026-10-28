/** Finalização do cadastro público com crossing (AJUSTE-INSCRICAO): conta active com senha definitiva, perfil e match numa transação; sem e-mail. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {verifyPassword,hashPassword} from '../../src/lib/db';
import {canonicalHash} from '../../src/lib/contracts';
import * as identity from '../../src/lib/identity';
import * as email from '../../src/lib/email';
import {mentorRef} from '../../src/lib/crossing';
import * as participants from '../../src/app/api/v1/registrations/participants/route';
import * as preview from '../../src/app/api/v1/registrations/participants/preview/route';
import * as legacyParticipant from '../../src/app/api/participant/route';
import {withDb,addUser,synthetic,roleUrl,linkFixture} from './identity-harness.test';
import {call,code,sameShape,type Reply} from './identity-http-kit.test';
import {DIAGNOSTIC,crossingMentors,fullSnapshot} from './crossing-fixtures';

const REG='/api/v1/registrations/participants',PREVIEW='/api/v1/registrations/participants/preview';
const strong=()=>`Recife-${randomBytes(12).toString('base64url')}`;
const signup=(addr:string,ref:string,password:string,extra:Record<string,unknown>={})=>({email:addr,...DIAGNOSTIC,consent:true,mentor_ref:ref,password,passwordConfirmation:password,...extra});
const send=(body:unknown,key:string|null=randomUUID(),headers:Record<string,string|null>={})=>call(participants.POST,REG,{body,...(key?{key}:{}),headers});
const refs=async()=>((await call(preview.POST,PREVIEW,{body:DIAGNOSTIC})).json.data as {mentor_ref:string;nome_exibicao:string}[]);
const NEUTRAL={status:'received',next:'login'};
/** Varre todas as tabelas; só devolve boolean (nenhum segredo impresso). */
const leaked=async(db:Pool,secrets:string[])=>{
 const tables=(await db.query("select table_schema s,table_name t from information_schema.tables where table_schema in ('public','internal','legacy_snapshot') and table_type='BASE TABLE'")).rows;
 for(const {s,t} of tables){const dump=JSON.stringify((await db.query(`select to_jsonb(x)::text j from ${s}.${t} x`)).rows);if(secrets.some(v=>dump.includes(v)))return true;}
 return false;
};

test('finalização: conta active com senha definitiva (só hash), perfil, match da mentora escolhida (troca), nenhum e-mail; login full',async()=>withDb(async({db})=>{
 const m=await crossingMentors(db);
 const choices=await refs();assert.equal(choices[0].nome_exibicao,'Eva Demo');
 const chosen=choices.find(c=>c.nome_exibicao==='Ana Dados')!;// troca: não é a primeira do ranking
 const password=strong();
 const r=await send(signup('  Nova.Pessoa@Example.invalid ',chosen.mentor_ref,password));
 assert.deepEqual([r.status,r.json.data],[202,NEUTRAL]);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.equal(r.text.includes(password),false);
 const u=(await db.query(`select id,email,status,password_hash,temporary_password_hash,temporary_expires_at,temporary_used_at,must_change_password m,credential_generation::int g from app_user where email_key='nova.pessoa@example.invalid'`)).rows[0];
 assert.deepEqual([u.email,u.status,u.temporary_password_hash,u.temporary_expires_at,u.temporary_used_at,u.m,u.g],['Nova.Pessoa@Example.invalid','active',null,null,null,false,0]);
 assert.match(u.password_hash,/^[a-f0-9]{32}:[a-f0-9]{128}$/);assert.equal(await verifyPassword(password,u.password_hash),true,'hash scrypt existente da senha escolhida');
 assert.deepEqual((await db.query('select role from user_role where user_id=$1',[u.id])).rows,[{role:'participant'}]);
 const p=(await db.query('select id::text,goal,moment,interests,skills,area,consent_version,consent_at is not null c,active from participant where user_id=$1',[u.id])).rows[0];
 assert.deepEqual([p.goal,p.moment,p.interests,p.skills,p.area,p.consent_version,p.c,p.active],['growth','working',['dados','design'],['analise','gestao'],'dados','v1',true,true]);
 const x=(await db.query('select mentor_id::text mentor,score,reasons,status,origin,enrollment_id from match where participant_id=$1',[p.id])).rows;
 const ranking=(await db.query('select (internal.agenda_ranking($1,$2)).*',[p.id,m.ana])).rows[0];
 assert.deepEqual(x,[{mentor:m.ana,score:ranking.o_score,reasons:ranking.o_reasons,status:'suggested',origin:'current',enrollment_id:null}]);
 assert.equal(ranking.o_score,9);
 assert.equal((await db.query("select count(*)::int n from audit_event where action='match.create' and actor_user_id=$1",[u.id])).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from email_job')).rows[0].n,0,'caminho normal não enfileira e-mail');
 const worker=await email.runEmailWorkerOnce(email.createMemoryTransport(()=>{throw new Error('nenhum envio esperado');}));assert.equal(worker.claimed,0);
 const logged=await identity.login('nova.pessoa@example.invalid',password);
 assert.equal(logged?.state,'authenticated','login direto em sessão full, sem troca obrigatória');
 const session=await identity.identitySession(logged!.token);assert.deepEqual([session?.scope,session?.roles],['full',['participant']]);
 assert.equal(await leaked(db,[password]),false,'senha crua em nenhuma tabela');
}));

test('atomicidade: referência forjada/incompatível/de outro diagnóstico, mudança de compatibilidade e falha no meio → nada gravado',async()=>withDb(async({db,url})=>{
 const m=await crossingMentors(db);const choices=await refs();const password=strong();
 const evaRef=choices[0].mentor_ref,anaRef=choices[1].mentor_ref;
 const before=await fullSnapshot(db);
 const rejects=async(label:string,body:unknown)=>{const r=await send(body);assert.deepEqual([label,r.status,code(r),r.json.error?.fields],[label,422,'INVALID_INPUT',['mentor_ref']]);assert.deepEqual(await fullSnapshot(db),before,label);return r;};
 await rejects('forjada',signup('a@example.invalid',randomBytes(32).toString('base64url').slice(0,43),password));
 await rejects('id cru',signup('a@example.invalid',m.ana.padStart(43,'0'),password));
 await rejects('score 0',signup('a@example.invalid',mentorRef(m.zero),password));
 await rejects('inativa',signup('a@example.invalid',mentorRef(m.inativa),password));
 await rejects('protegida',signup('a@example.invalid',mentorRef(m.protegida),password));
 await rejects('outro diagnóstico',signup('a@example.invalid',anaRef,password,{goal:'transition',interests:['desenvolvimento'],skills:['codigo'],area:'outra',otherArea:'Biotecnologia'}));
 // compatibilidade muda entre o preview e a finalização
 await db.query('update mentor set active=false where id=$1',[m.eva]);
 const changed=await fullSnapshot(db);
 let r=await send(signup('a@example.invalid',evaRef,password));assert.deepEqual([r.status,r.json.error.fields],[422,['mentor_ref']]);assert.deepEqual(await fullSnapshot(db),changed);
 await db.query(`update mentor set specialties='["produto"]' where id=$1`,[m.ana]);
 const changed2=await fullSnapshot(db);
 r=await send(signup('a@example.invalid',anaRef,password));assert.deepEqual([r.status,r.json.error.fields],[422,['mentor_ref']]);assert.deepEqual(await fullSnapshot(db),changed2);
 // corrida: a função SQL revalida sozinha (id resolvido antes, mentora desativada depois)
 const runtime=new (await import('pg')).Client({connectionString:roleUrl(url,'techwoman_runtime')});await runtime.connect();
 try{
  await assert.rejects(runtime.query('select internal.register_participant_account($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)',['b@example.invalid',await hashPassword(password),'growth','working','["dados","design"]','["analise","gestao"]','dados',m.eva]),
   (e:{message?:string})=>e.message==='registration_mentor_unavailable');
  await assert.rejects(runtime.query('select internal.register_participant_account($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)',['b@example.invalid','não-é-hash','growth','working','["dados","design"]','["analise","gestao"]','dados',m.semNome]),
   (e:{message?:string})=>e.message==='invalid registration','só aceita o formato do hash existente');
 }finally{await runtime.end();}
 assert.deepEqual(await fullSnapshot(db),changed2);
 // falha no último INSERT (match): conta, papel e perfil desfeitos juntos
 await db.query("create function public.test_fail_match() returns trigger language plpgsql as $$ begin raise exception 'falha injetada'; end $$");
 await db.query('create trigger test_fail_match before insert on public.match for each row execute function public.test_fail_match()');
 const injected=await fullSnapshot(db);
 r=await send(signup('falha@example.invalid',choices[2].mentor_ref,password));
 assert.deepEqual([r.status,code(r)],[503,'DEPENDENCY_UNAVAILABLE']);assert.equal(r.text.includes('falha injetada'),false);
 assert.deepEqual(await fullSnapshot(db),injected,'rollback total: nenhuma linha de app_user/user_role/participant/match/idempotência');
 await db.query('drop trigger test_fail_match on public.match');
 r=await send(signup('falha@example.invalid',choices[2].mentor_ref,password));assert.equal(r.status,202,'nova tentativa funciona depois da falha');
 assert.equal((await db.query("select count(*)::int n from app_user where email_key='falha@example.invalid'")).rows[0].n,1);
},{RATE_EMAIL_PER_HOUR:'100',RATE_IP_PER_HOUR:'100'}));

test('anti-enumeração: e-mail ativo/pendente/desativado/admin, legado sem vínculo e chave privilegiada → 202 idêntico, nada muda, senha antiga intacta',async()=>withDb(async({db})=>{
 await crossingMentors(db);const choices=await refs();const old=synthetic();
 await addUser(db,{email:'ativa@example.invalid',password:old});await addUser(db,{email:'pendente@example.invalid',status:'pending_activation'});
 await addUser(db,{email:'off@example.invalid',password:old,status:'disabled'});await addUser(db,{email:'adm@example.invalid',password:old,roles:['admin']});
 await db.query(`insert into participant(email,goal,moment,interests,skills,token_hash,consent_version) values('Legada@Example.invalid','growth','working','["dados"]','["analise"]','${'a'.repeat(64)}','v0')`);
 await db.query(`insert into mentor(email,trajectory,specialties,availability,capacity) values('mentora.legada@example.invalid','t','["produto"]','a',2)`);
 const {link}=await linkFixture(db);await link('admin_user','  Candidata@Example.invalid ',null,'privileged_candidate');
 const fresh=await send(signup('livre@example.invalid',choices[0].mentor_ref,strong()));assert.deepEqual([fresh.status,fresh.json.data],[202,NEUTRAL]);
 // api_idempotency registra cada pedido (igual para e-mail livre ou indisponível): fica fora, como no teste de chaves protegidas
 const before=await fullSnapshot(db,{skip:['public.api_idempotency']});
 const hashes=JSON.stringify((await db.query('select id,password_hash from app_user order by id')).rows);
 const replies:Reply[]=[];
 for(const addr of ['ATIVA@example.invalid','pendente@example.invalid ','off@example.invalid','adm@example.invalid','legada@example.invalid','Mentora.Legada@example.invalid','candidata@example.invalid','livre@example.invalid']){
  const pw=strong();const r=await send(signup(addr,choices[1].mentor_ref,pw));replies.push(r);
  assert.equal(await identity.login(addr,pw),null,`${addr}: a senha nova não vale`);
 }
 for(const r of replies){assert.equal(sameShape(r,fresh),true);assert.equal(r.headers.get('set-cookie'),null);}
 assert.deepEqual(await fullSnapshot(db,{skip:['public.api_idempotency']}),before,'nenhuma linha muda (sem papel, perfil, match, job ou credencial)');
 assert.equal(JSON.stringify((await db.query('select id,password_hash from app_user order by id')).rows),hashes);
 assert.equal((await identity.login('ativa@example.invalid',old))?.state,'authenticated','senha antiga intacta');
 // erro de mentora também não depende do e-mail
 const a=await send(signup('ativa@example.invalid',mentorRef('999999'),strong())),b=await send(signup('ninguem@example.invalid',mentorRef('999999'),strong()));
 assert.equal(sameShape(a,b),true);assert.equal(a.status,422);
},{RATE_EMAIL_PER_HOUR:'100',RATE_IP_PER_HOUR:'100'}));

test('contrato: senha 12..128, confirmação igual, mentor_ref/consent obrigatórios; corpo antigo recusado no v1 e no adapter legado; limites por e-mail',async()=>withDb(async({db})=>{
 await crossingMentors(db);const ref=(await refs())[0].mentor_ref;const pw=strong();
 const fields=async(body:unknown)=>{const r=await send(body);assert.equal(r.status,422);return r.json.error.fields as string[];};
 assert.deepEqual(await fields(signup('c@example.invalid',ref,'curta-11ch')),['password']);
 assert.deepEqual(await fields(signup('c@example.invalid',ref,'x'.repeat(129))),['password']);
 assert.deepEqual(await fields(signup('c@example.invalid',ref,pw,{passwordConfirmation:pw+'!'})),['passwordConfirmation']);
 const {mentor_ref:_r,...noRef}=signup('c@example.invalid',ref,pw);assert.deepEqual(await fields(noRef),['mentor_ref']);
 assert.deepEqual(await fields(signup('c@example.invalid',ref,pw,{consent:false})),['consent']);
 assert.ok((await fields(signup('c@example.invalid',ref,pw,{roles:['admin']}))).includes('roles'));
 const oldBody={email:'antigo@example.invalid',...DIAGNOSTIC,consent:true};
 assert.ok((await fields(oldBody)).length>0,'v1 não cria conta sem credenciais nem crossing');
 const before=await fullSnapshot(db);
 const legacy=await call(legacyParticipant.POST,'/api/participant',{body:oldBody});
 assert.equal(legacy.status,400,'adapter antigo também recusa o corpo antigo');assert.equal(typeof legacy.json.error,'string');
 assert.deepEqual(await fullSnapshot(db),before,'nenhum bypass legado cria participante');
 const viaLegacy=await call(legacyParticipant.POST,'/api/participant',{body:signup('legado.novo@example.invalid',ref,pw)});
 assert.deepEqual([viaLegacy.status,viaLegacy.json],[202,NEUTRAL],'adapter antigo só aceita o mesmo DTO novo (mesma regra, sem atalho)');
 for(let i=0;i<2;i++)assert.equal((await send(signup('limite@example.invalid',ref,strong()))).status,202);
 assert.equal((await send(signup('limite@example.invalid',ref,strong()))).status,202);
 const blocked=await send(signup('limite@example.invalid',ref,strong()));assert.deepEqual([blocked.status,code(blocked)],[429,'RATE_LIMITED'],'3/h por e-mail preservado');
}));

test('idempotência: chave obrigatória, replay estável sem duplicar, senha/mentora diferentes → 409, nenhuma senha crua no hash canônico',async()=>withDb(async({db})=>{
 await crossingMentors(db);const choices=await refs();const pw=strong();
 const body=signup('Chave@Example.invalid',choices[0].mentor_ref,pw);
 for(const key of [null,'nao-uuid']){const r=await send(body,key);assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);assert.ok(r.json.error.fields.includes('Idempotency-Key'));}
 const key=randomUUID();
 const first=await send(body,key),second=await send(body,key.toUpperCase());
 assert.deepEqual([first.status,second.status,second.json.data],[202,202,NEUTRAL]);
 const counts=async()=>(await db.query("select (select count(*)::int from app_user where email_key<>'chefe@example.invalid') u,(select count(*)::int from participant) p,(select count(*)::int from match) m")).rows[0];
 assert.deepEqual(await counts(),{u:1,p:1,m:1});
 const storedHash=(await db.query('select password_hash from app_user')).rows[0].password_hash;
 assert.deepEqual([(await send({...body,password:pw+'x',passwordConfirmation:pw+'x'},key)).status,(await send({...body,mentor_ref:choices[1].mentor_ref},key)).status],[409,409]);
 assert.equal((await db.query('select password_hash from app_user')).rows[0].password_hash,storedHash,'replay não recalcula nem troca a senha');
 const rows=(await db.query('select actor_key,key_hash,request_hash,path,status_code from api_idempotency')).rows;
 assert.equal(rows.length,1);assert.deepEqual([rows[0].path,rows[0].status_code],[REG,202]);
 const {passwordConfirmation:_c,...withoutConfirmation}=body;
 for(const raw of [body,withoutConfirmation,{...body,email:body.email.trim()}])assert.notEqual(rows[0].request_hash,canonicalHash(raw),'hash canônico nunca usa a senha crua');
 const dump=JSON.stringify(rows).toLowerCase();for(const secret of [pw.toLowerCase(),'chave@example.invalid',key])assert.equal(dump.includes(secret),false);
 assert.deepEqual(await counts(),{u:1,p:1,m:1});
 // concorrência: mesmo e-mail, chaves diferentes → uma única conta
 const race=await Promise.all(Array.from({length:4},()=>send(signup('corrida@example.invalid',choices[0].mentor_ref,strong()))));
 assert.deepEqual(race.map(r=>r.status),[202,202,202,202]);
 assert.equal((await db.query("select count(*)::int n from app_user where email_key='corrida@example.invalid'")).rows[0].n,1);
 assert.equal((await db.query("select count(*)::int n from match x join participant p on p.id=x.participant_id where lower(p.email)='corrida@example.invalid'")).rows[0].n,1);
},{RATE_EMAIL_PER_HOUR:'100',RATE_IP_PER_HOUR:'100'}));

test('fronteira SQL: assinatura antiga removida; cadastro/preview SECURITY DEFINER do owner NOLOGIN; helpers sem EXECUTE do runtime',async()=>withDb(async({db,url})=>{
 assert.equal((await db.query("select to_regprocedure('internal.register_participant_account(text,text,text,jsonb,jsonb,text)') r")).rows[0].r,null);
 const fns=(await db.query(`select p.proname,pg_get_userbyid(p.proowner)::text owner,p.prosecdef,p.proconfig::text cfg,has_function_privilege('techwoman_runtime',p.oid,'EXECUTE') rt,
  has_function_privilege('techwoman_mailer',p.oid,'EXECUTE') ml,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.privilege_type='EXECUTE' and a.grantee=0) pub
  from pg_proc p where p.pronamespace='internal'::regnamespace and p.proname in ('register_participant_account','registration_preview','registration_candidates','registration_profile_check','agenda_ranking_values') order by 1`)).rows;
 assert.deepEqual(fns.map(f=>[f.proname,f.owner,f.rt,f.ml,f.pub]),[['agenda_ranking_values','techwoman_owner',false,false,false],['register_participant_account','techwoman_owner',true,false,false],
  ['registration_candidates','techwoman_owner',false,false,false],['registration_preview','techwoman_owner',true,false,false],['registration_profile_check','techwoman_owner',false,false,false]]);
 for(const f of fns){assert.match(f.cfg,/search_path=pg_catalog, pg_temp/);if(f.rt)assert.equal(f.prosecdef,true,f.proname);}
 const runtime=new (await import('pg')).Client({connectionString:roleUrl(url,'techwoman_runtime')});await runtime.connect();
 try{for(const q of ["select internal.agenda_ranking_values('growth','[]','[]','dados',1)","select * from internal.registration_candidates('growth','[]','[]','dados')","insert into match(participant_id,mentor_id,score,reasons,status,origin) values(1,1,0,'[]','suggested','current')"])
  await assert.rejects(runtime.query(q),(e:{code?:string})=>e.code==='42501',q);}finally{await runtime.end();}
}));
