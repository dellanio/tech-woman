import { handle, ok, requireSession } from '@/lib/auth';
export const runtime = 'nodejs';
/** Introspecção pessoal. Sessão limitada devolve só o estado mínimo da troca de senha. */
export const GET = handle(async request => {
  const { session } = await requireSession(request, { full: false });
  return ok(session.scope === 'full'
    ? { user: { id: session.userId, email: session.email, roles: session.roles }, state: session.state, expiresAt: session.expiresAt }
    : { state: session.state, expiresAt: session.expiresAt });
});
