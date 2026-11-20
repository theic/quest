/**
 * Whether this copy is a release. The repository's copy is a developer's, so it says false;
 * every zip scripts/pack-extension.mjs makes says true: the Chrome Web Store's, and the one
 * messaging.quest offers to load unpacked. A release connects only to Quest's own address and
 * shows no address field, even when it is loaded unpacked (quest-server.js).
 */
export const RELEASE = false;
