/**
 * D-048 (CAND-DEPS-RO): techwoman_beatriz (editora/pgAdmin) é SOMENTE LEITURA, versionado no repo e não só no host.
 * Banco novo (bootstrap → agenda-privileges.sql → migrations pela migradora LOGIN não superusuária) e host já revogado à mão
 * (estado anterior + REVOKE manual + setting) chegam ao MESMO catálogo: nenhum privilégio de escrita em tabela, view, coluna,
 * sequence ou default ACL (qualquer grantor); SELECT por coluna, USAGE de schema e EXECUTE do helper de visibilidade ficam;
 * policies agenda_editor FOR SELECT com o mesmo USING; default_transaction_read_only=on IN DATABASE. A sessão LOGIN real nasce
 * read-only (25006) e, mesmo com BEGIN READ WRITE, toda escrita é negada por privilégio (42501); SET ROLE não carrega o setting
 * (por isso o privilégio é a barreira). Reaplicar scripts e migration é idempotente e nunca amplia grants.
 * Roles são globais do cluster de teste sintético: criadas/restauradas aqui; senhas aleatórias nunca impressas.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Client,Pool} from 'pg';
import {migrate} from '../../scripts/migration/migrate';

const base=process.env.MIGRATION_DATABASE_URL;
const EDITOR='techwoman_beatriz';
const READ_ONLY_FIRST='20261026140000';
const LOGIN_ROLES=['techwoman_migrator','techwoman_runtime','techwoman_mailer','techwoman_beatriz'] as const;
const AGENDA_TABLES=['topic','mentor_topic','cohort','enrollment','mentor','participant'];
const SEQUENCES=['public.topic_id_seq','public.mentor_topic_id_seq','public.cohort_id_seq','public.enrollment_id_seq'];
const settled=async(control:Pool,name:string)=>{for(let i=0;i<80;i++){if(!(await control.query('select 1 from pg_stat_activity where datname=$1',[name])).rowCount)return;await new Promise(r=>setTimeout(r,50));}};
const urlFor=(db:string,user?:string,password?:string)=>{const u=new URL(String(base));u.pathname='/'+db;if(user){u.username=user;u.password=password??'';}return u.toString();};
const redact=(text:string,secrets:string[])=>secrets.reduce((t,s)=>t.split(s).join('<redacted>'),text);
function psql(url:string,file:string,env:Record<string,string>={}){
 const r=spawnSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-f',file,url],{encoding:'utf8',env:{...process.env,...env}});
 return {status:r.status,out:`${r.stdout??''}\n${r.stderr??''}`};
}
const fails=async(p:Promise<unknown>,code:string,label:string)=>assert.rejects(p,(e:{code?:string;message?:string})=>{assert.equal(e.code,code,`${label}: SQLSTATE esperado ${code}, obtido ${e.code}: ${e.message}`);return true;});

/** Todo privilégio de ESCRITA da editora, por catálogo (ACL explícita de qualquer grantor) e efetivo (has_*_privilege). Vazio = somente leitura. */
const WRITE_CATALOG=`
with ns as (select oid from pg_namespace where nspname in ('public','internal','legacy_snapshot')), ed as (select oid from pg_roles where rolname='techwoman_beatriz')
select 'acl tabela/view/sequence' k, c.oid::regclass::text||' '||a.privilege_type||' por '||pg_get_userbyid(a.grantor) x
 from pg_class c, aclexplode(c.relacl) a where c.relnamespace in (select oid from ns) and a.grantee=(select oid from ed) and not (c.relkind<>'S' and a.privilege_type='SELECT')
union all
select 'acl coluna', c.oid::regclass::text||'.'||t.attname||' '||a.privilege_type||' por '||pg_get_userbyid(a.grantor)
 from pg_attribute t join pg_class c on c.oid=t.attrelid, aclexplode(t.attacl) a where c.relnamespace in (select oid from ns) and a.grantee=(select oid from ed) and a.privilege_type<>'SELECT'
union all
select 'efetivo tabela/view', c.oid::regclass::text||' '||p from pg_class c cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
 where c.relnamespace in (select oid from ns) and c.relkind in ('r','v','p','m','f') and has_table_privilege('techwoman_beatriz',c.oid,p)
union all
select 'efetivo coluna', c.oid::regclass::text||' '||p from pg_class c cross join unnest(array['INSERT','UPDATE','REFERENCES']) p
 where c.relnamespace in (select oid from ns) and c.relkind in ('r','v','p','m','f') and has_any_column_privilege('techwoman_beatriz',c.oid,p)
union all
select 'efetivo sequence', c.oid::regclass::text||' '||p from pg_class c cross join unnest(array['USAGE','UPDATE','SELECT']) p
 where c.relnamespace in (select oid from ns) and c.relkind='S' and has_sequence_privilege('techwoman_beatriz',c.oid,p)
union all
select 'default acl', coalesce(d.defaclnamespace::regnamespace::text,'*')||' '||d.defaclobjtype::text||' '||a.privilege_type
 from pg_default_acl d, aclexplode(d.defaclacl) a where a.grantee=(select oid from ed)
order by 1,2`;
/** Leitura que precisa continuar: SELECT por tabela/coluna, USAGE de schema, EXECUTE do helper de visibilidade. */
const READ_CATALOG=`
with rel as (select c.oid from pg_class c where c.relnamespace in ('public'::regnamespace,'internal'::regnamespace,'legacy_snapshot'::regnamespace) and c.relkind in ('r','v','p','m','f'))
select oid::regclass::text obj from rel where has_table_privilege('techwoman_beatriz',oid,'SELECT')
union all select t.attrelid::regclass::text||'.'||t.attname from pg_attribute t join rel on rel.oid=t.attrelid
 where t.attnum>0 and not t.attisdropped and has_column_privilege('techwoman_beatriz',t.attrelid,t.attnum,'SELECT') and not has_table_privilege('techwoman_beatriz',t.attrelid,'SELECT')
union all select 'schema '||n from unnest(array['public','internal']) n where has_schema_privilege('techwoman_beatriz',n,'USAGE')
union all select 'execute '||p.oid::regprocedure::text from pg_proc p where p.pronamespace in ('public'::regnamespace,'internal'::regnamespace) and has_function_privilege('techwoman_beatriz',p.oid,'EXECUTE')
order by 1`;
const POLICIES=`select c.relname t,p.polname,p.polcmd,p.polpermissive,pg_get_expr(p.polqual,p.polrelid) using_expr,pg_get_expr(p.polwithcheck,p.polrelid) check_expr
 from pg_policy p join pg_class c on c.oid=p.polrelid where 'techwoman_beatriz'::regrole=any(p.polroles) order by 1,2`;
