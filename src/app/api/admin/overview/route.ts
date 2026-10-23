import { currentAdmin, unauthorized } from '@/lib/auth';
import { adminOverview } from '@/lib/service';
export const runtime = 'nodejs';
export async function GET() { const admin = await currentAdmin(); if (!admin || !['owner','member'].includes(admin.role)) return unauthorized(); return Response.json(await adminOverview(),{headers:{'Cache-Control':'no-store'}}); }
