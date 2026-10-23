import {currentAdmin,adminCanWrite,sameOrigin,unauthorized} from '@/lib/auth';
import {adminChange,setMentorActive,removeDemoMentors,Invalid} from '@/lib/service';
export const runtime='nodejs';
export async function POST(request:Request){
 if(!sameOrigin(request))return Response.json({error:'Origem não autorizada.'},{status:403});
 if(!adminCanWrite(await currentAdmin()))return unauthorized();
 try {
  const body:unknown=await request.json();
  if(!body || typeof body!=='object' || !('action' in body))throw new Invalid('Ação inválida.');
  if(body.action==='remove-demo')return Response.json(await removeDemoMentors());
  if(body.action==='activate'||body.action==='deactivate'){
   if(!('mentorId' in body)||(typeof body.mentorId!=='number'&&typeof body.mentorId!=='string'))throw new Invalid('Mentora inválida.');
   return Response.json(await setMentorActive(body.mentorId,body.action==='activate'));
  }
  if(body.action!=='cancel'&&body.action!=='reassign')throw new Invalid('Ação inválida.');
  if(!('participantId' in body)||(typeof body.participantId!=='number'&&typeof body.participantId!=='string'))throw new Invalid('Participante inválida.');
  const mentorId='mentorId' in body && (typeof body.mentorId==='number'||typeof body.mentorId==='string')?body.mentorId:null;
  return Response.json(await adminChange(body.participantId,mentorId,body.action));
 }catch(error){return Response.json({error:error instanceof Invalid?error.message:'Falha ao alterar par.'},{status:error instanceof Invalid?error.status:400})}
}
