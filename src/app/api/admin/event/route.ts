import { handle, readJson, requireSession } from '@/lib/auth';
import { legacyJson } from '@/lib/agenda-http';
import { getEvent } from '@/lib/event';
import { saveEventAs } from '@/lib/service';
export const runtime = 'nodejs';
/** Conteúdo textual do evento: leitura admin/team com sessão full; escrita só admin (Origin+CSRF, ator revalidado no banco, auditoria). */
export const GET = handle(async (request: Request) => { await requireSession(request, { roles: ['admin', 'team'] }); return legacyJson(await getEvent()); });
export const PUT = handle(async (request: Request) => {
  const { token } = await requireSession(request, { mutation: true, roles: ['admin'] });
  return legacyJson(await saveEventAs(token, await readJson(request)));
});
