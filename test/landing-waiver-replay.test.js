/** Compare an actual released waiver receipt against two private current replicas [B3,R3,H16]. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import * as store from '../src/board.js';
import {exportBoard,importBoard} from '../src/exchange.js';
import {applyEngineMove,engineReceipt} from '../src/engine.js';
import {unpackRelease} from './release-archive.js';
/** Ignore only the current writer marker, never historical semantic rows or ordered receipts. */
function withoutWriterMarker(doc){const x=structuredClone(doc);x.tables.board_meta=x.tables.board_meta.filter(r=>r.meta_key!=='relay_engine_version');return x;}
test('an actual engine12 person waiver keeps its exact receipt and history on both replicas [B3,R3,H16]',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'pullboard-655-old-waiver-'));const archived=join(dir,'engine12');mkdirSync(archived);
 unpackRelease('59a6e2b286ee852add0d68a659f1a1e6b3257c44',archived);
 const oldStore=await import(pathToFileURL(join(archived,'src/board.js')));
 const oldEngine=await import(pathToFileURL(join(archived,'src/engine.js')));
 const oldExchange=await import(pathToFileURL(join(archived,'src/exchange.js')));
 const oldMachine=await import(pathToFileURL(join(archived,'src/machine.js')));assert.equal(oldMachine.ENGINE_VERSION,12);
 const old=oldStore.openBoard(join(dir,'old.sqlite'));const replicas=[store.openBoard(':memory:'),store.openBoard(':memory:')];
 t.after(()=>{for(const b of replicas)store.closeBoard(b);oldStore.closeBoard(old);rmSync(dir,{recursive:true,force:true});});
 oldStore.ensureCoordinator(old,'/fixture');const seed=oldExchange.exportBoard(old);for(const b of replicas)importBoard(b,seed);
 const move=oldEngine.prepareEngineMove(old,'recordLandingWaiver',[{agentId:'person',channel:'terminal',id:'legacy-waiver',test:'test/flaky.test.js',until:'2099-01-01T00:00:00.000Z',reason:'Synthetic private replay proof'}],{id:'old-person-waiver'});
 const order={sequence:1,at:'2026-10-17T20:00:00.000Z'};const original=oldEngine.applyEngineMove(old,move,order);assert.equal(original.error,undefined);
 const current=replicas.map(b=>applyEngineMove(b,move,order));assert.deepEqual(current[0],current[1],'current replicas agree');
 assert.deepEqual(exportBoard(replicas[0]),exportBoard(replicas[1]),'current ordered prefixes agree');
 assert.deepEqual(current[0],original,'the old move must retain its released receipt shape');
 for(const b of replicas){
  assert.deepEqual(engineReceipt(b,move.id),oldEngine.engineReceipt(old,move.id));
  assert.deepEqual(withoutWriterMarker(exportBoard(b)),withoutWriterMarker(oldExchange.exportBoard(old)));
  const before=exportBoard(b);
  assert.equal(store.landingWaiverFor(b,{file:'test/flaky.test.js',name:'unrelated behavior'}).kind,'file');
  assert.equal(store.landingWaiverFor(b,{file:'test/unrelated.test.js',name:'test/flaky.test.js'}),null,'a file waiver cannot cover a test merely named like its file');
  assert.deepEqual(exportBoard(b),before,'derived waiver classification never writes history');
  assert.deepEqual(applyEngineMove(b,move,order),original,'retrying the old move preserves its released receipt');
 }
});
