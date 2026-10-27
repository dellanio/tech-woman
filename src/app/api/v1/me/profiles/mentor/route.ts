import { handle, HttpError, ok, readJson, requireSession } from '@/lib/auth';
import { addOwnProfile } from '@/lib/registration';
export const runtime = 'nodejs';
/** Anexa o perfil ao PRÓPRIO usuário (sessão full + CSRF). Admin/team → 404; duplicata → 409; legado por reconciliar → 409 sem ligar por e-mail. */
export const POST = handle(async request => {
  const { token } = await requireSession(request, { mutation: true });
  const outcome = await addOwnProfile(token, 'mentor', await readJson(request));
  if (outcome === 'created') return ok({ profile: 'mentor' }, 201);
  if (outcome === 'conflict') throw new HttpError('PROFILE_EXISTS');
  if (outcome === 'reconciliation') throw new HttpError('IDENTITY_RECONCILIATION_REQUIRED');
  throw new HttpError('NOT_FOUND');
});
