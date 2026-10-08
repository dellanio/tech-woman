import { authenticate } from '@/lib/service';
import { makeSession } from '@/lib/auth';
export const runtime = 'nodejs';
export async function POST(request: Request) {
 const input: unknown = await request.json().catch(() => null);
 if (!input || typeof input !== 'object' || !('email' in input) || !('password' in input) || typeof input.email !== 'string' || typeof input.password !== 'string') return Response.json({error:'Credenciais inválidas.'},{status:401});
 const user = authenticate(input.email,input.password);
 if (!user) return Response.json({error:'Credenciais inválidas.'},{status:401});
 const response = Response.json({email:user.email,role:user.role});
 response.headers.append('Set-Cookie',`tw_admin=${makeSession(user.email)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_HTTP !== '1' ? '; Secure' : ''}`);
 return response;
}
