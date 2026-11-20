/**
 * Keeping the computer awake while Quest works.
 *
 * Quest reads in this Chrome all day, and a computer that falls asleep stops
 * it until someone wakes it. So while this Chrome is connected, the extension
 * asks Chrome to keep the system awake (chrome.power, "system": the screen may
 * still turn off). It is on unless the customer turns it off in the popup, and
 * it ends when they disconnect. Closing a laptop's lid still puts it to sleep:
 * that is the operating system's call, not Chrome's.
 */

/** Whether Quest keeps the computer awake: while connected, unless they turned it off. */
export const keepsAwake = ({ connected, awake }) => Boolean(connected) && awake !== false;

/**
 * Asks Chrome to keep the system awake, or lets it sleep again. Safe to call
 * every time the worker wakes: Chrome keeps one request per extension, and
 * asking again only repeats it.
 */
export function syncAwake(power, state) {
  if (keepsAwake(state)) power.requestKeepAwake("system");
  else power.releaseKeepAwake();
  return keepsAwake(state);
}
