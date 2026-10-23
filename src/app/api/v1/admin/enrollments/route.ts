import { listAdminEnrollments } from '@/lib/agenda';
import { collection, listQuery, reader } from '@/lib/agenda-http';
import { handle } from '@/lib/auth';
export const runtime = 'nodejs';
/** Coleção admin/team; inscrições de participante ou mentora protegida nunca aparecem. Criação é só pela participante (POST /me/enrollments). */
export const GET = handle(async request => collection(await listAdminEnrollments(await reader(request), listQuery(request))));
