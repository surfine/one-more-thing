// One More Take's page: start the runtime, then the game.
(async function startOneMoreTake() {
  "use strict";
  await window.OneMoreRuntime.start({ appId: "oneMoreTake", window: "oneMoreTake" });
  translateWithin(document);
  window.OneMoreRuntime.lifecycle(window.OneMoreTake.lifecycle());
  window.OneMoreRuntime.onLanguage(() => window.OneMoreTake.render());
  await window.OneMoreTake.attach();
  window.OneMoreRuntime.snapshots(document.getElementById("app"));
  window.OneMoreRuntime.ready();
})();
