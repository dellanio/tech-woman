import { currentAdmin, unauthorized } from '@/lib/auth';
import { adminOverview } from '@/lib/service';
export const runtime = 'nodejs';
export async function GET() { if (!await currentAdmin()) return unauthorized(); return Response.json(adminOverview(),{headers:{'Cache-Control':'no-store'}}); }
