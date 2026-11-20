// Visits and clicks, counted with PostHog (the EU Cloud project the old web app used), on www.messaging.quest
// only, so a preview, a test or a laptop counts nothing. Nothing is kept on the device (persistence "memory": no
// cookie, no storage), so one visit can't be told from the next, and no person profiles are made. Requests go to
// /ingest on this domain and the deploy passes them to PostHog (apps/web/vercel-output.json), so a blocker of
// posthog.com doesn't drop them. The key is PostHog's public, write-only project key.
// Besides PostHog's own page views, page leaves (with how far the page was read) and clicks, the steps that make a
// customer get a name of their own, with the section they were taken from as "place".
const KEY = "phc_qbQGyZpAZhM55fcSc3LFpiM4jDhyKuf7wmnnALncvU6w";
export const SITE = "www.messaging.quest";

/** What a click on this element means, if it is a step worth its own name. */
export function step(target) {
  const el = target.closest?.("a, button");
  if (!el) return null;
  const place = el.closest("section[id], header, footer, dialog[id]");
  const where = place ? place.id || place.localName : "page";
  const href = el.getAttribute("href") ?? "";
  if (/^https:\/\/(t\.me\/messagingquestbot|web\.telegram\.org\/)/.test(href)) return ["start_clicked", { place: where, via: href.startsWith("https://t.me/") ? "app" : "web" }];
  if (href.startsWith("https://github.com/theic/quest")) return ["repo_opened", { place: where }];
  if (el.matches("a[data-store]")) return ["add_to_chrome_clicked", { place: where }];
  if (el.matches('[commandfor="install"][command="show-modal"]')) return ["zip_steps_opened", { place: where }];
  if (href.endsWith("/quest-extension.zip")) return ["zip_downloaded", { place: where }];
  if (el.matches("a.card-link")) return ["feed_item_opened", { network: new URL(href).hostname.replace(/^www\./, "") }];
  if (el.matches("button.sound")) return ["video_sound_clicked", { on: el.getAttribute("aria-checked") !== "true" }];
  return null;
}

// A link Quest put up says which platform it is on (utm_source). The start buttons carry it on to the bot as the
// link's tag, so a sign-up says where it came from, on any host.
const source = new URLSearchParams(globalThis.location?.search ?? "").get("utm_source")?.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
if (source && globalThis.document) {
  for (const a of document.querySelectorAll('a[href^="https://t.me/messagingquestbot"]')) a.href = `https://t.me/messagingquestbot?start=from_${source}`;
}

if (globalThis.location?.hostname === SITE) {
  // PostHog's loader, as its docs give it: calls wait in a queue until /ingest/static/array.js has arrived.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  // Always window.posthog at the time of the call: the SDK, once it has arrived, takes the queue's place there.
  const ph = () => window.posthog;
  ph().init(KEY, {
    api_host: "/ingest",
    ui_host: "https://eu.posthog.com",
    persistence: "memory",
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_feature_flags: true,
    disable_external_dependency_loading: true,
  });
  const root = document.documentElement;
  // Every event says the page's language (the visitor's, or the one they pick) and, on the home page, what the
  // visitor is on (phone, chrome or other).
  const describe = () => ph().register({ language: root.lang, ...(root.dataset.device && { device: root.dataset.device }) });
  describe();
  new MutationObserver(describe).observe(root, { attributes: true, attributeFilter: ["lang"] });
  addEventListener("click", (event) => {
    const named = step(event.target);
    if (named) ph().capture(...named);
  }, { capture: true });
}
