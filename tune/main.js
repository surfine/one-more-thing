// One More Tune's page: start the runtime, draw the deck's window, hand over.
(async function startOneMoreTune() {
  "use strict";
  await window.OneMoreRuntime.start({ appId: "oneMoreTune", window: "oneMoreTune" });
  installOneMoreTuneWindow();
  window.OneMoreRuntime.lifecycle(window.OneMoreTune.lifecycle());
  window.OneMoreRuntime.menu(window.OneMoreTune.menu);
  window.OneMoreRuntime.onLanguage(() => renderOneMoreTune());
  window.OneMoreTune.attach();
  window.OneMoreRuntime.snapshots(document.getElementById("app"));
  window.OneMoreRuntime.ready();
})();
