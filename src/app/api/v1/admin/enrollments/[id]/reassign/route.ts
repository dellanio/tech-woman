import { reassignEnrollment } from '@/lib/agenda';
import { creation, resource } from '@/lib/agenda-http';
import { handleWith } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
/** POST {cohortId,confirm:true} (admin): cancela + cria nova reserva atomicamente; falha no destino mantém a anterior; Idempotency-Key. */
export const POST = handleWith<Params>(async (request, { id }) => {
  const { token, idem, body } = await creation(request);
  return resource(await reassignEnrollment(token, id, idem, body), 201);
});
