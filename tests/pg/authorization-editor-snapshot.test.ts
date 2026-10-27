import assert from 'node:assert/strict';
import {test} from 'node:test';
import {withDb,addUser,addMentor,addParticipant,withClients,EDITOR,pidOf,waitLocked} from './agenda-harness';

test('editora RC: proteção R3 relida depois de esperar guard, se elevação comitou durante a espera',async()=>withDb(async({db,url})=>{
 for(const kind of ['mentor','participant'] as const){
  const user=await addUser(db,{roles:[kind]});
  const id=kind==='mentor'?await addMentor(db,{userId:user.id,email:user.email}):await addParticipant(db,{userId:user.id,email:user.email});
  await withClients(url,[undefined,EDITOR,undefined],async(locker,editor,elevator)=>{
   let pending:Promise<{rows:number|null;code:string|null}>|undefined;
   try{
    await locker.query('begin');await locker.query('update internal.agenda_guard set revision=revision+1 where id=1');
    // D-048: somente leitura — com o guard preso por outro, a escrita da editora é negada por privilégio na hora, sem esperar o lock
    await assert.rejects(editor.query(`update ${kind} set active=false where id=$1 returning id`,[id]),(e:{code?:string})=>e.code==='42501');
    // mesmo com uma concessão indevida de UPDATE (simulada e revogada abaixo), a policy agenda_editor FOR SELECT não deixa a espera mutar o alvo
    await db.query(`grant update (active) on public.${kind} to ${EDITOR}`);
    await editor.query('begin');const pid=await pidOf(editor);
    pending=editor.query(`update ${kind} set active=false where id=$1 returning id`,[id]).then(r=>({rows:r.rowCount,code:null}),(e:{code?:string})=>({rows:null,code:e.code??'unknown'}));
    await waitLocked(db,pid);
    await elevator.query('begin');await elevator.query('select id from app_user where id=$1 for update',[user.id]);
    await elevator.query("insert into user_role(user_id,role) values($1,'admin')",[user.id]);
    await elevator.query('update app_user set session_version=session_version+1 where id=$1',[user.id]);await elevator.query('commit');
    await locker.query('commit');const result=await pending;
    assert.ok(result.rows===0||result.code==='42501',`${kind}: SQL editora não pode mutar alvo protegido após espera; resultado ${JSON.stringify(result)}`);
   }finally{
    await locker.query('rollback');await editor.query('rollback');await elevator.query('rollback');if(pending)await pending;
    await db.query(`revoke update (active) on public.${kind} from ${EDITOR}`);
   }
   assert.equal((await db.query(`select active from ${kind} where id=$1`,[id])).rows[0].active,true,'sem mutação de domínio');
   assert.equal((await db.query("select has_any_column_privilege($1,$2,'UPDATE') u",[EDITOR,`public.${kind}`])).rows[0].u,false,'concessão simulada revogada');
  });
 }
}));
