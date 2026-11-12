// One More Tune's film window: a page of its own that plays the original the
// deck asks for. The request travels through the group's state (film:request);
// the desk tells this page when it changes.
(async function startOneMoreTuneFilm() {
  "use strict";
  const runtime = window.OneMoreRuntime;
  await runtime.start({ appId: "oneMoreTune", window: "oneMoreTuneFilm" });
  installOneMoreTuneFilmWindow();
  runtime.lifecycle({
    onSuspend: () => stopOneMoreTuneFilm(),
    onDispose: () => stopOneMoreTuneFilm(),
  });
  const key = window.OneMoreTune.filmRequestKey;
  runtime.state.onChanged(key, (request) => window.OneMoreTune.playFilmRequest(request));
  // Opened by the request itself: play what was asked a moment ago.
  const pending = runtime.state.get(key);
  if (pending && !pending.stop && Date.now() - Number(pending.at || 0) < 60000) window.OneMoreTune.playFilmRequest(pending);
  runtime.onLanguage(() => translateWithin(document));
  runtime.snapshots(document.getElementById("app"));
  runtime.ready();
})();
