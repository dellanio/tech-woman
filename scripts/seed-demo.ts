import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb,closeDb,mentors,demoSeedState,eventContent,users,userRoles,hashPassword } from '../src/lib/db';
export async function seedDemo(){
 if(process.env.NODE_ENV==='production'&&process.env.LOCAL_SEED!=='1')throw new Error('Seed somente em ambiente local explícito.');
 const db=getDb();
 await db.transaction(async tx=>{
  await tx.execute((await import('drizzle-orm')).sql`select pg_advisory_xact_lock(741003)`);
  if(!(await tx.select().from(demoSeedState).where(eq(demoSeedState.id,1))).length){
   for(const [name,tag,trajectory] of [['Ana Exemplo (fictícia)','dados','Dados e análise de informação em projetos fictícios.'],['Bia Exemplo (fictícia)','desenvolvimento','Desenvolvimento em cenários de demonstração.'],['Clara Exemplo (fictícia)','produto','Produto digital em projetos fictícios.'],['Dani Exemplo (fictícia)','design','Design de experiências fictícias.']]){
    await tx.insert(mentors).values({email:`demo-${tag}@example.invalid`,demoName:name,trajectory,specialties:[tag],availability:'Disponibilidade ilustrativa, sem horário definido.',capacity:3,active:true,demo:true});
   }
   await tx.insert(demoSeedState).values({id:1});
  }
  await tx.insert(eventContent).values({id:1,description:'Um encontro presencial para compartilhar trajetórias, criar conexões e descobrir caminhos possíveis na tecnologia.',venue:'',agenda:'',speakers:'',date:'2026-11-14',duration:''}).onConflictDoNothing();
  if(process.env.ADMIN_EMAIL&&process.env.ADMIN_PASSWORD){
   if(process.env.ADMIN_PASSWORD.length<16||process.env.ADMIN_PASSWORD.startsWith('replace-'))throw new Error('Configure senha local exclusiva de pelo menos 16 caracteres.');
   const [user]=await tx.insert(users).values({id:randomUUID(),email:process.env.ADMIN_EMAIL,passwordHash:await hashPassword(process.env.ADMIN_PASSWORD),status:'active'}).onConflictDoNothing().returning({id:users.id});
   if(user)await tx.insert(userRoles).values({userId:user.id,role:'admin'});
  }
 });
}
if(process.argv[1]?.endsWith('seed-demo.ts'))seedDemo().then(()=>console.log('Seed local explícito concluído.')).catch(()=>{console.error('Falha no seed local.');process.exitCode=1;}).finally(closeDb);
