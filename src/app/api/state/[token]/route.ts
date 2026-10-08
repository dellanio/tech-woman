import { stateFor } from '@/lib/service';
export const runtime = 'nodejs';
export async function GET(_request: Request, {params}: {params: Promise<{token:string}>}) { const data = stateFor((await params).token); return data ? Response.json(data) : Response.json({error:'Link inválido.'},{status:404}); }
