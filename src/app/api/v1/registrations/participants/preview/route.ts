import { enforceRate, handle, ok, previewRules, readJson, requireOrigin } from '@/lib/auth';
import { parseRegistrationPreview } from '@/lib/contracts';
import { previewCrossing } from '@/lib/crossing';
export const runtime = 'nodejs';
/** Crossing antes das credenciais: só `[{mentor_ref, nome_exibicao}]` das compatíveis, na ordem do ranking. Nada é gravado (só o balde de rate por IP). */
export const POST = handle(async request => {
  requireOrigin(request);
  const body = parseRegistrationPreview(await readJson(request));
  await enforceRate(previewRules(request));
  return ok(await previewCrossing(body));
});