const SETTING=`select coalesce((select s.setconfig from pg_db_role_setting s where s.setrole='techwoman_beatriz'::regrole
 and s.setdatabase=(select oid from pg_database where datname=current_database())),'{}') cfg`;
/** Leitura preservada (lista do WP-003): tabela inteira na agenda/views, perfil só por coluna, helper booleano. */
const EXPECTED_READ=['execute internal.agenda_editor_visible(text,bigint)','mentor.active','mentor.availability','mentor.capacity','mentor.created_at','mentor.demo','mentor.display_name','mentor.id',
 'mentor.specialties','mentor.trajectory','mentor.updated_at','mentor.version','mentor_editor','mentor_topic','participant.active','participant.area','participant.created_at','participant.goal',
 'participant.id','participant.interests','participant.moment','participant.skills','participant.updated_at','participant.version','participant_editor','schema internal','schema public','cohort','enrollment','topic'].sort();

type World={control:Pool;admin:Pool;name:string;secrets:Record<string,string>;editorPassword:string;migratorUrl:string;cleanup:()=>Promise<void>};
/** Base nova construída como produção: bootstrap + script do operador (admin), migrations pela migradora LOGIN não superusuária. */
async function world(opts:{migrations?:(files:string[])=>string[]}={}):Promise<World>{
 assert.ok(base,'MIGRATION_DATABASE_URL de PG16 sintético');
 const control=new Pool({connectionString:base});const name='tw_ro_'+randomUUID().replace(/-/g,'');
 const prior=(await control.query('select rolname,rolcanlogin,rolpassword is not null has_password from pg_authid where rolname=any($1)',[LOGIN_ROLES])).rows as {rolname:string;rolcanlogin:boolean;has_password:boolean}[];
 const secrets={MIGRATOR_PASSWORD:randomBytes(18).toString('hex'),RUNTIME_PASSWORD:randomBytes(18).toString('hex'),MAILER_PASSWORD:randomBytes(18).toString('hex')};
 const editorPassword=randomBytes(18).toString('hex');
 await control.query(`create database ${name}`);
 const admin=new Pool({connectionString:urlFor(name),max:4});
 const cwd=process.cwd();let tree:string|undefined;
 const cleanup=async()=>{
  process.chdir(cwd);if(tree)rmSync(tree,{recursive:true,force:true});
  await admin.end();await settled(control,name);await control.query(`drop database if exists ${name} with (force)`);
  for(const role of LOGIN_ROLES){
   const p=prior.find(x=>x.rolname===role);
   if(!p)await control.query(`drop role if exists ${role}`).catch(()=>undefined);
   else await control.query(`alter role ${role} ${p.rolcanlogin?'LOGIN':'NOLOGIN'}${p.has_password?'':' PASSWORD NULL'}`);
  }
  await control.end();
 };
 try{
  for(const file of ['scripts/migration/bootstrap-local.sql','scripts/migration/agenda-privileges.sql']){
   const r=psql(urlFor(name),file,secrets);assert.equal(r.status,0,`${file}: ${redact(r.out,Object.values(secrets))}`);
  }
  const migratorUrl=urlFor(name,'techwoman_migrator',secrets.MIGRATOR_PASSWORD);
  if(opts.migrations){
   const all=readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort();
   mkdirSync(resolve('data/beatriz-ro'),{recursive:true});tree=mkdtempSync(resolve('data/beatriz-ro/old-'));
   mkdirSync(join(tree,'drizzle'));mkdirSync(join(tree,'scripts/migration'),{recursive:true});
   for(const f of opts.migrations(all))symlinkSync(resolve('drizzle',f),join(tree,'drizzle',f));
   symlinkSync(resolve('scripts/migration/grants-local.sql'),join(tree,'scripts/migration/grants-local.sql'));
   process.chdir(tree);try{await migrate(migratorUrl);}finally{process.chdir(cwd);}
  }else await migrate(migratorUrl);
  return {control,admin,name,secrets,editorPassword,migratorUrl,cleanup};
 }catch(error){await cleanup();throw error;}
}
const rows=async(db:Pool,sql:string)=>(await db.query(sql)).rows;
const writeCatalog=async(db:Pool)=>(await rows(db,WRITE_CATALOG)).map(r=>`${r.k}: ${r.x}`);
const readCatalog=async(db:Pool)=>(await rows(db,READ_CATALOG)).map(r=>String(r.obj).replace(/^public\./,'')).sort();
/** Contrato explícito do card, além da varredura pg_catalog (mais abrangente). */
const informationSchemaWrites=(db:Pool)=>rows(db,`
 select table_schema,table_name,privilege_type from information_schema.role_table_grants
 where grantee='techwoman_beatriz' and table_schema in ('public','internal')
   and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
 union all
 select table_schema,table_name||'.'||column_name,privilege_type from information_schema.column_privileges
 where grantee='techwoman_beatriz' and table_schema in ('public','internal')
   and privilege_type in ('INSERT','UPDATE','REFERENCES')
 order by 1,2,3`);

