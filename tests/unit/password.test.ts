import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,scryptSync} from 'node:crypto';
import {hashPassword,verifyPassword} from '../../src/lib/db';
import * as identity from '../../src/lib/identity';
import * as auth from '../../src/lib/auth';

process.env.SESSION_SECRET=randomBytes(48).toString('hex');
const legacy=(password:string,salt:string)=>`${salt}:${scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex')}`;

test('hash legado usa o salt hex como texto UTF-8, não os bytes decodificados',async()=>{
 const salt='00112233445566778899aabbccddeeff';const stored=legacy('synthetic legacy pass',salt);
 assert.equal(await verifyPassword('synthetic legacy pass',stored),true);
 assert.equal(await verifyPassword('synthetic legacy pasz',stored),false);
 const decoded=`${salt}:${scryptSync('synthetic legacy pass',Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex')}`;
 assert.equal(await verifyPassword('synthetic legacy pass',decoded),false);
});
test('formato inválido de hash é recusado sem exceção',async()=>{
 const good=legacy('x'.repeat(12),'aa'.repeat(16));
 for(const bad of ['', 'abc', good.toUpperCase(), good.slice(0,-2), good+'0', good.replace(':',';'), `${'aa'.repeat(15)}:${good.split(':')[1]}`]) assert.equal(await verifyPassword('x'.repeat(12),bad),false);
});
test('novas senhas usam saltHex:digestHex com salt de 16 bytes',async()=>{
 const stored=await hashPassword('another synthetic pass');assert.match(stored,/^[a-f0-9]{32}:[a-f0-9]{128}$/);
 assert.equal(await verifyPassword('another synthetic pass',stored),true);assert.notEqual(stored,await hashPassword('another synthetic pass'));
});
test('política de nova senha: 12..128 caracteres, sem trim',()=>{
 assert.equal(identity.validateNewPassword('a'.repeat(11)),false);
 assert.equal(identity.validateNewPassword('a'.repeat(12)),true);
 assert.equal(identity.validateNewPassword('a'.repeat(128)),true);
 assert.equal(identity.validateNewPassword('a'.repeat(129)),false);
 assert.equal(identity.validateNewPassword(' '.repeat(12)),true,'espaços contam, nada é aparado');
 assert.equal(identity.validateNewPassword('😀'.repeat(12)),true,'conta caracteres, não unidades UTF-16');
 assert.equal(identity.validateNewPassword(12345678901234),false);
 assert.equal(identity.validateNewPassword(undefined),false);
});
test('tokens opacos: 32 bytes base64url, formato validado',()=>{
 const t=identity.newSessionToken();assert.match(t,/^[A-Za-z0-9_-]{43}$/);assert.equal(Buffer.from(t,'base64url').length,32);
 assert.equal(identity.isSessionToken(t),true);assert.equal(identity.isSessionToken(t+'A'),false);assert.equal(identity.isSessionToken('x'),false);assert.equal(identity.isSessionToken(undefined),false);
 assert.notEqual(identity.newSessionToken(),t);
 assert.equal(Buffer.from(identity.generateTemporaryPassword(),'base64url').length,24);
 assert.equal(Buffer.from(identity.generateResetToken(),'base64url').length,32);
});
test('sameOrigin é estrito: Origin ausente ou divergente é rejeitado',()=>{
 process.env.APP_ORIGIN='https://app.example.invalid';
 const req=(headers:Record<string,string>)=>new Request('https://app.example.invalid/api/v1/x',{method:'POST',headers});
 assert.equal(auth.sameOrigin(req({})),false);
 assert.equal(auth.sameOrigin(req({origin:'https://evil.example.invalid'})),false);
 assert.equal(auth.sameOrigin(req({origin:'https://app.example.invalid'})),true);
 assert.equal(auth.sameOrigin(req({origin:'https://app.example.invalid','sec-fetch-site':'cross-site'})),false);
 assert.equal(auth.sameOrigin(req({origin:'https://app.example.invalid','sec-fetch-site':'same-origin'})),true);
});
test('CSRF é ligado à sessão e exigido por comparação em tempo constante',()=>{
 const a=identity.newSessionToken(),b=identity.newSessionToken();const token=auth.csrfToken(a);
 assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.equal(auth.csrfToken(a),token);assert.notEqual(auth.csrfToken(b),token);
 const req=(value?:string)=>new Request('https://app.example.invalid/x',{method:'POST',headers:value?{'x-csrf-token':value}:{}});
 assert.equal(auth.csrfValid(req(token),a),true);assert.equal(auth.csrfValid(req(),a),false);assert.equal(auth.csrfValid(req(token),b),false);assert.equal(auth.csrfValid(req('short'),a),false);
});
test('cookie tw_admin legado não autoriza; só tw_session revogável',()=>{
 const t=identity.newSessionToken();
 assert.equal(auth.sessionTokenFromCookieHeader(`tw_admin=${t}`),null);
 assert.equal(auth.sessionTokenFromCookieHeader(`x=1; tw_session=${t}; y=2`),t);
 assert.equal(auth.sessionTokenFromCookieHeader('tw_session=not-a-token'),null);
 if(typeof (auth as Record<string,unknown>).makeSession==='function') assert.throws(()=>(auth as unknown as {makeSession:(e:string)=>string}).makeSession('a@example.invalid'),'sem sessão stateless');
});
