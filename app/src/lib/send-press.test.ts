// The Send button's rules (send-press.ts). Each test walks one gesture the way the component reports it:
// touch down, an optional hold, touch up, then the press event that follows a completed touch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newSendTouch, pressed, touchDown, touchHeld, touchUp } from "./send-press.ts";

const idle = { ready: true, holdToQueue: false }, replying = { ready: true, holdToQueue: true };

test("with no reply running, Send goes the moment it is touched, once", () => {
  const touch = newSendTouch();
  assert.equal(touchDown(touch, { ...idle, now: 1_000 }), "send");
  assert.equal(touchUp(touch), null);
  assert.equal(pressed(touch, { ready: true, canStop: false, now: 1_080 }), null, "the press that follows the touch is the same send");
  // iOS took the touch away after swipe typing: there is no press at all, and it was still sent.
  const taken = newSendTouch();
  assert.equal(touchDown(taken, { ...idle, now: 1_000 }), "send");
  assert.equal(touchUp(taken), null);
});

test("VoiceOver and a keyboard only press: that sends", () => {
  assert.equal(pressed(newSendTouch(), { ready: true, canStop: false, now: 9_000 }), "send");
  assert.equal(pressed(newSendTouch(), { ready: false, canStop: false, now: 9_000 }), null, "nothing typed, nothing to stop");
});

test("while the agent replies, a tap sends when the finger lifts", () => {
  const touch = newSendTouch();
  assert.equal(touchDown(touch, { ...replying, now: 1_000 }), null, "waits to see if it is a hold");
  assert.equal(touchUp(touch), "send");
  assert.equal(pressed(touch, { ready: false, canStop: true, now: 1_090 }), null, "the press after it neither sends again nor stops the agent");
  // A touch iOS takes away is still a tap.
  const taken = newSendTouch();
  touchDown(taken, { ...replying, now: 1_000 });
  assert.equal(touchUp(taken), "send");
});

test("while the agent replies, holding Send queues the message, once, and lifting adds nothing", () => {
  const touch = newSendTouch();
  assert.equal(touchDown(touch, { ...replying, now: 1_000 }), null);
  assert.equal(touchHeld(touch), "queue");
  assert.equal(touchHeld(touch), null);
  assert.equal(touchUp(touch), null);
  assert.equal(touchHeld(newSendTouch()), null, "a hold with nothing to send and nothing to stop does nothing");
});

test("with nothing typed while the agent works, the button stops it", () => {
  const touch = newSendTouch();
  assert.equal(touchDown(touch, { ready: false, holdToQueue: true, now: 5_000 }), null);
  assert.equal(touchUp(touch), null);
  assert.equal(pressed(touch, { ready: false, canStop: true, now: 5_100 }), "stop");
  assert.equal(pressed(newSendTouch(), { ready: false, canStop: false, now: 5_100 }), null, "a reply that can't be stopped");
});

test("a second tap on Send never stops the reply the first one started", () => {
  const touch = newSendTouch();
  assert.equal(touchDown(touch, { ...idle, now: 1_000 }), "send");
  touch.sentAt = 1_000;
  touchUp(touch);
  assert.equal(pressed(touch, { ready: false, canStop: false, now: 1_080 }), null);
  // 150 ms later the box is empty and the button already shows Stop.
  assert.equal(touchDown(touch, { ready: false, holdToQueue: true, now: 1_150 }), null);
  assert.equal(pressed(touch, { ready: false, canStop: true, now: 1_230 }), null, "too soon after a send to mean Stop");
  // A deliberate tap later does stop it.
  touchDown(touch, { ready: false, holdToQueue: true, now: 2_400 });
  assert.equal(pressed(touch, { ready: false, canStop: true, now: 2_480 }), "stop");
});

test("the tap after a held Send is its own tap", () => {
  const touch = newSendTouch();
  touchDown(touch, { ...replying, now: 1_000 });
  assert.equal(touchHeld(touch), "queue");
  touch.sentAt = 1_400;
  touchUp(touch); // a hold is followed by no press event, so the touch's time is still remembered
  touchDown(touch, { ready: false, holdToQueue: true, now: 3_000 });
  assert.equal(pressed(touch, { ready: false, canStop: true, now: 3_080 }), "stop", "not swallowed as part of the hold");
});

test("a firm, slow press on Stop still stops the reply, once", () => {
  // Held past the hold delay, the touch gets no press event: the hold itself has to stop the reply.
  const touch = newSendTouch();
  assert.equal(touchDown(touch, { ready: false, holdToQueue: true, now: 5_000 }), null);
  assert.equal(touchHeld(touch, { canStop: true, now: 5_400 }), "stop");
  assert.equal(touchHeld(touch, { canStop: true, now: 5_400 }), null);
  assert.equal(touchUp(touch), null);
  assert.equal(pressed(touch, { ready: false, canStop: true, now: 5_500 }), null, "a press that follows anyway is the same touch");
  // Nothing to stop, or right after a send (a second touch meant for Send): the hold does nothing.
  const idleTouch = newSendTouch();
  touchDown(idleTouch, { ready: false, holdToQueue: true, now: 5_000 });
  assert.equal(touchHeld(idleTouch, { canStop: false, now: 5_400 }), null);
  const justSent = newSendTouch();
  justSent.sentAt = 4_800;
  touchDown(justSent, { ready: false, holdToQueue: true, now: 5_000 });
  assert.equal(touchHeld(justSent, { canStop: true, now: 5_400 }), null);
});
