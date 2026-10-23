import { handle, requireSession } from '@/lib/auth';
import { legacyJson } from '@/lib/agenda-http';
import { adminOverview } from '@/lib/service';
export const runtime = 'nodejs';
/** Sessão full admin/team (team só lê); o banco revalida o ator e omite admins/vínculos protegidos. */
export const GET = handle(async (request: Request) => legacyJson(await adminOverview((await requireSession(request, { roles: ['admin', 'team'] })).token)));
