import { handle, readJson, requireSession } from '@/lib/auth';
import { legacyJson } from '@/lib/agenda-http';
import { decide } from '@/lib/service';
export const runtime = 'nodejs';
/** Não é bypass: approve sem turma → 422 com instrução do fluxo v1; reject só sugestão current; protegido/inexistente 404 antes da ação. */
export const POST = handle(async (request: Request) => {
  const { token } = await requireSession(request, { mutation: true, roles: ['admin'] });
  return legacyJson(await decide(token, await readJson(request)));
});
