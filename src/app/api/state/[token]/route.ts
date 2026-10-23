import { stateFor } from '@/lib/service';
export const runtime = 'nodejs';
export async function GET(_request: Request, {params}: {params: Promise<{token:string}>}) { const data = await stateFor((await params).token); return data ? Response.json(data,{headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}}) : Response.json({error:'Link inválido.'},{status:404}); }
