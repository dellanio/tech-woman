import { Invalid, publicSuggestions, reserve } from '@/lib/service';
import { confirmChoice } from '@/lib/email';
import { sameOrigin } from '@/lib/auth';
export const runtime='nodejs';
const failure=(error:unknown)=>Response.json({error:error instanceof Invalid?error.message:'Não foi possível concluir a escolha.'},{status:error instanceof Invalid?error.status:400});
export async function GET(_request:Request,{params}:{params:Promise<{token:string}>}) {
  try {return Response.json(await publicSuggestions((await params).token),{headers:{'Cache-Control':'no-store'}});} catch(error){return failure(error)}
}
export async function POST(request:Request,{params}:{params:Promise<{token:string}>}) {
  if (!sameOrigin(request)) return Response.json({error:'Origem não autorizada.'},{status:403});
  try {
    const input:unknown=await request.json();
    if (!input || typeof input!=='object' || !('mentorId' in input) || (typeof input.mentorId!=='number'&&typeof input.mentorId!=='string')) throw new Invalid('Mentora inválida.');
    const chosen=await reserve((await params).token,input.mentorId);
    const emailStatus=await confirmChoice(chosen.participantId,String(input.mentorId),chosen.participantEmail,chosen.protocol,chosen.mentorEmail);
    return Response.json({status:'Mentoria reservada',mentorEmail:chosen.mentorEmail,emailStatus});
  } catch(error){return failure(error)}
}
