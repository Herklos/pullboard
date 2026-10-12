/** Regression for a completed older shout preserving a newer person-answer draft [N26,H5,C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { machine, project, startView, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';
import { holdPriorShoutResponse } from './shout-response-barrier.mjs';

const PRIOR = 'Prior shout held while a newer answer is composed';
const QUESTION = 'Can the delayed shout clear a newer answer?';
const ANSWER = 'Newer answer survives the prior completion';

/** Wrap only the real act function and form events, retaining bounded, redacted evidence. */
async function armWitness(chrome) {
  const setup = "(() => {"
    + " const field=document.querySelector('#shout-text'), form=document.querySelector('#shout-form');"
    + " const desc=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');"
    + " if(!field||!form||!desc?.get||!desc?.set)return {armed:false};"
    + " const originalAct=act, ownValue=Object.getOwnPropertyDescriptor(field,'value'), events=[],observerErrors=[];let droppedEvents=0;"
    + " const note=(type,extra={})=>{try{if(events.length>=100){droppedEvents++;return;}events.push({type,wallAt:Date.now(),monotonicAt:performance.now(),"
    + " value:desc.get.call(field),answering:typeof view==='object'?(view.answering?.id??null):null,...extra});}catch(error){if(observerErrors.length<20)observerErrors.push({type,name:error?.name??null});}};"
    + " Object.defineProperty(field,'value',{configurable:true,get(){return desc.get.call(this);},set(value){"
    + " try{note('value-set',{before:desc.get.call(this),after:typeof value==='string'?value:null,stack:(new Error().stack||'').split('\\n').slice(1,5).map(line=>line.replace(/(?:https?|file):[^\\s)]+/g,'view.inline'))});}catch{}"
    + " return desc.set.call(this,value);}});"
    + " act=async function(command,args,anchor){const prior=command==='shout'&&args?.text===" + JSON.stringify(PRIOR) + ";"
    + " if(prior)note('prior-act-start');try{const result=await originalAct(command,args,anchor);if(prior)note('prior-act-return',{result:Boolean(result)});return result;}"
    + " catch(error){if(prior)note('prior-act-throw',{name:error?.name??null,message:String(error?.message??error)});throw error;}};"
    + " const onSubmit=e=>note('submit',{trusted:e.isTrusted});const onInvalid=e=>note('invalid',{targetId:e.target?.id??null,valid:e.target?.validity?.valid??null});"
    + " form.addEventListener('submit',onSubmit,true);form.addEventListener('invalid',onInvalid,true);"
    + " const cap={events,observerErrors,droppedEvents,finish(){form.removeEventListener('submit',onSubmit,true);form.removeEventListener('invalid',onInvalid,true);act=originalAct;"
    + " if(ownValue)Object.defineProperty(field,'value',ownValue);else delete field.value;note('capture-finished');delete window.__priorShoutWitness;"
    + " return {events:[...events],observerErrors:[...observerErrors],droppedEvents,complete:droppedEvents===0&&observerErrors.length===0};}};"
    + " window.__priorShoutWitness=cap;note('capture-armed');return {armed:true};})()";
  return JSON.parse(await chrome.stable('JSON.stringify(' + setup + ')'));
}

/** Remove the test observer and return its bounded event record. */
async function finishWitness(chrome) {
  return JSON.parse(await chrome.stable('JSON.stringify(window.__priorShoutWitness?.finish()||null)'));
}

