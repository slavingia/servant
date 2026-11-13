// What a touch on the composer's Send button does. The rules live here, apart from the component, so they can
// be tested: Send goes on touch down, except while the agent is replying, when a tap and a hold mean different
// things; and with nothing typed the same button stops the reply.

/** `hold` is "armed" while a touch is still deciding between a tap and a hold. `downAt` is when the last touch
 *  that sent (or may yet send) went down, 0 for none; `sentAt` is when the last message left. */
export type SendTouch = { hold: "armed" | "held" | null; downAt: number; sentAt: number };
export const newSendTouch = (): SendTouch => ({ hold: null, downAt: 0, sentAt: 0 });

/** How long a press event is taken to belong to the touch before it. */
const SAME_TOUCH = 5000;
/** A press on Stop this soon after a send is a second tap on Send, not a wish to stop. */
const TOO_SOON_TO_STOP = 1000;

/** Finger down. After swipe typing iOS can take the touch away before it lifts, so this is where Send goes.
 *  While a reply is running (`holdToQueue`) it waits instead, to see whether this is a tap or a hold. */
export function touchDown(touch: SendTouch, state: { ready: boolean; holdToQueue: boolean; now: number }): "send" | null {
  // A touch that sends nothing forgets the one before, so the tap that follows a held Send is not mistaken for it.
  if (!state.ready) { touch.downAt = 0; return null; }
  touch.downAt = state.now;
  if (!state.holdToQueue) return "send";
  touch.hold = "armed";
  return null;
}

/** Still down after the hold delay. A message ready to go waits for the reply in progress to finish. With
 *  nothing typed the button is Stop, and a firm, slow press on it still stops the reply: no press event follows
 *  a hold, so this is the only place that touch is heard. */
export function touchHeld(touch: SendTouch, state: { canStop: boolean; now: number } = { canStop: false, now: 0 }): "queue" | "stop" | null {
  if (touch.hold === "armed") { touch.hold = "held"; return "queue"; }
  if (touch.hold || touch.downAt || !state.canStop || state.now - touch.sentAt <= TOO_SOON_TO_STOP) return null;
  // Should a press follow after all, it belongs to this touch and is not a second Stop.
  touch.downAt = state.now;
  return "stop";
}

/** Finger up, or the touch was taken away. One that was still deciding was a tap: send now. */
export function touchUp(touch: SendTouch): "send" | null {
  const was = touch.hold;
  touch.hold = null;
  return was === "armed" ? "send" : null;
}

/** The press itself. It follows every touch (already dealt with above) and is all that VoiceOver or a keyboard
 *  sends. With nothing to send while the agent can be stopped, it stops the reply. */
export function pressed(touch: SendTouch, state: { ready: boolean; canStop: boolean; now: number }): "send" | "stop" | null {
  if (touch.downAt && state.now - touch.downAt < SAME_TOUCH) { touch.downAt = 0; return null; }
  if (state.ready) return "send";
  return state.canStop && state.now - touch.sentAt > TOO_SOON_TO_STOP ? "stop" : null;
}
