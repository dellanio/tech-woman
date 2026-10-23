import { currentAdmin, unauthorized, handle, requireSession } from '@/lib/auth';
import { getEvent, saveEvent } from '@/lib/event';
export const runtime='nodejs';
export async function GET(){ if (!await currentAdmin()) return unauthorized(); return Response.json(await getEvent(),{headers:{'Cache-Control':'no-store'}}); }
export const PUT=handle(async(request:Request)=>{
  await requireSession(request,{mutation:true,roles:['admin']});
  try { return Response.json(await saveEvent(await request.json())); }
  catch(error){ return Response.json({error:error instanceof Error?error.message:'Falha ao salvar conteúdo.'},{status:400}); }
});
