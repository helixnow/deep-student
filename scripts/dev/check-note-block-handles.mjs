/** Run against an open note in the real `npm run tauri dev` UI bridge session. */
import assert from 'node:assert/strict';
import { evalJs } from './ui-drive-core.mjs';

const result = await evalJs(`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const editors = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].filter(editor => {
  const r = editor.getBoundingClientRect();
  return r.width > 0 && getComputedStyle(editor).visibility !== 'hidden';
});
const checks = [];
for (const [pane, editor] of editors.entries()) {
  const handle = editor.parentElement.querySelector('.milkdown-block-handle');
  if (!handle) continue;
  const candidates = [editor.querySelector('h1,h2,h3'), editor.querySelector('p')].filter(Boolean);
  for (const block of candidates) {
    const rect = block.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!block.contains(hit)) continue;
    editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Shift', bubbles:true}));
    await pause(250);
    const hiddenRect = handle.getBoundingClientRect();
    const hiddenStyle = getComputedStyle(handle);
    const hidden = hiddenStyle.visibility === 'hidden' && hiddenStyle.pointerEvents === 'none';
    const move = () => block.dispatchEvent(new PointerEvent('pointermove', {
      bubbles:true, pointerType:'mouse', clientX:rect.left+rect.width/2, clientY:rect.top+rect.height/2,
    }));
    move();
    const samples = [];
    const start = performance.now();
    await new Promise(resolve => {
      const frame = () => {
        const r = handle.getBoundingClientRect();
        if (handle.dataset.show === 'true') samples.push({x:r.x, y:r.y, right:r.right, width:r.width});
        if (performance.now()-start < 300) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
    move();
    await pause(250);
    const settled = handle.getBoundingClientRect();
    const operations = [...handle.querySelectorAll('.operation-item')].map(operation => {
      const r = operation.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
      return {label:operation.getAttribute('aria-label'), hit:operation.contains(hit),
        x:r.x,y:r.y,width:r.width,height:r.height,keyboard:operation.tabIndex===0};
    });
    checks.push({pane,block:block.tagName,hidden,hiddenWidth:hiddenRect.width,
      first:samples[0],settled:{x:settled.x,y:settled.y},frames:samples.length,
      overlapFrames:samples.filter(r=>r.right>rect.left+1).length,
      drift:samples.some(r=>Math.abs(r.x-settled.x)>1 || Math.abs(r.y-settled.y)>1),operations});
  }
}
return {viewport:{width:innerWidth,height:innerHeight},checks};
`);

console.log(JSON.stringify(result, null, 2));
assert.equal(result.ok, true, result.error);
assert.ok(result.value.checks.length, 'Open an editable note with a visible heading or paragraph.');
for (const check of result.value.checks) {
  assert.ok(check.hidden && check.hiddenWidth > 0, 'Hidden handle must remain measurable and inert.');
  assert.ok(check.frames > 0, 'Hover must show the handle.');
  assert.equal(check.overlapFrames, 0, 'Handle overlaps document text.');
  assert.equal(check.drift, false, 'First hover position differs from the settled position.');
  assert.equal(check.operations.length, 2);
  for (const operation of check.operations) {
    assert.ok(operation.label && operation.keyboard, 'Block operation must have a name and keyboard access.');
    assert.ok(operation.hit, 'Block operation is clipped or covered.');
    assert.ok(operation.x >= 0 && operation.y >= 0, 'Block operation is outside the viewport.');
  }
}
