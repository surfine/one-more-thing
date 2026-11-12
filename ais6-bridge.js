// AI System 6 app bridge — client, protocol 1.
//
// The one file an extracted app uses to talk to the desk. It is vendored by
// each app repository and served by the desk at /apps/_kit/ais6-bridge.js; no
// app writes postMessage by hand. Contract: bridge contract v1, section 3 of
// the desk's app extraction plan.
//
// Inside the desk the app is a same-origin iframe. The client says `hello` to
// its parent once; the desk answers `welcome` and hands over a MessagePort, and
// every later message travels on that port. Outside a desk (the app's own page,
// its development server) the same calls are answered by a standalone adapter:
// localStorage-backed state, the system colour scheme, files as downloads.
//
// This file is the single place an app artifact may name localStorage,
// sessionStorage or `parent` (tooling/apps/boundary-census.mjs allow-lists it).
(function installAis6Bridge(root) {
  "use strict";

  const PROTOCOL = 1;
  const ENVELOPE = 1;
  const HELLO_TIMEOUT_MS = 10000;
  const REQUEST_TIMEOUT_MS = 15000;
  const SNAPSHOT_IDLE_MS = 1000;
  const SNAPSHOT_MAX_EDGE = 1600;
  const ERROR_CODES = Object.freeze([
    "unknown-method", "not-permitted", "read-only", "not-found", "conflict",
    "invalid", "timeout", "cancelled", "unavailable", "internal",
  ]);

  class BridgeError extends Error {
    constructor(code, message) {
      super(message || code);
      this.name = "BridgeError";
      this.code = ERROR_CODES.includes(code) ? code : "internal";
    }
  }

  const errorPayload = (error) => ({
    code: error instanceof BridgeError ? error.code : (ERROR_CODES.includes(error?.code) ? error.code : "internal"),
    message: String(error?.message || error || "internal"),
  });

  // ---------------------------------------------------------------------------
  // Port endpoint: the request/response/event machinery both modes share.
  // `send(envelope, transfer)` delivers one message to the other side;
  // `dispatch(envelope)` is called for every message that arrives.

  function createEndpoint(send, prefix) {
    let nextId = 0;
    let closed = false;
    const pending = new Map();
    const handlers = new Map();
    const listeners = new Map();

    function settle(id, fn) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      fn(entry);
    }

    function call(method, params = {}, options = {}) {
      if (closed) return Promise.reject(new BridgeError("unavailable", "bridge closed"));
      nextId += 1;
      const id = `${prefix}${nextId}`;
      const timeout = Number.isFinite(options.timeout) ? options.timeout : REQUEST_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(id, (entry) => entry.reject(new BridgeError("timeout", `${method} timed out`))), timeout);
        pending.set(id, { resolve, reject, timer });
        try {
          send({ v: ENVELOPE, id, kind: "request", method, params }, options.transfer || []);
        } catch (error) {
          settle(id, (entry) => entry.reject(new BridgeError("invalid", String(error?.message || error))));
        }
      });
    }

    function emit(method, params = {}, transfer = []) {
      if (closed) return false;
      try {
        send({ v: ENVELOPE, kind: "event", method, params }, transfer);
        return true;
      } catch (error) {
        return false;
      }
    }

    async function answer(message) {
      const handler = handlers.get(message.method);
      if (!handler) {
        send({ v: ENVELOPE, id: message.id, kind: "response", ok: false, error: { code: "unknown-method", message: message.method } }, []);
        return;
      }
      try {
        const result = await handler(message.params || {});
        const transfer = result && result.__transfer ? result.__transfer : [];
        if (result && result.__transfer) delete result.__transfer;
        send({ v: ENVELOPE, id: message.id, kind: "response", ok: true, result: result ?? {} }, transfer);
      } catch (error) {
        send({ v: ENVELOPE, id: message.id, kind: "response", ok: false, error: errorPayload(error) }, []);
      }
    }

    function dispatch(message) {
      if (closed || !message || typeof message !== "object" || message.v !== ENVELOPE) return;
      if (message.kind === "response") {
        settle(message.id, (entry) => {
          if (message.ok) entry.resolve(message.result ?? {});
          else entry.reject(new BridgeError(message.error?.code, message.error?.message));
        });
        return;
      }
      if (message.kind === "request" && typeof message.method === "string") {
        answer(message);
        return;
      }
      if (message.kind === "event" && typeof message.method === "string") {
        (listeners.get(message.method) || []).slice().forEach((listener) => {
          try { listener(message.params || {}); } catch (error) { /* one listener cannot break the others */ }
        });
      }
    }

    function close() {
      closed = true;
      pending.forEach((entry) => {
        clearTimeout(entry.timer);
        entry.reject(new BridgeError("cancelled", "bridge closed"));
      });
      pending.clear();
    }

    return {
      call,
      emit,
      dispatch,
      close,
      handle(method, fn) { handlers.set(method, fn); },
      on(method, fn) {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(fn);
        return () => listeners.set(method, (listeners.get(method) || []).filter((item) => item !== fn));
      },
      get closed() { return closed; },
    };
  }

  // ---------------------------------------------------------------------------
  // Appearance: the desk hands over a closed token list and the kit stylesheet.

  function applyAppearance(appearance) {
    const doc = root.document;
    if (!doc || !appearance) return;
    const html = doc.documentElement;
    html.dataset.colorMode = appearance.colorMode === "dark" ? "dark" : "light";
    html.dataset.touch = appearance.touch ? "true" : "false";
    html.dataset.reducedMotion = appearance.reducedMotion ? "true" : "false";
    if (appearance.id) html.dataset.appearance = String(appearance.id);
    Object.entries(appearance.tokens || {}).forEach(([name, value]) => {
      if (/^--kit-[a-z0-9-]+$/.test(name)) html.style.setProperty(name, String(value));
    });
    // The desk's era fonts: its @font-face rules, nothing else.
    if (Array.isArray(appearance.fontFaces)) {
      let fonts = doc.querySelector("style[data-ais6-fonts]");
      if (!fonts) {
        fonts = doc.createElement("style");
        fonts.dataset.ais6Fonts = "";
        (doc.head || html).appendChild(fonts);
      }
      const faces = appearance.fontFaces.map(String).filter((rule) => /^@font-face\s*\{[^{}]*\}$/.test(rule.trim()));
      if (fonts.textContent !== faces.join("\n")) fonts.textContent = faces.join("\n");
    }
    if (appearance.kitUrl) {
      let link = doc.querySelector("link[data-ais6-kit]");
      if (!link) {
        link = doc.createElement("link");
        link.rel = "stylesheet";
        link.dataset.ais6Kit = "";
        (doc.head || html).appendChild(link);
      }
      if (link.getAttribute("href") !== appearance.kitUrl) link.setAttribute("href", appearance.kitUrl);
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot producers (section 3.7). Both return an ImageBitmap or null and
  // never throw; the desk falls back to its plain effect when nothing arrives.

  function snapshotScale(width, height) {
    const ratio = Math.min(2, Math.max(1, Number(root.devicePixelRatio) || 1));
    return Math.min(ratio, SNAPSHOT_MAX_EDGE / Math.max(width, height, 1));
  }

  // What is on screen: the target's box clipped to the frame's viewport. A
  // page taller than its window is pictured as the window shows it.
  function visibleBox(target) {
    const rect = target.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(root.innerWidth || rect.right, rect.right);
    const bottom = Math.min(root.innerHeight || rect.bottom, rect.bottom);
    return { rect, left, top, width: Math.max(0, Math.round(right - left)), height: Math.max(0, Math.round(bottom - top)) };
  }

  function surfaceFor(width, height) {
    if (typeof root.OffscreenCanvas === "function") return new root.OffscreenCanvas(width, height);
    const canvas = root.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  async function canvasSnapshot(target) {
    try {
      const box = visibleBox(target);
      if (box.width <= 0 || box.height <= 0) return null;
      const scale = snapshotScale(box.width, box.height);
      const width = Math.round(box.width * scale);
      const height = Math.round(box.height * scale);
      const surface = surfaceFor(width, height);
      const ctx = surface.getContext("2d");
      const background = root.getComputedStyle(target).backgroundColor;
      ctx.fillStyle = background && background !== "rgba(0, 0, 0, 0)" ? background : "#fff";
      ctx.fillRect(0, 0, width, height);
      const canvases = target.tagName === "CANVAS" ? [target] : [...target.querySelectorAll("canvas")];
      canvases.forEach((canvas) => {
        const at = canvas.getBoundingClientRect();
        if (at.width <= 0 || at.height <= 0) return;
        ctx.drawImage(canvas, (at.left - box.left) * scale, (at.top - box.top) * scale, at.width * scale, at.height * scale);
      });
      const bitmap = await root.createImageBitmap(surface);
      return { bitmap, width: box.width, height: box.height, scale };
    } catch (error) {
      return null;
    }
  }

  // Painting and layout properties copied onto the clone. Everything a
  // foreignObject cannot reach through the cascade must be on the node itself.
  const DOM_PROPS = [
    "display", "position", "left", "top", "right", "bottom", "z-index", "width", "height",
    "min-width", "min-height", "max-width", "max-height", "box-sizing",
    "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "order",
    "align-items", "align-self", "align-content", "justify-content", "justify-items", "justify-self",
    "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-template-areas",
    "grid-auto-flow", "grid-column", "grid-row", "grid-auto-columns", "grid-auto-rows",
    "background-color", "background-image", "background-size", "background-position", "background-repeat",
    "color", "border-top", "border-right", "border-bottom", "border-left", "border-radius",
    "outline", "outline-offset", "box-shadow", "opacity", "visibility", "overflow-x", "overflow-y", "clip-path",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "font-family", "font-size", "font-weight", "font-style", "font-variant", "line-height",
    "letter-spacing", "text-align", "text-decoration", "text-transform", "text-shadow",
    "white-space", "word-break", "overflow-wrap", "text-overflow", "vertical-align",
    "transform", "transform-origin", "filter", "object-fit", "object-position", "list-style",
    "appearance", "-webkit-appearance", "fill", "stroke", "stroke-width", "color-scheme",
    "-webkit-font-smoothing", "image-rendering",
  ];

  function inlineStyles(live, copy) {
    const cs = root.getComputedStyle(live);
    copy.setAttribute("style", `${DOM_PROPS.map((name) => {
      const value = cs.getPropertyValue(name);
      return value ? `${name}:${value}` : "";
    }).filter(Boolean).join(";")};animation:none;transition:none;`);
    if (live.tagName === "TEXTAREA") copy.textContent = live.value;
    if (live.tagName === "INPUT") {
      copy.setAttribute("value", live.type === "password" ? "" : live.value);
      if (live.checked) copy.setAttribute("checked", ""); else copy.removeAttribute("checked");
    }
    if (live.tagName === "OPTION") {
      if (live.selected) copy.setAttribute("selected", ""); else copy.removeAttribute("selected");
    }
    const liveKids = [...live.children];
    const copyKids = [...copy.children];
    liveKids.forEach((child, index) => { if (copyKids[index]) inlineStyles(child, copyKids[index]); });
    const x = live.scrollLeft || 0;
    const y = live.scrollTop || 0;
    if (x || y) {
      copy.style.setProperty("overflow", "hidden");
      copyKids.forEach((child) => child.style.setProperty("translate", `${-x}px ${-y}px`));
    }
    materializePseudo(live, copy, "::before");
    materializePseudo(live, copy, "::after");
  }

  // ::before and ::after are not in a clone. Drawn controls lean on them (the
  // select harness's arrow), so each becomes a span carrying its computed
  // style and its literal content.
  const NO_PSEUDO = /^(?:INPUT|SELECT|TEXTAREA|OPTION|IMG|CANVAS|IFRAME|VIDEO|AUDIO|BR|HR|svg)$/i;
  function materializePseudo(live, copy, pseudo) {
    if (NO_PSEUDO.test(live.tagName)) return;
    const ps = root.getComputedStyle(live, pseudo);
    const content = ps.getPropertyValue("content");
    if (!content || content === "none" || content === "normal" || ps.getPropertyValue("display") === "none") return;
    const span = root.document.createElement("span");
    span.setAttribute("style", `${DOM_PROPS.map((name) => {
      const value = ps.getPropertyValue(name);
      return value ? `${name}:${value}` : "";
    }).filter(Boolean).join(";")};animation:none;transition:none;`);
    const literal = /^"(.*)"$/.exec(content);
    span.textContent = literal ? literal[1].replace(/\\(.)/g, "$1") : "";
    if (pseudo === "::before") copy.insertBefore(span, copy.firstChild);
    else copy.appendChild(span);
  }

  const dataUrls = new Map();
  function sameOriginDataUrl(url) {
    let absolute;
    try { absolute = new URL(url, root.document.baseURI); } catch (error) { return Promise.resolve(null); }
    if (absolute.origin !== root.location.origin) return Promise.resolve(null);
    if (!dataUrls.has(absolute.href)) {
      dataUrls.set(absolute.href, root.fetch(absolute.href)
        .then((response) => (response.ok ? response.blob() : null))
        .then((blob) => (blob ? new Promise((resolve) => {
          const reader = new root.FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        }) : null))
        .catch(() => null));
    }
    return dataUrls.get(absolute.href);
  }

  async function embedImages(live, copy) {
    const jobs = [];
    const liveArt = [...live.querySelectorAll("img, image, canvas")];
    const copyArt = [...copy.querySelectorAll("img, image, canvas")];
    liveArt.forEach((node, index) => {
      const target = copyArt[index];
      if (!target) return;
      if (node.tagName === "CANVAS") {
        // A canvas clones blank; its pixels travel as an image.
        try {
          const img = root.document.createElement("img");
          img.setAttribute("src", node.toDataURL());
          img.setAttribute("style", target.getAttribute("style") || "");
          target.replaceWith(img);
        } catch (error) { /* a tainted canvas stays blank */ }
        return;
      }
      const raw = node.tagName === "IMG" ? node.currentSrc || node.src : node.getAttribute("href");
      if (!raw || raw.startsWith("data:")) return;
      jobs.push(sameOriginDataUrl(raw).then((data) => {
        if (!data) return;
        if (target.tagName === "IMG") target.setAttribute("src", data);
        else target.setAttribute("href", data);
      }));
    });
    [copy, ...copy.querySelectorAll("*")].forEach((node) => {
      const background = node.style?.getPropertyValue("background-image") || "";
      const urls = [...background.matchAll(/url\("?([^")]+)"?\)/g)].map((match) => match[1]).filter((url) => !url.startsWith("data:"));
      if (!urls.length) return;
      jobs.push(Promise.all(urls.map(sameOriginDataUrl)).then((data) => {
        let next = node.style.getPropertyValue("background-image");
        urls.forEach((url, index) => { if (data[index]) next = next.split(url).join(data[index]); });
        node.style.setProperty("background-image", next);
      }));
    });
    await Promise.race([Promise.all(jobs), new Promise((resolve) => setTimeout(resolve, 600))]);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new root.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed"));
      img.src = url;
    });
  }

  async function domSnapshot(target) {
    try {
      const box = visibleBox(target);
      if (box.width <= 0 || box.height <= 0) return null;
      const { width, height, rect } = box;
      const scale = snapshotScale(width, height);
      const copy = target.cloneNode(true);
      inlineStyles(target, copy);
      copy.querySelectorAll("script, iframe, video, audio, object, embed").forEach((node) => node.remove());
      // The whole target, shifted so the visible part lands in the picture.
      Object.assign(copy.style, {
        position: "absolute", left: `${Math.round(rect.left - box.left)}px`, top: `${Math.round(rect.top - box.top)}px`,
        margin: "0px", transform: "none", translate: "none",
        width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px`, boxSizing: "border-box",
      });
      await embedImages(target, copy);
      const serialized = new root.XMLSerializer().serializeToString(copy);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * scale)}" height="${Math.round(height * scale)}">`
        + `<foreignObject x="0" y="0" width="${width}" height="${height}" transform="scale(${scale})">`
        + `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;">${serialized}</div>`
        + "</foreignObject></svg>";
      // A data: URL, not blob:. Chromium treats a foreignObject SVG loaded from
      // a blob URL as cross-origin and taints the canvas.
      const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      const surface = surfaceFor(Math.round(width * scale), Math.round(height * scale));
      const ctx = surface.getContext("2d");
      const background = root.getComputedStyle(target).backgroundColor;
      ctx.fillStyle = background && background !== "rgba(0, 0, 0, 0)" ? background : "#fff";
      ctx.fillRect(0, 0, surface.width, surface.height);
      ctx.drawImage(img, 0, 0);
      const bitmap = await root.createImageBitmap(surface);
      return { bitmap, width, height, scale };
    } catch (error) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Hosted mode.

  function hostedBridge(port, welcome, options) {
    const endpoint = createEndpoint((message, transfer) => port.postMessage(message, transfer), "a");
    port.onmessage = (event) => endpoint.dispatch(event.data);
    if (typeof port.start === "function") port.start();

    let snapshotConfig = null;
    let snapshotTimer = 0;
    let snapshotObserver = null;
    const granted = new Set(welcome.capabilities || []);

    async function produceSnapshot() {
      if (!snapshotConfig) return null;
      const target = snapshotConfig.target || root.document?.body || null;
      if (typeof snapshotConfig.producer === "function") return snapshotConfig.producer(target);
      if (!target) return null;
      return snapshotConfig.producer === "canvas" ? canvasSnapshot(target) : domSnapshot(target);
    }

    async function sendSnapshot() {
      if (!snapshotConfig || !granted.has("snapshot")) return false;
      const picture = await produceSnapshot();
      if (!picture?.bitmap) return false;
      return endpoint.emit("window.snapshot", picture, [picture.bitmap]);
    }

    function scheduleSnapshot() {
      if (!snapshotConfig || snapshotTimer) return;
      snapshotTimer = setTimeout(() => {
        snapshotTimer = 0;
        const idle = root.requestIdleCallback || ((fn) => setTimeout(fn, 0));
        idle(() => { sendSnapshot(); });
      }, SNAPSHOT_IDLE_MS);
    }

    endpoint.handle("menu.command", () => ({ handled: false }));
    endpoint.handle("lifecycle.suspend", async () => { await sendSnapshot(); return {}; });
    endpoint.handle("lifecycle.resume", () => ({}));
    endpoint.handle("lifecycle.dispose", () => ({}));
    endpoint.handle("intent.deliver", () => ({ ok: false, reason: "no-handler" }));
    endpoint.handle("window.snapshotRequest", async () => {
      const picture = await produceSnapshot();
      if (!picture?.bitmap) throw new BridgeError("unavailable", "no snapshot producer");
      return { ...picture, __transfer: [picture.bitmap] };
    });

    if (options.applyAppearance !== false) {
      applyAppearance(welcome.appearance);
      endpoint.on("appearance.changed", (appearance) => applyAppearance(appearance));
    }

    // Desk shortcuts. A modified key the app did not consume goes to the desk,
    // so ⌘W and the menu shortcuts keep working while the frame has focus.
    const onKeyDown = (event) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return;
      endpoint.emit("input.shortcut", {
        key: event.key, code: event.code,
        metaKey: !!event.metaKey, ctrlKey: !!event.ctrlKey, altKey: !!event.altKey, shiftKey: !!event.shiftKey,
      });
    };
    const onPointerDown = () => endpoint.emit("window.activate", {});
    if (typeof root.addEventListener === "function") {
      root.addEventListener("keydown", onKeyDown);
      root.addEventListener("pointerdown", onPointerDown, true);
    }

    const bridge = {
      standalone: false,
      welcome,
      call: endpoint.call,
      emit: endpoint.emit,
      on: endpoint.on,
      handle: endpoint.handle,
      ready() {
        const sent = endpoint.emit("app.ready", {});
        if (snapshotConfig) setTimeout(() => sendSnapshot(), 0);
        return sent;
      },
      status(params) { return endpoint.emit("app.status", params || {}); },
      menuState(params) { return endpoint.emit("menu.state", params || {}); },
      setTitle(title) { return endpoint.emit("window.setTitle", { title: String(title || "") }); },
      // Snapshots: `producer` is "canvas", "dom" or a function returning
      // { bitmap, width, height, scale }. Pictures are taken off the
      // interaction path: after first paint, on suspend, and at most once a
      // second after a visible change.
      enableSnapshots(config = {}) {
        snapshotConfig = { producer: config.producer || "dom", target: config.target || null };
        const target = snapshotConfig.target || root.document?.body;
        if (target && typeof root.MutationObserver === "function") {
          snapshotObserver?.disconnect();
          snapshotObserver = new root.MutationObserver(scheduleSnapshot);
          snapshotObserver.observe(target, { attributes: true, childList: true, subtree: true, characterData: true });
        }
        return bridge;
      },
      snapshotNow: sendSnapshot,
      close() {
        snapshotObserver?.disconnect();
        clearTimeout(snapshotTimer);
        if (typeof root.removeEventListener === "function") {
          root.removeEventListener("keydown", onKeyDown);
          root.removeEventListener("pointerdown", onPointerDown, true);
        }
        endpoint.close();
        try { port.close(); } catch (error) { /* already closed */ }
      },
    };
    return bridge;
  }

  // ---------------------------------------------------------------------------
  // Standalone adapter: the app's own page, outside any desk.

  function standaloneBridge(options) {
    const appId = String(options.appId || "app");
    const storage = (() => { try { return root.localStorage; } catch (error) { return null; } })();
    const prefix = `ais6:${appId}:`;
    const media = (query) => { try { return !!root.matchMedia?.(query).matches; } catch (error) { return false; } };
    const params = (() => { try { return new URL(root.location.href).searchParams; } catch (error) { return new URLSearchParams(); } })();
    const language = params.get("lang") === "en" || (!params.get("lang") && !/^zh/i.test(root.navigator?.language || "")) ? "en" : "zh";
    const welcome = Object.freeze({
      protocol: PROTOCOL,
      appId,
      window: String(options.window || ""),
      version: String(options.version || ""),
      language,
      appearance: Object.freeze({
        id: "standalone",
        colorMode: media("(prefers-color-scheme: dark)") ? "dark" : "light",
        touch: media("(pointer: coarse)"),
        reducedMotion: media("(prefers-reduced-motion: reduce)"),
        tokens: Object.freeze({}),
        kitUrl: String(options.kitUrl || ""),
      }),
      capabilities: Object.freeze(["state", "files"]),
      readOnly: false,
      profile: "desktop",
      phone: 0,
      launch: null,
      standalone: true,
    });
    const listeners = new Map();
    let fileCount = 0;

    function download(name, mime, body, bytes) {
      const doc = root.document;
      if (!doc) throw new BridgeError("unavailable", "no document");
      const blob = new root.Blob([bytes || String(body ?? "")], { type: mime || "application/octet-stream" });
      const url = root.URL.createObjectURL(blob);
      const link = doc.createElement("a");
      link.href = url;
      link.download = String(name || "download");
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => root.URL.revokeObjectURL(url), 1000);
    }

    const methods = {
      "state.get": ({ key }) => {
        const raw = storage?.getItem(prefix + String(key));
        return { value: raw == null ? null : JSON.parse(raw) };
      },
      "state.set": ({ key, value }) => {
        if (!storage) throw new BridgeError("unavailable", "no storage");
        try { storage.setItem(prefix + String(key), JSON.stringify(value)); } catch (error) { throw new BridgeError("unavailable", "quota"); }
        return {};
      },
      "state.remove": ({ key }) => { storage?.removeItem(prefix + String(key)); return {}; },
      "state.keys": ({ prefix: wanted = "" } = {}) => {
        const keys = [];
        for (let index = 0; storage && index < storage.length; index += 1) {
          const name = storage.key(index);
          if (name?.startsWith(prefix) && name.slice(prefix.length).startsWith(wanted)) keys.push(name.slice(prefix.length));
        }
        return { keys: keys.sort() };
      },
      "files.export": ({ name, mime, body, bytes }) => { download(name, mime, body, bytes); return {}; },
      "files.create": ({ name, body, bytes }) => {
        download(name, "text/plain;charset=utf-8", body, bytes);
        fileCount += 1;
        return { id: `standalone-${fileCount}`, hash: "" };
      },
      // No desk, no desk appearance to visit and no verification gate: the
      // page's own server answers or it does not.
      "appearance.visit": () => ({ theme: null }),
      "access.session": () => ({ profile: "standalone", verified: true }),
      "access.verify": () => ({ verified: true }),
    };

    function call(method, params = {}) {
      const fn = methods[method];
      if (!fn) {
        const known = /^(state|files|receipts|intent|model|menu|window|app|lifecycle|input|appearance|access)\./.test(method);
        return Promise.reject(new BridgeError(known ? "unavailable" : "unknown-method", method));
      }
      try {
        return Promise.resolve(fn(params || {}));
      } catch (error) {
        return Promise.reject(error instanceof BridgeError ? error : new BridgeError("internal", String(error?.message || error)));
      }
    }

    if (options.applyAppearance !== false) applyAppearance(welcome.appearance);

    const bridge = {
      standalone: true,
      welcome,
      call,
      emit: () => true,
      on(method, fn) {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(fn);
        return () => listeners.set(method, (listeners.get(method) || []).filter((item) => item !== fn));
      },
      handle: () => {},
      ready: () => true,
      status: () => true,
      menuState: () => true,
      setTitle(title) { if (root.document) root.document.title = String(title || ""); return true; },
      enableSnapshots: () => bridge,
      snapshotNow: () => Promise.resolve(false),
      close: () => {},
    };
    return bridge;
  }

  // ---------------------------------------------------------------------------
  // connect(): the only entry point.

  function reloadOnceForVersion(appId) {
    const key = `ais6-version-reload:${appId}`;
    try {
      if (root.sessionStorage.getItem(key)) {
        root.sessionStorage.removeItem(key);
        return false;
      }
      root.sessionStorage.setItem(key, "1");
      root.location.reload();
      return true;
    } catch (error) {
      return false;
    }
  }

  function connect(options = {}) {
    const appId = String(options.appId || "");
    const windowName = String(options.window || "");
    const parent = root.parent;
    if (!parent || parent === root) return Promise.resolve(standaloneBridge(options));
    return new Promise((resolve, reject) => {
      let timer = 0;
      const onMessage = (event) => {
        if (event.source !== parent || event.origin !== root.location.origin) return;
        const data = event.data;
        if (!data || (data.ais6 !== "welcome" && data.ais6 !== "refused")) return;
        root.removeEventListener("message", onMessage);
        clearTimeout(timer);
        if (data.ais6 === "refused") {
          reject(new BridgeError(data.code || "not-permitted", data.message || "refused"));
          return;
        }
        const port = event.ports?.[0];
        const welcome = data.welcome;
        if (!port || !welcome) {
          reject(new BridgeError("internal", "welcome without a port"));
          return;
        }
        if (options.version && welcome.version && String(options.version) !== String(welcome.version)) {
          if (reloadOnceForVersion(appId)) return;
          const failed = hostedBridge(port, welcome, { applyAppearance: false });
          failed.status({ host: "fail", key: "version-mismatch" });
          failed.close();
          reject(new BridgeError("invalid", `version ${options.version} is not the pinned ${welcome.version}`));
          return;
        }
        resolve(hostedBridge(port, Object.freeze(welcome), options));
      };
      root.addEventListener("message", onMessage);
      timer = setTimeout(() => {
        root.removeEventListener("message", onMessage);
        reject(new BridgeError("timeout", "no welcome from the desk"));
      }, Number.isFinite(options.timeout) ? options.timeout : HELLO_TIMEOUT_MS);
      parent.postMessage({ ais6: "hello", protocol: PROTOCOL, appId, window: windowName }, root.location.origin);
    });
  }

  root.AIS6Bridge = Object.freeze({
    protocol: PROTOCOL,
    errorCodes: ERROR_CODES,
    BridgeError,
    connect,
    applyAppearance,
    producers: Object.freeze({ canvas: canvasSnapshot, dom: domSnapshot }),
    // Exposed for the desk's host and the contracts: the same envelope
    // machinery on both sides of the port.
    createEndpoint,
  });
})(typeof window !== "undefined" ? window : globalThis);
