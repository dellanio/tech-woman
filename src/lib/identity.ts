// RED stub: assinaturas finais, sem comportamento. A implementação vem no commit GREEN.
export type IdentityRole='admin'|'team'|'mentor'|'participant';
export type IdentitySession={id:string;userId:string;email:string;roles:IdentityRole[];scope:'full'|'password_change';state:'authenticated'|'password_change_required';expiresAt:string};
export type IdentityErrorCode='AUTH_REQUIRED'|'INVALID_CREDENTIALS'|'INVALID_INPUT'|'INVALID_RESET';
export class IdentityError extends Error { constructor(public code:IdentityErrorCode){super(code);} }
export const validateNewPassword=(value:unknown):value is string=>false;
export const newSessionToken=()=>'';
export const isSessionToken=(value:unknown):value is string=>false;
export const generateTemporaryPassword=()=>'';
export const generateResetToken=()=>'';
export async function login(email:string,password:string):Promise<{state:'authenticated'|'password_change_required';token:string}|null>{ void email;void password;return null; }
export async function identitySession(token:unknown):Promise<IdentitySession|null>{ void token;return null; }
export async function changePassword(token:string,currentPassword:string,newPassword:string):Promise<{token:string}>{ void token;void currentPassword;void newPassword;throw new IdentityError('AUTH_REQUIRED'); }
export async function confirmPasswordReset(token:string,newPassword:string):Promise<void>{ void token;void newPassword;throw new IdentityError('INVALID_RESET'); }
export async function logout(token:string):Promise<void>{ void token; }
