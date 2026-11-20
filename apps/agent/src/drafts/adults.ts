/**
 * Adults only. The founder's outreach by hand left out "a 16-year-old builder" (2026-11-02); live, 2026-11-03, a Threads
 * run drafted a like, a follow and a reply for a builder whose post opened "I'm 17". Someone who says they are under 18
 * gets nothing from the customer's account: no like, follow, reply, message or find.
 */
const UNDER_18 =
  /\b(i['’]?m|i am|aged?|turning|just turned)\s+(1[0-7])\b(?!\s*(%|\+|x\b|k\b|years? (of|in|into)|yrs? (of|in)|min|hours?|days?|weeks?|months?|followers|users|apps?|projects?|tabs?))|\b(1[0-7])\s*(yo|y\/o|y\.o\.|years? old|yrs? old)\b|\b(1[0-7])[- ]year[- ]old\b/i;

/** Whether the words say their author is under 18 ("I'm 17, and I'm building ...", "16 y/o dev"). */
export const saysUnder18 = (text: string): boolean => UNDER_18.test(text);

export const UNDER_18_REFUSAL = "Not done: they say they are under 18, and Quest works with adults only. Skip them, and their posts too.";
