import { handle, readJson, requireSession } from '@/lib/auth';
import { legacyJson } from '@/lib/agenda-http';
import { adminChange } from '@/lib/service';
export const runtime = 'nodejs';
/** cancel/activate/deactivate/remove-demo permitidos (soft, auditados); reassign sem turma → 422; protegido/inexistente 404 antes da ação. */
export const POST = handle(async (request: Request) => {
  const { token } = await requireSession(request, { mutation: true, roles: ['admin'] });
  return legacyJson(await adminChange(token, await readJson(request)));
});
