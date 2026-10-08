import { createParticipant, Invalid } from '@/lib/service';
export const runtime = 'nodejs';
export async function POST(request: Request) { try { const input: unknown = await request.json(); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Invalid('Dados inválidos.'); return Response.json(createParticipant(input as Record<string,unknown>),{status:201}); } catch(e) { return Response.json({error:e instanceof Invalid ? e.message : 'Não foi possível concluir a inscrição.'},{status:e instanceof Invalid ? e.status : 400}); } }
