import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, hashPassword, verifyPassword, tokenDigest } from './db';

export type IdentityRole='admin'|'team'|'mentor'|'participant';
export type IdentitySession={id:string;userId:string;email:string;roles:IdentityRole[];scope:'full'|'password_change';state:'authenticated'|'password_change_required';expiresAt:string};
export type IdentityErrorCode='AUTH_REQUIRED'|'INVALID_CREDENTIALS'|'INVALID_INPUT'|'INVALID_RESET';
export class IdentityError extends Error { constructor(public code:IdentityErrorCode){super(code);} }

const ROLES:readonly string[]=['admin','team','mentor','participant'];
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const rows=async(query:ReturnType<typeof sql>)=>(await getDb().execute(query)).rows as Record<string,unknown>[];
/** Sempre aplica scrypt, mesmo sem usuário, para não distinguir conta inexistente por tempo. */
let dummy:Promise<string>|undefined;
const dummyHash=()=>dummy??=hashPassword(randomBytes(16).toString('hex'));

export const validateNewPassword=(value:unknown):value is string=>typeof value==='string'&&[...value].length>=12&&[...value].length<=128;
export const newSessionToken=()=>randomBytes(32).toString('base64url');
export const isSessionToken=(value:unknown):value is string=>typeof value==='string'&&TOKEN.test(value);
export const generateTemporaryPassword=()=>randomBytes(24).toString('base64url');
export const generateResetToken=()=>randomBytes(32).toString('base64url');

export async function login(email:string,password:string):Promise<{state:'authenticated'|'password_change_required';token:string}|null>{
  if(typeof email!=='string'||typeof password!=='string'||password.length>1024||email.length>320) return null;
  const [candidate]=await rows(sql`select * from internal.identity_login_begin(${email})`);
  const stored=typeof candidate?.hash==='string'?candidate.hash:await dummyHash();
  const matches=await verifyPassword(password,stored);
  if(!candidate||!matches) return null;
  const token=newSessionToken();
  const [done]=await rows(sql`select internal.identity_login_finish(${String(candidate.user_id)}::uuid,${String(candidate.mode)},${String(candidate.generation)}::bigint,${tokenDigest(token)}) as state`);
  return done?.state==='authenticated'||done?.state==='password_change_required'?{state:done.state,token}:null;
}

export async function identitySession(token:unknown):Promise<IdentitySession|null>{
  if(!isSessionToken(token)) return null;
  const [row]=await rows(sql`select * from internal.identity_session_get(${tokenDigest(token)})`);
  if(!row||(row.scope!=='full'&&row.scope!=='password_change')) return null;
  const roles=Array.isArray(row.roles)?row.roles.filter((r):r is IdentityRole=>typeof r==='string'&&ROLES.includes(r)):[];
  const expires=row.expires_at instanceof Date?row.expires_at.toISOString():String(row.expires_at);
  return {id:String(row.id),userId:String(row.user_id),email:String(row.email),roles,scope:row.scope,state:row.scope==='full'?'authenticated':'password_change_required',expiresAt:expires};
}

export async function changePassword(token:string,currentPassword:string,newPassword:string):Promise<{token:string}>{
  if(!isSessionToken(token)) throw new IdentityError('AUTH_REQUIRED');
  const [row]=await rows(sql`select * from internal.identity_change_begin(${tokenDigest(token)})`);
  if(!row) throw new IdentityError('AUTH_REQUIRED');
  if(!validateNewPassword(newPassword)) throw new IdentityError('INVALID_INPUT');
  if(typeof currentPassword!=='string'||currentPassword.length>1024||typeof row.hash!=='string'||!await verifyPassword(currentPassword,row.hash)) throw new IdentityError('INVALID_CREDENTIALS');
  const next=newSessionToken();
  const [done]=await rows(sql`select internal.identity_change_finish(${tokenDigest(token)},${String(row.generation)}::bigint,${await hashPassword(newPassword)},${tokenDigest(next)}) as ok`);
  if(done?.ok!==true) throw new IdentityError('AUTH_REQUIRED');
  return {token:next};
}

export async function confirmPasswordReset(token:string,newPassword:string):Promise<void>{
  if(!validateNewPassword(newPassword)) throw new IdentityError('INVALID_INPUT');
  if(typeof token!=='string'||token.length<1||token.length>256) throw new IdentityError('INVALID_RESET');
  const [done]=await rows(sql`select internal.consume_reset_token(${tokenDigest(token)},${await hashPassword(newPassword)}) as ok`);
  if(done?.ok!==true) throw new IdentityError('INVALID_RESET');
}

export async function logout(token:string):Promise<void>{
  if(isSessionToken(token)) await getDb().execute(sql`select internal.identity_logout(${tokenDigest(token)})`);
}
