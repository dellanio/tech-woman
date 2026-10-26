import { cancelOwnEnrollment } from '@/lib/agenda';
import { writer } from '@/lib/agenda-http';
import { handleWith, ok } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
/** Cancela só a própria reserva (alheia → 404); repetir devolve o mesmo estado cancelado. */
export const DELETE = handleWith<Params>(async (request, { id }) => ok(await cancelOwnEnrollment(await writer(request), id)));