test('D-048 information_schema: banco anterior expõe grants de escrita; migrar para somente leitura zera role_table_grants e column_privileges',async()=>{
 const w=await world({migrations:all=>all.filter(f=>f<READ_ONLY_FIRST)});
 try{
  assert.ok((await informationSchemaWrites(w.admin)).length>0,'regressão sensível: o banco anterior concedia escrita');
  await migrate(w.migratorUrl);
  assert.deepEqual(await informationSchemaWrites(w.admin),[],'zero grants de escrita em information_schema após upgrade');
 }finally{await w.cleanup();}
});
/** Fixtures sintéticas gravadas pelo dono/migradora (nunca pela editora): uma mentora, tema, turma e reserva visíveis. */
async function fixtures(db:Pool){
 const tag=randomBytes(4).toString('hex');
 const user=(await db.query("insert into app_user(id,email,status) values(gen_random_uuid(),$1,'active') returning id",[`ro-p-${tag}@example.invalid`])).rows[0].id;
 const participant=(await db.query("insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version,user_id) values($1,'growth','working','[\"dados\"]','[\"codigo\"]','dados',$2,'v1',$3) returning id::text",
  [`ro-p-${tag}@example.invalid`,randomBytes(32).toString('hex'),user])).rows[0].id as string;
 const mentor=(await db.query("insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name) values($1,'t','[\"dados\"]','a',2,true,'Mentora') returning id::text",[`ro-m-${tag}@example.invalid`])).rows[0].id as string;
 const topic=(await db.query("insert into topic(slug,name) values($1,'Tema') returning id::text",['ro-'+tag])).rows[0].id as string;
 const mentorTopic=(await db.query('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1) returning id::text',[mentor,topic])).rows[0].id as string;
 const cohort=(await db.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,now()+interval '400 days',now()+interval '400 days 1 hour',3,'open') returning id::text",[mentorTopic])).rows[0].id as string;
 const enrollment=(await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text",[participant,cohort])).rows[0].id as string;
 return {tag,participant,mentor,topic,mentorTopic,cohort,enrollment};
}
type Fx=Awaited<ReturnType<typeof fixtures>>;
/** Toda forma de escrita da editora na agenda/perfis/views/sequences (o que o WP-003 concedia e o que nunca concedeu). */
const writes=(f:Fx):[string,unknown[]][]=>[
 ["insert into topic(slug,name,description) values($1,'Editora','d')",['ro-editora-'+f.tag]],["update topic set name='E2' where id=$1",[f.topic]],['delete from topic where id=$1',[f.topic]],
 ['insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,2)',[f.mentor,f.topic]],['update mentor_topic set position=2 where id=$1',[f.mentorTopic]],['delete from mentor_topic where id=$1',[f.mentorTopic]],
 ["insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,now()+interval '402 days',now()+interval '402 days 1 hour',2,'draft')",[f.mentorTopic]],
 ['update cohort set capacity=4 where id=$1',[f.cohort]],["update cohort set status='closed' where id=$1",[f.cohort]],['delete from cohort where id=$1',[f.cohort]],
 ["insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[f.participant,f.cohort]],["update enrollment set status='cancelled' where id=$1",[f.enrollment]],['delete from enrollment where id=$1',[f.enrollment]],
 ["update participant set goal='leadership' where id=$1",[f.participant]],["update participant_editor set goal='leadership' where id=$1",[f.participant]],
 ["update mentor set trajectory='x' where id=$1",[f.mentor]],["update mentor_editor set display_name='Nova' where id=$1",[f.mentor]],
 ...SEQUENCES.map(s=>[`select nextval('${s}')`,[]] as [string,unknown[]]),
];
const agendaState=async(db:Pool)=>(await db.query(`select string_agg(x,'|' order by x) s from (${AGENDA_TABLES.map(t=>`select '${t}:'||to_jsonb(r)::text x from public.${t} r`).join(' union all ')}) a`)).rows[0].s as string;

test('D-048 banco novo: catálogo da editora sem escrita (tabela/view/coluna/sequence/default ACL), leitura preservada, policies FOR SELECT e read-only IN DATABASE',async()=>{
 const w=await world();
 try{
  assert.deepEqual(await writeCatalog(w.admin),[],'nenhum privilégio de escrita da editora (catálogo e efetivo)');
  assert.deepEqual(await informationSchemaWrites(w.admin),[],'banco novo: information_schema.role_table_grants e column_privileges sem escrita');
  assert.deepEqual(await readCatalog(w.admin),EXPECTED_READ,'leitura do WP-003 preservada: agenda/views inteiras, perfil por coluna, helper de visibilidade');
  const policies=await rows(w.admin,POLICIES);
  assert.deepEqual(policies.map(p=>[p.t,p.polname,p.polcmd,p.polpermissive,p.check_expr]),AGENDA_TABLES.slice().sort().map(t=>[t,'agenda_editor','r',true,null]),'policies agenda_editor só FOR SELECT, sem WITH CHECK');
  assert.deepEqual(Object.fromEntries(policies.map(p=>[p.t,p.using_expr])),{
   topic:'true',participant:"internal.agenda_editor_visible('participant'::text, id)",mentor:"internal.agenda_editor_visible('mentor'::text, id)",
   mentor_topic:"internal.agenda_editor_visible('mentor'::text, mentor_id)",cohort:"internal.agenda_editor_visible('mentor_topic'::text, mentor_topic_id)",
   enrollment:"(internal.agenda_editor_visible('participant'::text, participant_id) AND internal.agenda_editor_visible('cohort'::text, cohort_id))"},'mesmo USING do WP-003');
  assert.ok(((await rows(w.admin,SETTING))[0].cfg as string[]).includes('default_transaction_read_only=on'),'default_transaction_read_only=on para a editora nesta base');
 }finally{await w.cleanup();}
});

test('D-048 sessão LOGIN real da editora: nasce read-only (25006); BEGIN READ WRITE ainda nega toda escrita por privilégio (42501); leitura funciona; SET ROLE não carrega o setting',async()=>{
 const w=await world();const clients:Client[]=[];
 try{
  const f=await fixtures(w.admin);const before=await agendaState(w.admin);
  await w.control.query(`alter role ${EDITOR} login password '${w.editorPassword}'`);
  const editor=new Client({connectionString:urlFor(w.name,EDITOR,w.editorPassword)});await editor.connect();clients.push(editor);
  assert.deepEqual([(await editor.query('show default_transaction_read_only')).rows[0].default_transaction_read_only,(await editor.query('show transaction_read_only')).rows[0].transaction_read_only],['on','on'],'conexão nova da editora nasce read-only');
  // leitura continua provada (agenda, views seguras, perfil por coluna), inclusive linhas gravadas pelo dono
  assert.deepEqual((await editor.query('select (select count(*)::int from topic) t,(select count(*)::int from mentor_topic) mt,(select count(*)::int from cohort) c,(select count(*)::int from enrollment) e')).rows[0],{t:1,mt:1,c:1,e:1});
  assert.equal((await editor.query('select id,goal,moment,interests,skills,area,active,version from participant_editor where id=$1',[f.participant])).rowCount,1);
  assert.equal((await editor.query('select id,display_name,trajectory,specialties,availability,capacity,active,demo,version from mentor_editor where id=$1',[f.mentor])).rowCount,1);
  assert.equal((await editor.query('select id,goal,active from participant where id=$1',[f.participant])).rowCount,1);
  // DML em tabela para no modo read-only da transação (25006); view (privilégio checado ao expandir a view) e nextval (privilégio antes do
  // modo read-only) já param no privilégio (42501)
  for(const [sql,args] of writes(f))await fails(editor.query(sql,args),/nextval\(|_editor /.test(sql)?'42501':'25006',`read-only: ${sql}`);
  // o setting é só a primeira camada: a editora pode desligá-lo, e mesmo assim o privilégio nega
  for(const [sql,args] of writes(f)){
   await editor.query('begin read write');
   try{await fails(editor.query(sql,args),'42501',`privilégio: ${sql}`);}finally{await editor.query('rollback');}
  }
  await editor.query('set default_transaction_read_only=off');
  for(const [sql,args] of writes(f))await fails(editor.query(sql,args),'42501',`privilégio sem read-only: ${sql}`);
  // SET ROLE (pgAdmin conectado por outra role) não aplica pg_db_role_setting: só o privilégio protege
  const viaSetRole=new Client({connectionString:urlFor(w.name)});await viaSetRole.connect();clients.push(viaSetRole);
  await viaSetRole.query(`set role ${EDITOR}`);
  assert.equal((await viaSetRole.query('show default_transaction_read_only')).rows[0].default_transaction_read_only,'off','SET ROLE não carrega o setting de login');
  for(const [sql,args] of writes(f))await fails(viaSetRole.query(sql,args),'42501',`SET ROLE: ${sql}`);
  assert.equal(await agendaState(w.admin),before,'nenhuma linha de agenda/perfil mudou');
 }finally{await Promise.all(clients.map(c=>c.end().catch(()=>undefined)));await w.cleanup();}
});

test('D-048 host já revogado à mão e reaplicação: upgrade pela migration chega ao catálogo do banco novo sem erro e sem ampliar grants; scripts e migration reaplicados são idempotentes',async()=>{
 const fresh=await world();let expected:{write:string[];read:string[];policies:Awaited<ReturnType<typeof rows>>};
 try{expected={write:await writeCatalog(fresh.admin),read:await readCatalog(fresh.admin),policies:await rows(fresh.admin,POLICIES)};}finally{await fresh.cleanup();}
 const w=await world({migrations:all=>all.filter(f=>f<READ_ONLY_FIRST)});
 try{
  const all=readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort();
  const added=all.filter(f=>f>=READ_ONLY_FIRST);
  assert.equal(added.length,1,`uma migration nova com carimbo ≥ ${READ_ONLY_FIRST} (*_beatriz_read_only.sql): ${added.join(',')}`);assert.match(added[0],/^\d{14}_beatriz_read_only\.sql$/);
  const before=await rows(w.admin,POLICIES);
  assert.ok((await writeCatalog(w.admin)).length>0,'estado anterior reproduzido: a editora ainda tinha escrita (WP-003)');
  // o que o operador fez no host (D-048): DML revogado em tabelas/views, USAGE das sequences e setting read-only
  await w.admin.query(`revoke insert, update, delete, truncate on all tables in schema public from ${EDITOR}`);
  await w.admin.query(`revoke usage on sequence ${SEQUENCES.join(', ')} from ${EDITOR}`);
  await w.admin.query(`alter role ${EDITOR} in database ${w.name} set default_transaction_read_only = on`);
  await migrate(w.migratorUrl);
  assert.deepEqual((await rows(w.admin,'select name from internal.schema_migration order by name')).map(r=>r.name),all,'migration nova aplicada pela migradora no host já revogado');
  assert.deepEqual(await writeCatalog(w.admin),expected.write,'mesmo catálogo de escrita do banco novo (vazio)');
  assert.deepEqual(await readCatalog(w.admin),expected.read,'leitura idêntica à do banco novo');
  const after=await rows(w.admin,POLICIES);
  assert.deepEqual(after,expected.policies,'policies idênticas às do banco novo');
  assert.deepEqual(after.map(p=>[p.t,p.using_expr]),before.map(p=>[p.t,p.using_expr]),'USING das policies preservado no upgrade');
  assert.ok(before.every(p=>p.polcmd==='*')&&after.every(p=>p.polcmd==='r'),'FOR ALL → FOR SELECT');
  // reaplicação: migrate (checksum) e o SQL da migration de novo, mais os scripts do operador; nada amplia grants nem falha
  await migrate(w.migratorUrl);
  const migrator=new Client({connectionString:w.migratorUrl});await migrator.connect();
  try{await migrator.query('begin');await migrator.query(readFileSync(resolve('drizzle',added[0]),'utf8'));await migrator.query('commit');}finally{await migrator.end();}
  for(const file of ['scripts/migration/agenda-privileges.sql','scripts/migration/bootstrap-local.sql','ops/sql/role-limits.sql']){
   const r=psql(urlFor(w.name),file,w.secrets);assert.equal(r.status,0,`${file}: ${redact(r.out,Object.values(w.secrets))}`);
  }
  assert.deepEqual(await writeCatalog(w.admin),expected.write,'reaplicar não amplia grants');
  assert.deepEqual(await readCatalog(w.admin),expected.read);assert.deepEqual(await rows(w.admin,POLICIES),expected.policies);
  const cfg=(await rows(w.admin,SETTING))[0].cfg as string[];
  assert.deepEqual(cfg.filter(c=>c.startsWith('default_transaction_read_only=')),['default_transaction_read_only=on'],'setting único e on depois de reaplicar');
 }finally{await w.cleanup();}
});

test('D-048 fail-closed: grant de escrita por coluna de OUTRO grantor (sobrevive ao REVOKE de tabela do dono) faz a migration abortar sem aplicar nada',async()=>{
 const w=await world({migrations:all=>all.filter(f=>f<READ_ONLY_FIRST)});
 try{
  // um grantor intermediário com GRANT OPTION concede INSERT por coluna: o REVOKE do dono não remove essa entrada
  await w.admin.query('create role tw_ro_grantor nologin');
  try{
   await w.admin.query('grant usage on schema public to tw_ro_grantor');await w.admin.query('grant insert (name) on public.topic to tw_ro_grantor with grant option');
   await w.admin.query(`set role tw_ro_grantor; grant insert (name) on public.topic to ${EDITOR}; reset role`);
   const applied=async()=>(await rows(w.admin,'select name from internal.schema_migration order by name')).map(r=>r.name);
   const before=await applied();
   await assert.rejects(migrate(w.migratorUrl),'migration recusa terminar com escrita remanescente da editora');
   assert.deepEqual(await applied(),before,'nada aplicado (transação única desfeita)');
   assert.ok((await writeCatalog(w.admin)).some(x=>x.includes('topic.name INSERT por tw_ro_grantor')),'o grant de outro grantor continua visível ao operador');
   await w.admin.query(`set role tw_ro_grantor; revoke insert (name) on public.topic from ${EDITOR}; reset role`);
   await migrate(w.migratorUrl);
   assert.deepEqual(await writeCatalog(w.admin),[],'removido o grant estranho, a migration aplica e o catálogo fica vazio');
  }finally{
   await w.admin.query('revoke all on public.topic from tw_ro_grantor cascade').catch(()=>undefined);await w.admin.query('revoke usage on schema public from tw_ro_grantor').catch(()=>undefined);
   await w.admin.query('drop role if exists tw_ro_grantor').catch(()=>undefined);
  }
 }finally{await w.cleanup();}
});
