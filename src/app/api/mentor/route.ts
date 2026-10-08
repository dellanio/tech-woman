import { createMentor, Invalid } from '@/lib/service';
export const runtime = 'nodejs';
export async function POST(request: Request) { try { const input: unknown = await request.json(); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Invalid('Dados inválidos.'); return Response.json(createMentor(input as Record<string,unknown>),{status:201}); } catch(e) { return Response.json({error:e instanceof Invalid ? e.message : 'Não foi possível cadastrar mentora.'},{status:e instanceof Invalid ? e.status : 400}); } }
