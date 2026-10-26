/**
 * Regressão com PG16 real e E2E integral (requer pnpm build).
 * MIGRATION_DATABASE_URL=... pnpm exec tsx tests/pg/e2e-teardown-regression.ts
 * O proxy atrasa Terminate + FIN; não altera SQL nem respostas do servidor.
 * Pool.end() pode resolver antes do Client.end(): DROP FORCE então causa 57P01.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer,connect,type Socket} from 'node:net';
import {Pool} from 'pg';

async function main(){
 const base=process.env.MIGRATION_DATABASE_URL;assert.ok(base,'PG16 descartável obrigatório');
 const upstream=new URL(base);assert.ok(!upstream.searchParams.has('host'),'usar conexão TCP ao PG isolado');
 const control=new Pool({connectionString:base});
 const sockets=new Set<Socket>();const timers=new Set<ReturnType<typeof setTimeout>>();
 const proxyErrors:string[]=[];let delayedTerminates=0;
 const databases=async()=>(await control.query("select datname from pg_database where datname like 'tw_e2e_%' order by datname")).rows.map((r:{datname:string})=>r.datname);
 const before=await databases();
 const version=(await control.query('show server_version')).rows[0].server_version as string;
 assert.match(version,/^16\./);
 const proxy=createServer({allowHalfOpen:true},down=>{
  const up=connect({host:upstream.hostname,port:Number(upstream.port||5432),allowHalfOpen:true});
  for(const socket of [down,up]){
   sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
   socket.on('error',error=>{proxyErrors.push(error.message);down.destroy();up.destroy();});
  }
  let startup=true,buffer=Buffer.alloc(0),terminating=false;
  down.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   while(buffer.length>=(startup?4:5)){
    const length=startup?buffer.readInt32BE(0):1+buffer.readInt32BE(1);
    if(buffer.length<length)return;
    const frame=buffer.subarray(0,length);buffer=buffer.subarray(length);
    if(!startup&&frame[0]===0x58){
     assert.equal(length,5);delayedTerminates++;terminating=true;
     const timer=setTimeout(()=>{timers.delete(timer);up.end(frame);},500);timers.add(timer);
    }else up.write(frame);
    startup=false;
   }
  });
  down.on('end',()=>{if(!terminating)up.end();});
  up.on('data',chunk=>down.write(chunk));up.on('end',()=>down.end());
 });
 try{
  await new Promise<void>((ok,fail)=>{proxy.once('error',fail);proxy.listen(0,'127.0.0.1',ok);});
  const address=proxy.address();assert.ok(address&&typeof address==='object');
  const url=new URL(base);url.hostname='127.0.0.1';url.port=String(address.port);url.searchParams.set('sslmode','disable');
  const child=spawn(process.execPath,['--import','tsx','tests/pg/e2e-v1.ts'],{env:{...process.env,MIGRATION_DATABASE_URL:url.toString()},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',(c:Buffer)=>stdout+=c.toString());child.stderr.on('data',(c:Buffer)=>stderr+=c.toString());
  const timeout=setTimeout(()=>child.kill('SIGKILL'),120_000);
  const code=await new Promise<number|null>((ok,fail)=>{child.once('error',fail);child.once('exit',ok);}).finally(()=>clearTimeout(timeout));
  // Não reproduzir dumps do pg (podem conter credenciais sintéticas).
  const result={code,flowCompleted:stdout.includes('cadastro202→job→fake→login→troca→restart'),boundPoolError:stderr.includes('BoundPool'),administratorTermination:stderr.includes('57P01'),delayedTerminates,pg:version};
  console.log(JSON.stringify(result));
  assert.equal(code,0,'E2E deve encerrar sem BoundPool/57P01 com Terminate atrasado');
  assert.equal(result.flowCompleted,true);assert.equal(result.boundPoolError,false);assert.equal(result.administratorTermination,false);
  assert.ok(delayedTerminates>0,'proxy deve exercitar fechamento físico atrasado');
  assert.deepEqual(await databases(),before,'E2E deve remover seu banco');
  assert.deepEqual(proxyErrors,[],'proxy não pode fabricar sucesso por desconexão');
 }finally{
  for(const timer of timers)clearTimeout(timer);
  for(const socket of sockets)socket.destroy();
  await new Promise<void>(ok=>proxy.close(()=>ok()));await control.end();
 }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'regressão falhou');process.exitCode=1;});
