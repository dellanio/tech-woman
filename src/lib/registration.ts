import type { RegistrationReceived } from './contracts';

/** Stub RED: assinaturas neutras; a implementação real chega no commit GREEN. */
export class RegistrationClosedError extends Error { readonly code = 'REGISTRATION_CLOSED'; readonly status = 403; constructor() { super('Cadastro encerrado.'); } }
export async function registerParticipant(_input: unknown): Promise<RegistrationReceived> { return { status: 'received', next: 'check_email' }; }
export async function registerMentor(_input: unknown): Promise<RegistrationReceived> { return { status: 'received', next: 'check_email' }; }
