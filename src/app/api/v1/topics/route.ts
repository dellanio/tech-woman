import { createTopic, listTopics } from '@/lib/agenda';
import { collection, creation, listQuery, reader, resource } from '@/lib/agenda-http';
import { handle } from '@/lib/auth';
export const runtime = 'nodejs';
/** Catálogo de temas: perfis ativos leem (inativos só admin/team); cursor opaco por id. */
export const GET = handle(async request => collection(await listTopics(await reader(request), listQuery(request))));
/** Só admin; Idempotency-Key obrigatória; slug imutável depois de criado. */
export const POST = handle(async request => {
  const { token, idem, body } = await creation(request);
  return resource(await createTopic(token, idem, body), 201);
});
