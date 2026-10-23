import { handle, requireSession } from '@/lib/auth';
import { decide, Invalid } from '@/lib/service';
export const runtime = 'nodejs';
export const POST=handle(async(request: Request)=>{ await requireSession(request,{mutation:true,roles:['admin']}); try { const body: unknown = await request.json(); if (!body || typeof body !== 'object' || !('participantId' in body) || !('mentorId' in body) || !('action' in body)) throw new Invalid('Decisão inválida.'); return Response.json(await decide(String(body.participantId),String(body.mentorId),String(body.action))); } catch(e) { return Response.json({error:e instanceof Invalid ? e.message : 'Não foi possível registrar a decisão.'},{status:e instanceof Invalid ? e.status : 400}); } });
