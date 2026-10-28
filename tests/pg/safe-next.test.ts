/** Regressão AUTH-01: validar o destino retornado após a normalização WHATWG. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeNext,loginHref,passwordChangeHref} from '../../src/app/shared';

for(const raw of ['/..//host','/%2e%2e//host','/a/..//host','//host']){
 test(`safeNext recusa destino externo normalizado: ${raw}`,()=>{
  assert.equal(safeNext(raw),'/conta');
  assert.equal(safeNext(raw,'/inscricao'),'/inscricao');
  assert.equal(loginHref(raw),'/login');
  assert.equal(passwordChangeHref(raw),'/troca-senha');
 });
}

for(const raw of ['/conta?aba=reservas','/conta?aba=reservas#proximas','/inscricao','/admin','/a/../conta?aba=reservas#proximas']){
 test(`safeNext preserva destino interno: ${raw}`,()=>{
  const expected=new URL(raw,'http://destino.invalid');
  const path=expected.pathname+expected.search+expected.hash;
  assert.equal(safeNext(raw),path);
  assert.equal(new URL(loginHref(raw),'http://destino.invalid').searchParams.get('next'),path);
  assert.equal(new URL(passwordChangeHref(raw),'http://destino.invalid').searchParams.get('next'),path);
 });
}

test('safeNext mantém os guards existentes',()=>{
 const invalid:unknown[]=[undefined,null,42,{},'', 'conta','https://host','/\\host','/..//\\host','/conta\n','/conta\u007f','/'+ 'a'.repeat(512),'/api/v1/auth/session','/a/../api/v1/auth/session','/login','/troca-senha','/recuperar-senha','/redefinir-senha','/a/../login'];
 for(const raw of invalid)assert.equal(safeNext(raw),'/conta',JSON.stringify(raw));
 const maximum='/'+ 'a'.repeat(511);
 assert.equal(safeNext(maximum),maximum,'limite de 512 caracteres preservado');
});
