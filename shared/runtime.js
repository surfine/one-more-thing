// One More's runtime: the one place the app meets its host.
//
// One More Tune, its film window and One More Take each run in a page of their
// own. In a desk the page is a same-origin frame and every desk service is a
// bridge call (ais6-bridge.js, bridge contract v1); on its own the same calls
// are answered by the bridge's standalone adapter. The game modules call a
// handful of plain functions — t(), html``, setStatus(), openWindow() — and
// this file is where those functions are defined, so the games do not know
// which of the two they are running in.
//
// State is read once, whole, before a game starts, so the games' reads stay
// synchronous; writes go to the bridge and keep the copy here current.
(function installOneMoreRuntime(root) {
  "use strict";

  // The version this tree is; the desk's pin must name the same one.
  const VERSION = "1.0.0";
  const strings = () => root.OneMoreStrings || { en: {}, zh: {} };
  let bridge = null;
  let welcome = null;
  let started = null;
  const cache = new Map();
  const stateListeners = new Map();
  const languageListeners = [];
  let lifecycleHandlers = {};
  let menu = null;
  let menuSignature = "";
  let menuTimer = 0;

  // ---------------------------------------------------------------------------
  // Strings: the app's own tables, the same keys the desk once held.

  root.currentLanguage = "zh";

  function t(key, ...args) {
    const tables = strings();
    const table = tables[root.currentLanguage] || tables.zh || {};
    const value = table[key] ?? tables.en?.[key] ?? key;
    return typeof value === "function" ? value(...args) : value;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Tagged template for innerHTML assembly: every interpolation is escaped;
  // html.raw(markup) is the explicit hatch for markup this app built.
  function html(parts, ...values) {
    let out = "";
    parts.forEach((part, index) => {
      out += part;
      if (index < values.length) out += htmlValue(values[index]);
    });
    return out;
  }
  function htmlValue(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(htmlValue).join("");
    if (value && typeof value === "object" && typeof value.safeHtml === "string") return value.safeHtml;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return escapeHtml(value);
  }
  html.raw = (markup) => Array.isArray(markup)
    ? { safeHtml: markup.map((part) => String(part ?? "")).join("") }
    : { safeHtml: String(markup ?? "") };

  // The data-i18n sweep a freshly drawn surface needs.
  function translateWithin(scope) {
    if (!scope || typeof scope.querySelectorAll !== "function") return;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      const value = t(el.dataset.i18n);
      if (String(value).includes("<")) el.innerHTML = value;
      else el.textContent = value;
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel)); });
    scope.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  }

  function setLanguage(language) {
    root.currentLanguage = language === "en" ? "en" : "zh";
    if (root.document?.documentElement) root.document.documentElement.lang = root.currentLanguage === "zh" ? "zh-Hans" : "en";
  }

  // ---------------------------------------------------------------------------
  // The desk's status line.

  function setStatus(text) {
    const line = String(text ?? "");
    if (bridge && line) bridge.status({ text: line });
  }

  // ---------------------------------------------------------------------------
  // The window. The desk draws the frame and the title bar; the app draws
  // what sits below them, in the shape the desk's own window shell builds, so
  // the deck's stylesheet finds the same elements it always styled.

  function createWindow(options = {}) {
    const doc = root.document;
    const windowName = String(options.windowName || "");
    const existing = doc.querySelector(`[data-window="${windowName}"]`);
    if (existing) return existing;
    const win = doc.createElement("section");
    win.className = ["window", options.windowClass].filter(Boolean).join(" ");
    win.dataset.window = windowName;
    if (options.labelledBy) win.setAttribute("aria-labelledby", options.labelledBy);
    if (options.statusClass || options.statusHtml) {
      const bar = doc.createElement("div");
      bar.className = ["details-bar", "kit-status-bar", options.statusClass].filter(Boolean).join(" ");
      bar.innerHTML = String(options.statusHtml || "");
      win.append(bar);
      win.applicationStatusBar = bar;
    }
    if (options.beforePaneHtml) {
      const slot = doc.createElement("div");
      slot.innerHTML = String(options.beforePaneHtml);
      while (slot.firstChild) win.append(slot.firstChild);
    }
    const pane = doc.createElement("div");
    pane.className = ["window-pane", options.paneClass].filter(Boolean).join(" ");
    pane.innerHTML = String(options.paneHtml || "");
    win.append(pane);
    win.applicationPane = pane;
    (doc.getElementById("app") || doc.body).append(win);
    translateWithin(win);
    if (options.title) setTitle(options.title);
    return win;
  }

  function setTitle(text) {
    if (bridge) bridge.setTitle(String(text || ""));
    else if (root.document) root.document.title = String(text || "");
  }

  // Listeners that go with the page; the shape the desk's instance resources had.
  function resources() {
    const offs = [];
    const set = {
      disposed: false,
      listen(target, type, fn, options) {
        target?.addEventListener?.(type, fn, options);
        offs.push(() => target?.removeEventListener?.(type, fn, options));
      },
      add(fn) {
        if (typeof fn === "function") offs.push(fn);
      },
      dispose() {
        offs.splice(0).forEach((off) => { try { off(); } catch { /* gone */ } });
        set.disposed = true;
      },
    };
    return set;
  }

  // ---------------------------------------------------------------------------
  // Other windows of One More: the deck opens its film window, Take opens the
  // deck. A window of this page itself is already open.

  function openWindow(name) {
    const target = String(name || "");
    if (!target || target === welcome?.window) return Promise.resolve(true);
    if (!bridge) return Promise.resolve(false);
    return bridge.call("window.open", { window: target }).then(() => true, () => false);
  }

  // ---------------------------------------------------------------------------
  // State: the whole group's keys are read once at start.

  const stateGet = (key) => (cache.has(key) ? cache.get(key) : null);

  function stateSet(key, value) {
    cache.set(key, value);
    if (!bridge) return Promise.resolve(false);
    return bridge.call("state.set", { key, value }).then(() => true, () => false);
  }

  function stateRemove(key) {
    cache.delete(key);
    if (!bridge) return Promise.resolve(false);
    return bridge.call("state.remove", { key }).then(() => true, () => false);
  }

  function onStateChanged(key, fn) {
    if (!stateListeners.has(key)) stateListeners.set(key, []);
    stateListeners.get(key).push(fn);
  }

  async function loadState() {
    const answer = await bridge.call("state.keys", {});
    const keys = (answer?.keys || []).filter((key) => key !== "_import");
    await Promise.all(keys.map((key) => bridge.call("state.get", { key }).then((got) => cache.set(key, got ? got.value : null))));
  }

  // ---------------------------------------------------------------------------
  // The desk's public gate. On the public deployment an /api/ request without
  // a verified session answers 401 verification_required; the desk's own
  // fetch shows its verification sheet and retries. This page's fetch is not
  // the desk's, so it asks the desk for the sheet (access.verify) and retries.

  const nativeFetch = root.fetch ? root.fetch.bind(root) : null;

  // On its own, with no desk behind it, the page has neither the decks nor the
  // round authority. A copy that ships a demo/ folder (decks in demo/data/,
  // the recorded round in demo/authority.js) is answered from it: the three
  // deck files are read from demo/data/, and /api/one-more-tune/* goes to
  // OneMoreDemo.request. demo/ sits beside tune/ and take/, so it is found
  // from the page's own address. In a desk none of this runs and nothing under
  // demo/ is ever asked for.
  const DEMO_DECK = /^\/data\/(one-more-(?:tune-deck|tune-evidence|take-deck)\.json)$/;
  const DEMO_ROUTE = "/api/one-more-tune/";
  let demoAuthority = null;
  function demoTarget(input) {
    try {
      const url = new URL(typeof input === "string" ? input : input?.url || input?.href || "", root.location.href);
      if (url.origin !== root.location.origin) return null;
      const deck = DEMO_DECK.exec(url.pathname);
      if (deck) return { deck: deck[1] };
      if (url.pathname.startsWith(DEMO_ROUTE)) return { route: url.pathname.slice(DEMO_ROUTE.length) + url.search };
    } catch { /* not a URL we know */ }
    return null;
  }
  function loadDemoAuthority() {
    if (!demoAuthority) {
      demoAuthority = new Promise((resolve, reject) => {
        if (root.OneMoreDemo) return resolve(root.OneMoreDemo);
        const tag = root.document.createElement("script");
        tag.src = new URL("../demo/authority.js", root.location.href).href;
        tag.onload = () => (root.OneMoreDemo ? resolve(root.OneMoreDemo) : reject(new Error("demo authority missing")));
        tag.onerror = () => reject(new Error("demo authority not loaded"));
        root.document.head.append(tag);
      }).catch((error) => { demoAuthority = null; throw error; });
    }
    return demoAuthority;
  }

  function sameOriginApi(input) {
    try {
      const url = new URL(typeof input === "string" ? input : input?.url || "", root.location.href);
      return url.origin === root.location.origin && url.pathname.startsWith("/api/");
    } catch {
      return false;
    }
  }
  if (nativeFetch) {
    root.fetch = async function oneMoreFetch(input, init) {
      const demo = bridge?.standalone ? demoTarget(input) : null;
      if (demo?.deck) return nativeFetch(new URL(`../demo/data/${demo.deck}`, root.location.href).href, init);
      if (demo) return (await loadDemoAuthority()).request(demo.route, { method: init?.method || input?.method, body: init?.body });
      const retryInput = typeof Request !== "undefined" && input instanceof Request ? input.clone() : input;
      const response = await nativeFetch(input, init);
      if (response.status !== 401 || !bridge || !sameOriginApi(input)) return response;
      const data = await response.clone().json().catch(() => ({}));
      if (data.code !== "verification_required") return response;
      const verified = await bridge.call("access.verify", {}, { timeout: 10 * 60 * 1000 }).catch(() => ({ verified: false }));
      return verified?.verified ? nativeFetch(retryInput, init) : response;
    };
  }

  function access() {
    if (!bridge) return Promise.resolve({ profile: "standalone", verified: true });
    return bridge.call("access.session", {}).catch(() => ({ profile: "", verified: false }));
  }

  // ---------------------------------------------------------------------------
  // The desk's appearance, visited (the deck's era reveal).

  function visitAppearance(theme) {
    if (!bridge) return Promise.resolve(null);
    return bridge.call("appearance.visit", { theme: theme || null }).catch(() => null);
  }

  // ---------------------------------------------------------------------------
  // Menus: the commands live in the manifest; the app answers menu.command
  // and pushes availability whenever what it shows changes.

  function pushMenuState() {
    menuTimer = 0;
    if (!bridge || !menu) return;
    const available = {};
    const checked = {};
    const reasons = {};
    menu.commands().forEach((action) => {
      const answer = menu.availability(action) || {};
      available[action] = answer.available === true;
      if (!available[action] && answer.reason) reasons[action] = String(answer.reason);
      if (menu.checked) checked[action] = menu.checked(action) === true;
    });
    const signature = JSON.stringify([available, checked, reasons]);
    if (signature === menuSignature) return;
    menuSignature = signature;
    bridge.menuState({ available, checked, reasons });
  }
  function scheduleMenuState() {
    if (menuTimer) return;
    menuTimer = setTimeout(pushMenuState, 30);
  }

  function setMenu(definition) {
    menu = definition;
    if (typeof MutationObserver === "function" && root.document?.body) {
      new MutationObserver(scheduleMenuState).observe(root.document.body, { attributes: true, childList: true, subtree: true, characterData: true });
    }
    scheduleMenuState();
  }

  // ---------------------------------------------------------------------------
  // Start: connect, read the state, take the language, then hand over.

  function start(options = {}) {
    if (started) return started;
    started = (async () => {
      try {
        bridge = await root.AIS6Bridge.connect({ appId: options.appId, window: options.window, version: options.version || VERSION });
      } catch (error) {
        bridge = null;
      }
      welcome = bridge?.welcome || null;
      setLanguage(welcome?.language || (new URLSearchParams(root.location?.search || "").get("lang") === "en" ? "en" : "zh"));
      // A game starts with nothing saved if the state cannot be read.
      if (bridge) {
        try { await loadState(); } catch { /* nothing saved */ }
      }
      if (bridge) {
        bridge.on("language.changed", ({ language }) => {
          setLanguage(language);
          translateWithin(root.document);
          languageListeners.forEach((fn) => { try { fn(root.currentLanguage); } catch (error) { console.error(error); } });
        });
        bridge.on("state.changed", async ({ key }) => {
          try {
            const got = await bridge.call("state.get", { key });
            cache.set(key, got ? got.value : null);
          } catch { /* keep the copy we had */ }
          (stateListeners.get(key) || []).forEach((fn) => { try { fn(stateGet(key)); } catch (error) { console.error(error); } });
        });
        const lifecycle = (name) => async () => {
          try { await lifecycleHandlers[name]?.(); } catch (error) { console.error(error); }
          return {};
        };
        bridge.handle("lifecycle.suspend", lifecycle("onSuspend"));
        bridge.handle("lifecycle.resume", lifecycle("onResume"));
        bridge.handle("lifecycle.dispose", lifecycle("onDispose"));
        bridge.handle("menu.command", async ({ action }) => {
          if (!menu || !menu.commands().includes(action)) return { handled: false };
          await menu.run(action);
          scheduleMenuState();
          return { handled: true };
        });
      }
      return welcome;
    })();
    return started;
  }

  function ready() {
    if (bridge) bridge.ready();
  }

  // The window's picture for the desk's Peek and minimize (bridge contract
  // 3.7): the DOM producer, taken off the interaction path.
  function snapshots(target) {
    if (bridge && !bridge.standalone && (welcome?.capabilities || []).includes("snapshot")) {
      bridge.enableSnapshots({ producer: "dom", target: target || root.document?.body || null });
    }
  }

  root.t = t;
  root.html = html;
  root.escapeHtml = escapeHtml;
  root.translateWithin = translateWithin;
  root.setStatus = setStatus;
  root.openWindow = openWindow;

  root.OneMoreRuntime = Object.freeze({
    start,
    ready,
    snapshots,
    welcome: () => welcome,
    hosted: () => Boolean(bridge && !bridge.standalone),
    version: () => welcome?.version || "dev",
    launch: () => welcome?.launch || null,
    phone: () => Number(welcome?.phone) || 0,
    createWindow,
    setTitle,
    resources,
    openWindow,
    state: Object.freeze({ get: stateGet, set: stateSet, remove: stateRemove, onChanged: onStateChanged }),
    onLanguage: (fn) => { languageListeners.push(fn); },
    lifecycle: (handlers) => { lifecycleHandlers = handlers || {}; },
    menu: setMenu,
    refreshMenu: scheduleMenuState,
    access,
    visitAppearance,
  });
})(typeof window !== "undefined" ? window : globalThis);