test('a delayed prior shout cannot clear a newer person answer [N26,H5,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for Chrome startup, board setup and the existing 10-second observation.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for this real-board regression');
  const box = machine();
  const demo = project(box, 'prior-shout-overlap');
  box.run(demo.repo, 'shout', 'person', QUESTION, '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-prior-shout-'));
  let chrome, barrier, captureArmed = false, capture = null, barrierCleanup = null;
  const cleanupErrors = [];
  const cleanup = { barrierComplete: false, chromeClosed: false, viewStopped: false, profileRemoved: false };
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth===375&&document.querySelector('#proj-list .pname')?.textContent==='prior-shout-overlap'");
    await press(chrome, `document.querySelector(${JSON.stringify('[data-tab="shouts"]')})`);
    const armed = await armWitness(chrome);
    captureArmed = armed.armed === true;
    assert.ok(captureArmed, 'the native shout composer observer arms');
    barrier = await holdPriorShoutResponse(chrome, PRIOR);

    const beginPrior = "(()=>{const to=document.querySelector('#shout-to'),field=document.querySelector('#shout-text');"
      + "to.value='web';to.dispatchEvent(new Event('input',{bubbles:true}));to.dispatchEvent(new Event('change',{bubbles:true}));"
      + "field.value=" + JSON.stringify(PRIOR) + ";field.dispatchEvent(new Event('input',{bubbles:true}));"
      + "field.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#shout-form').requestSubmit();})()";
    await chrome.stable(beginPrior);
    const held = await barrier.waitUntilHeld(10_000); // budget: the existing local browser-wait ceiling, not a speed target.
    await chrome.waitFor("document.querySelector('#feed')?.innerText.includes(" + JSON.stringify(PRIOR) + ")");
    const committed = await boardOf(view, demo.repo);
    assert.ok(committed.shouts.some((shout) => shout.shout_text === PRIOR), 'the real server committed the prior shout while its response was held');
    const ask = committed.shouts.find((shout) => shout.shout_to === 'person' && shout.shout_text === QUESTION);
    assert.ok(ask, 'the private fixture contains the expected real pending person question');
    const selector = '#decisions [data-go="decide:' + ask.shout_id + '"]';
    await chrome.waitFor('!!document.querySelector(' + JSON.stringify(selector) + ')');
    await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
    const fillAnswer = "(()=>{const field=document.querySelector('#shout-text');field.value=" + JSON.stringify(ANSWER)
      + ";field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));})()";
    await chrome.stable(fillAnswer);
    const selected = JSON.parse(await chrome.stable("JSON.stringify({text:document.querySelector('#shout-text').value,"
      + "answerId:typeof view==='object'?(view.answering?.id??null):null,valid:document.querySelector('#shout-text').validity.valid})"));
    assert.equal(selected.text, ANSWER, 'the newer answer is composed before the older request completes');
    assert.equal(selected.answerId, ask.shout_id, 'the real question is selected before the older request completes');

    const releasedAt = Date.now();
    const released = await barrier.release(10_000);
    await chrome.waitFor("window.__priorShoutWitness?.events.some(event=>event.type==='prior-act-return')");
    const after = JSON.parse(await chrome.stable("JSON.stringify({text:document.querySelector('#shout-text').value,"
      + "answerId:typeof view==='object'?(view.answering?.id??null):null,valid:document.querySelector('#shout-text').validity.valid})"));
    barrierCleanup = await barrier.dispose();
    cleanup.barrierComplete = barrierCleanup.complete === true;
    barrier = null;
    await chrome.stable("document.querySelector('#shout-form').requestSubmit()");
    let answerWaitError = null;
    try { await chrome.waitFor("document.querySelector('#feed')?.innerText.includes(" + JSON.stringify(ANSWER) + ")"); }
    catch (error) { answerWaitError = error.message; } // budget: preserves the original 10-second answer observation.
    const finalState = await boardOf(view, demo.repo);
    capture = await finishWitness(chrome);
    captureArmed = false;
    const personAnswer = finalState.shouts.find((shout) => shout.shout_from === 'person' && shout.shout_text === ANSWER);
    t.diagnostic(JSON.stringify({ rootCauseStatus: 'NOT PROVEN',
      controlledOrder: 'real prior shout HTTP 200 and board commit; ordinary feed refresh; newer answer selected and filled; prior response released; prior act returned; native requestSubmit',
      priorCommitted: true, held: { status: held.status, trace: barrierCleanup.trace }, released: { status: released.status, at: releasedAt },
      selected, after, answerWaitError, personAnswerPresent: Boolean(personAnswer), capture }));
    assert.equal(after.text, ANSWER, 'the earlier shout completion must not clear the newer answer text');
    assert.equal(after.answerId, ask.shout_id, 'the earlier shout completion must not exit the newer answer mode');
    assert.equal(after.valid, true, 'the newer answer remains valid at the original submit point');
    assert.equal(answerWaitError, null, 'the original 10-second feed observation sees the answer');
    assert.ok(personAnswer, 'the original native form submission records the newer person answer');
    assert.equal(capture?.complete, true, 'the bounded lifecycle capture has no observer errors or drops');
    assert.equal(barrierCleanup.complete, true, 'the actual HTTP response barrier drained cleanly');
  } finally {
    if (barrier) {
      barrierCleanup = await barrier.dispose().catch((error) => ({ complete: false, trace: [], cleanupErrors: [`${error.name}: ${error.message}`] }));
      cleanup.barrierComplete = barrierCleanup.complete === true;
      cleanupErrors.push(...(barrierCleanup.cleanupErrors ?? []));
    }
    if (chrome && captureArmed) {
      try { capture = await finishWitness(chrome); captureArmed = false; }
      catch (error) { cleanupErrors.push('capture cleanup: ' + error.name + ': ' + error.message); }
    }
    if (chrome) {
      try { await closeSnapshotChrome(chrome); cleanup.chromeClosed = true; }
      catch (error) { cleanupErrors.push('Chrome close: ' + error.name + ': ' + error.message); }
    }
    try { await view.stop(); cleanup.viewStopped = true; }
    catch (error) { cleanupErrors.push('view stop: ' + error.name + ': ' + error.message); }
    try { rmSync(profile, { recursive: true, force: true }); cleanup.profileRemoved = true; }
    catch (error) { cleanupErrors.push('profile removal: ' + error.name + ': ' + error.message); }
    t.diagnostic(JSON.stringify({ ...cleanup, cleanupComplete: Object.values(cleanup).every(Boolean) && cleanupErrors.length === 0, cleanupErrors }));
  }
});
