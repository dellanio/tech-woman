/** CRUD administrativo de contas (WP-002 Task 3). RED: stubs sem comportamento. */
import type { UserDto, TemporaryPasswordQueued } from './contracts';

export type AccountOutcome = 'ok' | 'not_found' | 'auth_required' | 'forbidden' | 'version_mismatch' | 'email_unavailable' | 'conflict_active' | 'invalid' | 'idempotency_conflict';
export type AccountResult = { outcome: AccountOutcome; user?: UserDto; users?: UserDto[]; nextCursor?: string | null; job?: TemporaryPasswordQueued };

const stub = async (): Promise<AccountResult> => ({ outcome: 'not_found' });
export const listAccounts = async (_token: string, _query: { cursor?: string | null; limit?: number }): Promise<AccountResult> => stub();
export const getAccount = async (_token: string, _id: string): Promise<AccountResult> => stub();
export const updateAccount = async (_token: string, _id: string, _version: string, _patch: unknown, _requestId?: string): Promise<AccountResult> => stub();
export const disableAccount = async (_token: string, _id: string, _version: string, _requestId?: string): Promise<AccountResult> => stub();
export const resendTemporary = async (_token: string, _id: string, _key: string): Promise<AccountResult> => stub();
export const createAccount = async (_token: string, _key: string, _dto: unknown, _requestId?: string): Promise<AccountResult> => stub();
