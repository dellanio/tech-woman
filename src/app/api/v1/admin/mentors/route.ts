import { createDomain, listDomain } from '@/lib/agenda';
import { collection, creation, listQuery, reader, resource } from '@/lib/agenda-http';
import { handle } from '@/lib/auth';
export const runtime = 'nodejs';
/** Coleção admin/team (team só lê); domínios protegidos (admin vinculado, e-mail de admin, candidato privilegiado) nunca aparecem. */
export const GET = handle(async request => collection(await listDomain(await reader(request), 'mentor', listQuery(request))));
/** POST (admin): DTO público de cadastro; conta pendente + papel + domínio + intenção de ativação numa transação; Idempotency-Key. */
export const POST = handle(async request => {
  const { token, idem, body } = await creation(request);
  return resource(await createDomain(token, 'mentor', idem, body), 201);
});
