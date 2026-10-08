import { currentAdmin, adminCanWrite, sameOrigin, unauthorized } from '@/lib/auth';
import { getEvent, saveEvent } from '@/lib/event';
export const runtime='nodejs';
export async function GET(){ if (!await currentAdmin()) return unauthorized(); return Response.json(getEvent(),{headers:{'Cache-Control':'no-store'}}); }
export async function PUT(request:Request){
  if (!sameOrigin(request)) return Response.json({error:'Origem não autorizada.'},{status:403});
  if (!adminCanWrite(await currentAdmin())) return unauthorized();
  try { return Response.json(saveEvent(await request.json())); }
  catch(error){ return Response.json({error:error instanceof Error?error.message:'Falha ao salvar conteúdo.'},{status:400}); }
}
