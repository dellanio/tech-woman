import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as contract from '../../src/lib/contracts';

test('Agenda: PATCHs fechados preservam campos imutáveis e limites',()=>{
 assert.equal(typeof contract.parseTopicPatch,'function');
 assert.deepEqual(contract.parseTopicPatch({name:' Tema ',active:false}),{name:'Tema',active:false});
 for(const body of [{slug:'immutable'},{id:'1'},{},[],{active:'false'}])assert.throws(()=>contract.parseTopicPatch(body),contract.ContractError);
 assert.deepEqual(contract.parseMentorTopicPatch({position:2}),{position:2});
 for(const body of [{topicId:'2'},{position:3},{position:0}])assert.throws(()=>contract.parseMentorTopicPatch(body),contract.ContractError);
 assert.deepEqual(contract.parseCohortPatch({capacity:20,status:'closed'}),{capacity:20,status:'closed'});
 for(const body of [{capacity:21},{capacity:0},{mentorTopicId:'1'},{startsAt:'2026-11-14T09:00:00'},{status:'approved'}])assert.throws(()=>contract.parseCohortPatch(body),contract.ContractError);
 assert.deepEqual(contract.parseCohortPatch({startsAt:'2026-11-14T09:00:00-03:00'}),{startsAt:'2026-11-14T12:00:00.000Z'});
});

test('Agenda: reorder/reassign/matches não aceitam campos de privilégio ou score',()=>{
 assert.deepEqual(contract.parseReorder({firstId:'9007199254740993',secondId:'2'}),{firstId:'9007199254740993',secondId:'2'});
 assert.throws(()=>contract.parseReorder({firstId:'1',secondId:'1'}),contract.ContractError);
 assert.deepEqual(contract.parseReassign({cohortId:'3',confirm:true}),{cohortId:'3',confirm:true});
 assert.throws(()=>contract.parseReassign({cohortId:'3',confirm:false}),contract.ContractError);
 assert.deepEqual(contract.parseMatchCreate({participantId:'2',mentorId:'3'}),{participantId:'2',mentorId:'3'});
 assert.deepEqual(contract.parseMatchPatch({status:'rejected'}),{status:'rejected'});
 for(const body of [{status:'approved'},{status:'selected'},{score:999},{participantId:'2'}])assert.throws(()=>contract.parseMatchPatch(body),contract.ContractError);
});

test('Domínio: PATCH não altera identidade, consentimento, demo ou token',()=>{
 assert.deepEqual(contract.parseParticipantPatch({goal:'growth',skills:['analise'],active:false}),{goal:'growth',skills:['analise'],active:false});
 assert.deepEqual(contract.parseMentorPatch({legacyCapacity:50,displayName:' Mentora '}),{legacyCapacity:50,displayName:'Mentora'});
 for(const body of [{userId:'abc'},{email:'x@example.invalid'},{token:'x'},{consent:true},{interests:[]},{skills:['analise','analise']},{otherArea:'x'}])assert.throws(()=>contract.parseParticipantPatch(body),contract.ContractError);
 for(const body of [{demo:true},{email:'x@example.invalid'},{userId:'abc'},{legacyCapacity:51},{specialties:[]}])assert.throws(()=>contract.parseMentorPatch(body),contract.ContractError);
 assert.deepEqual(contract.parseParticipantPatch({area:'outra',otherArea:'Saúde'}),{area:'outra',otherArea:'Saúde'});
});

test('Agenda: cursor bigint opaco validado e limite1..100',()=>{
 const cursor=contract.encodeSqlCursor('9007199254740993');
 assert.deepEqual(contract.parseDomainListQuery({cursor,limit:100}),{after:'9007199254740993',limit:100});
 assert.deepEqual(contract.parseDomainListQuery({}),{after:null,limit:20});
 for(const query of [{cursor:'bad'},{limit:101},{limit:0},{cursor:contract.encodeCursor('not-an-id')}])assert.throws(()=>contract.parseDomainListQuery(query),contract.ContractError);
});
