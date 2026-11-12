// One More's demo authority: the round authority of a copy that has no server.
//
// The public One More repository ships without the desk's decks and without
// its server. Opened as a page of its own, the games play a small demo
// instead: the decks in demo/data/, and this script, which answers the
// /api/one-more-tune/* routes from demo/round.json. That file is one fixed
// round recorded from the server's own module and routes by
// tooling/apps/one-more-demo.mjs, so every body below is what the real routes
// sent for the same request. Nothing here decides an answer: it looks the
// recorded one up.
//
// Plain script, no modules. It is loaded by shared/runtime.js, only when the
// page has no desk, and exposes:
//
//   OneMoreDemo.data(url)           the demo copy of a deck URL, as a Response
//   OneMoreDemo.request(route, init) one authority route, as a Response
//
// `route` is what follows /api/one-more-tune/ ("round", "answer",
// "credits/<id>", "preview?url=..."); `init` is the fetch init the app sent.
(function installOneMoreDemo(root) {
  "use strict";

  // demo/ is the folder this script was loaded from.
  const here = root.document && root.document.currentScript ? root.document.currentScript.src : "";
  const base = here ? here.replace(/[^/]*$/, "") : "";
  let fixture = null;

  function load() {
    if (!fixture) {
      fixture = root.fetch(`${base}round.json`, { cache: "no-cache" })
        .then((response) => {
          if (!response.ok) throw new Error(`demo round ${response.status}`);
          return response.json();
        })
        .catch((error) => { fixture = null; throw error; });
    }
    return fixture;
  }

  const reply = (entry) => new Response(JSON.stringify(entry.body), {
    status: entry.status,
    headers: { "Content-Type": "application/json" },
  });

  // The route's own id test (routes/one-more-tune.js): credits and media paths
  // are tokens of sixteen or more URL-safe characters.
  const idLike = (id) => /^[A-Za-z0-9_-]{16,}$/.test(id);

  // The deck URLs the app asks for, mapped onto the demo copies beside this script.
  function data(url) {
    const name = /\/data\/(one-more-(?:tune-deck|tune-evidence|take-deck)\.json)$/.exec(String(url || ""));
    if (!name) return Promise.resolve(new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } }));
    return root.fetch(`${base}data/${name[1]}`, { cache: "no-cache" });
  }

  // Which game the request is for. The closed list is the real route's; this
  // copy has the music deck only, so every other domain is refused the way the
  // route refuses a domain it does not have.
  function music(body) {
    const domain = body && body.domain;
    return domain === undefined || domain === null || String(domain).trim() === "" || String(domain).trim() === "music";
  }

  function parse(init) {
    try { return JSON.parse(typeof init.body === "string" ? init.body : ""); } catch { return undefined; }
  }

  async function request(route, init = {}) {
    const f = await load();
    const [path] = String(route || "").split("?");
    const slash = path.indexOf("/");
    const name = slash < 0 ? path : path.slice(0, slash);
    const id = slash < 0 ? "" : path.slice(slash + 1);
    const method = String(init.method || "GET").toUpperCase();
    const refuse = (key) => reply(f.refusals[key]);

    if (name === "round") {
      if (method !== "POST") return refuse("postOnly");
      const body = parse(init) || {};
      if (!music(body)) return refuse("unknownDomain");
      const wanted = String(body.challengeId || "").trim();
      if (wanted && wanted !== f.challengeId && wanted !== `OMT.${f.deckVersion}.${f.challengeId}`) return refuse("setNotFound");
      const round = f.round;
      if (Number.isInteger(body.questionIndex) && body.questionIndex >= 0) {
        const one = round.body.questions[body.questionIndex];
        if (!one) return refuse("roundQuestionNotFound");
        return reply({ status: round.status, body: { ...round.body, questions: [one] } });
      }
      return reply(round);
    }
    if (name === "answer") {
      if (method !== "POST") return refuse("postOnly");
      const body = parse(init);
      if (!body || typeof body !== "object") return refuse("badRequest");
      if (!music(body)) return refuse("unknownDomain");
      if (String(body.roundToken || "") !== f.round.body.roundToken) return refuse("roundNotFound");
      const recorded = f.answers[String(body.questionToken || "")];
      if (!recorded) return refuse("questionNotFound");
      const choice = String(body.choiceToken || "");
      if (body.skipped || !choice) return reply(recorded.skip);
      if (!Object.hasOwn(recorded, choice) || choice === "skip") return refuse("invalidChoice");
      return reply(recorded[choice]);
    }
    if (name === "credits") return idLike(id) ? reply(f.credits) : refuse("creditsNotFound");
    if (name === "media") return idLike(id) ? refuse("mediaNotLicensed") : refuse("mediaNotFound");
    if (name === "preview") return refuse("previewNotFound");
    // report, and any route this copy does not have: the router's own 404.
    return refuse("notFound");
  }

  root.OneMoreDemo = Object.freeze({ data, request });
})(typeof window !== "undefined" ? window : globalThis);
