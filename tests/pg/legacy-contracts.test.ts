import {test} from 'node:test';
import assert from 'node:assert/strict';

test('v1: DTOs fechados e IDs bigint sem perda, instantes com offset obrigatório',async()=>{
 const {parseTopic,parseCohort,parseParticipantRegistration,parseMentorRegistration,parseLogin,parseEnrollment,apiSuccess,apiError}=await import('../../src/lib/contracts');
 assert.deepEqual(parseTopic({slug:'dados',name:'Dados'}),{slug:'dados',name:'Dados',description:''});
 assert.throws(()=>parseTopic({slug:'dados',name:'Dados',role:'admin'}));
 assert.throws(()=>parseCohort({startsAt:'2027-11-14T09:00',endsAt:'2027-11-14T10:00',capacity:20,status:'open'}));
 assert.equal(parseCohort({startsAt:'2027-11-14T09:00:00-03:00',endsAt:'2027-11-14T10:00:00-03:00',capacity:20,status:'open'}).startsAt,'2027-11-14T12:00:00.000Z');
 assert.throws(()=>parseCohort({startsAt:'2027-02-30T09:00:00Z',endsAt:'2027-03-04T10:00:00Z',capacity:20,status:'open'}));
 assert.throws(()=>parseCohort({startsAt:'2027-11-14T09:00:00Z',endsAt:'2027-11-14T08:00:00Z',capacity:21,status:'draft'}));
 assert.equal(parseEnrollment({cohortId:'9007199254740993'}).cohortId,'9007199254740993');
 assert.throws(()=>parseCohort({startsAt:'2027-11-14T24:00:00Z',endsAt:'2027-11-16T00:00:00Z',capacity:1,status:'open'}));
 assert.throws(()=>parseEnrollment({cohortId:9007199254740992}));
 assert.throws(()=>parseEnrollment({cohortId:'9223372036854775808'}));
 assert.throws(()=>parseEnrollment({cohortId:'1',participantId:'2'}));
 const participant={email:'test@example.invalid',goal:'growth',moment:'working',area:'dados',interests:['dados'],skills:['analise'],consent:true};
 assert.equal(parseParticipantRegistration(participant).email,participant.email);
 assert.throws(()=>parseParticipantRegistration({...participant,skills:['root']}));
 assert.throws(()=>parseParticipantRegistration({...participant,userId:'injected'}));
 assert.throws(()=>parseMentorRegistration({email:'test@example.invalid',displayName:'Mentora',trajectory:'texto',specialties:['dados'],availability:'texto',legacyCapacity:51,consent:true}));
 assert.throws(()=>parseLogin({email:'test@example.invalid',password:'test',roles:['admin']}));
 assert.deepEqual(Object.keys(apiSuccess({id:'1'})).sort(),['data','requestId']);
 assert.equal(apiError('INVALID_INPUT','Dados inválidos.').error.code,'INVALID_INPUT');
});
