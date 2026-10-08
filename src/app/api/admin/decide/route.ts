import { currentAdmin, unauthorized } from '@/lib/auth';
import { decide, Invalid } from '@/lib/service';
export const runtime = 'nodejs';
export async function POST(request: Request) { if (!await currentAdmin()) return unauthorized(); try { const body: unknown = await request.json(); if (!body || typeof body !== 'object' || !('participantId' in body) || !('mentorId' in body) || !('action' in body)) throw new Invalid('Decisão inválida.'); return Response.json(decide(Number(body.participantId),Number(body.mentorId),String(body.action))); } catch(e) { return Response.json({error:e instanceof Invalid ? e.message : 'Não foi possível registrar a decisão.'},{status:e instanceof Invalid ? e.status : 400}); } }
