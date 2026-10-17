/** A phone answer authorizes exactly what the phone sent: no implied item or superseded answer it did not name [P6,B26,B29]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { relayClientFixture } from './relay-client-fixture.js';
import { preparePersonRequest } from '../src/person-request.js';
import { decodeBoardKey, seal } from '../src/seal.js';
import { ENGINE_VERSION } from '../src/machine.js';
const url = name => pathToFileURL(resolve(import.meta.dirname, '../src/' + name + '.js')).href;
for (const [label, extra, refusedCode] of [
  ['the genuine text-only answer executes', '', null],
  ['an added --implies is refused', ',implies:[TARGET]', 'PERSON_REQUEST_RECEIPT'],
  ['an added --supersedes is refused', ',supersedes:999', 'PERSON_REQUEST_RECEIPT'],
]) test(`[P6,B26,B29] a phone answer authorizes only what the phone sent: ${label}`, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const ask = await box.cli('shout', 'person', 'Which decision is approved?', '--decision');
  assert.equal(ask.code, 0, JSON.stringify(ask.document));
  assert.ok(Number.isSafeInteger(ask.document.id));
  const target = box.before.tables.item[0].item_id;
  const phone = await box.phoneSession();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const id = 'phone-answer-' + label.split(' ')[1].replace(/[^a-z-]/gu, '');
  const text = 'Only this answer text was approved on the phone';
  const intent = preparePersonRequest({verb:'answer', item:ask.document.id, args:{text}}, id);
  assert.equal(Object.hasOwn(intent.move.args, 'implies'), false);
  assert.equal(Object.hasOwn(intent.move.args, 'supersedes'), false);
  const sealed = await seal(decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim()), new TextEncoder().encode(JSON.stringify(intent)),
    {boardId:link.board, kind:'request', sequence:link.sequence+1});
  const posted = await fetch(box.origin+'/api/v1/boards/'+link.board+'/requests', {method:'POST',
    headers:{authorization:'Bearer '+phone.token,'content-type':'application/json','x-pullboard-engine':String(ENGINE_VERSION)},
    body:JSON.stringify({sequence:link.sequence+1,sealed:Buffer.from(sealed).toString('base64url')})});
  assert.equal(posted.status,200);
  assert.equal((await posted.json()).event.kind,'request');
  const result = await box.script(`
    const {syncRelay,relayRequestDevice,relayOperation}=await import(${JSON.stringify(url('relay'))});
    const {personRequestRecords,requestIntentDigest,requestStageText}=await import(${JSON.stringify(url('relay-requests'))});
    const store=await import(${JSON.stringify(url('board'))});
    const {loadConfig}=await import(${JSON.stringify(url('config'))});
    const {laneNames}=await import(${JSON.stringify(url('lanes'))});
    const root=process.cwd(), sink={isTTY:false,write(){}};
    const io={cwd:root,stdout:sink,stderr:sink,say(){},err(){},onEvent(){},skipPersonRequests:true};
    await syncRelay(root,io);
    const executor=await relayRequestDevice(root);
    const read=()=>{const b=store.openBoard(root+'/.git/pullboard/board.sqlite');try{return personRequestRecords(b).find(r=>r.id===${JSON.stringify(id)}&&!r.duplicateOf);}finally{store.closeBoard(b);}};
    const record=read();
    if(record?.status!=='waiting'||JSON.parse(record.received).sender.kind!=='person') throw new Error('actual phone intake missing');
    const lanes=laneNames(loadConfig(root));
    const tag={id:record.id,executor,digest:requestIntentDigest(record)};
    await relayOperation(root,'shout',[{from:'person',to:'coordinator',text:requestStageText(record,'claim'),lanes}],
      {...io,personRequest:{...tag,phase:'claim'},personRequestMoveId:'phone-answer-claim'});
    if(read().executor!==executor) throw new Error('actual executor claim missing');
    let refused=null,result=null;
    try{result=await relayOperation(root,'answerDecision',[${ask.document.id},{agentId:'coordinator',asPerson:true,channel:'view',text:${JSON.stringify(text)},lanes${extra.replace('TARGET', String(target))}}],
      {...io,personRequest:{...tag,phase:'execute'},personRequestMoveId:'phone-answer-execute'});}catch(error){refused=error.code;}
    const b=store.openBoard(root+'/.git/pullboard/board.sqlite');
    let personFacts;
    try{personFacts=b.db.prepare("SELECT event_detail FROM event WHERE event_kind='fact' AND event_by='person'").all();}finally{store.closeBoard(b);}
    process.stdout.write(JSON.stringify({refused,result,personFactCount:personFacts.length}));
  `);
  assert.equal(result.code,0, result.stderr);
  assert.equal(result.document.refused, refusedCode, `${label}: ${JSON.stringify(result.document)}`);
  if (refusedCode) assert.equal(result.document.personFactCount, 0, 'no person-authored implication the phone did not approve');
  else assert.ok(result.document.result, 'the genuine phone answer is fulfilled');
});
