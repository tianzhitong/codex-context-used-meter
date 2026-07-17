// Test harness for detectReading priority and conversation switch behavior.
// Simulates a minimal browser environment to verify v107 fixes.

const fs = require("fs");
const path = require("path");

// --- Mock browser environment ---
const eventListeners = {};
const intervals = [];
const timeouts = [];

function makeMockElement(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    style: { setProperty: () => {}, getPropertyValue: () => "" },
    dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    children: [],
    childNodes: [],
    attributes: {},
    hidden: false,
    innerHTML: "",
    textContent: "",
    id: "",
    _parent: null,
    appendChild(child) { child._parent = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    insertBefore(child) { child._parent = this; this.children.push(child); return child; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] || null; },
    hasAttribute(k) { return k in this.attributes; },
    removeAttribute(k) { delete this.attributes[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100, right: 100, bottom: 100 }; },
    cloneNode() { return makeMockElement(this.tagName); },
    contains() { return false; },
    remove() {},
    focus() {},
    blur() {},
  };
  return el;
}

const mockBody = makeMockElement("body");
const mockHtml = makeMockElement("html");
mockHtml.appendChild(mockBody);

global.window = {
  __codexContextMeterInstalled: false,
  __codexContextMeter: null,
  __codexTokenUsage: null,
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener(type, fn) {
    (eventListeners[type] ||= []).push(fn);
  },
  removeEventListener(type, fn) {
    eventListeners[type] = (eventListeners[type] || []).filter((f) => f !== fn);
  },
  setInterval(fn, ms) {
    const id = intervals.length;
    intervals.push({ fn, ms });
    return id;
  },
  clearTimeout() {},
  clearTimeout() {},
  setTimeout(fn, ms) {
    const id = timeouts.length;
    timeouts.push({ fn, ms });
    return id;
  },
  XMLHttpRequest: function () {
    return {
      open: () => {},
      send: () => {},
      addEventListener: () => {},
      setRequestHeader: () => {},
      readyState: 4,
      status: 200,
      responseText: "",
    };
  },
  WebSocket: function () {
    return { addEventListener: () => {}, readyState: 1, send: () => {}, close: () => {} };
  },
  fetch: function () {
    return Promise.resolve({
      clone: () => ({ text: () => Promise.resolve("") }),
      ok: true,
      status: 200,
    });
  },
  performance: {
    getEntriesByType: () => [],
  },
  location: { href: "https://localhost/", pathname: "/" },
  localStorage: {
    _data: {},
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
  },
};

global.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: makeMockElement,
  createTextNode: (text) => ({ textContent: text, _parent: null }),
  body: mockBody,
  documentElement: mockHtml,
  head: makeMockElement("head"),
  readyState: "complete",
  addEventListener: () => {},
  removeEventListener: () => {},
};

global.MutationObserver = class {
  observe() {}
  disconnect() {}
};

global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = () => {};
global.HTMLElement = class {};
global.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
global.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1", getPropertyValue: () => "" });
global.CSSStyleDeclaration = class {};
global.location = { href: "https://localhost/", pathname: "/", search: "", hash: "" };
global.WeakMap = WeakMap;
global.WeakSet = WeakSet;
global.Reflect = Reflect;

// --- Load the script ---
const scriptPath = path.join(__dirname, "..", "codex-context-used-meter.js");
const scriptCode = fs.readFileSync(scriptPath, "utf-8");

try {
  eval(scriptCode);
} catch (e) {
  console.error("FAIL: Script threw on load:", e.message);
  console.error(e.stack);
  process.exit(1);
}

const api = window.__codexContextMeter;
if (!api) {
  console.error("FAIL: window.__codexContextMeter not set after load");
  process.exit(1);
}

console.log("Script loaded, version:", api.version);

let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// Test 1: Script loaded with correct version
assert("script version", api.version === 112, `got ${api.version}`);

// Test 2: diagnose function exists and returns expected shape
assert("diagnose exists", typeof api.diagnose === "function");
assert("isHealthy exists", typeof api.isHealthy === "function");

const diag = api.diagnose();
assert("diagnose has scriptVersion", typeof diag.scriptVersion === "number", `got ${typeof diag.scriptVersion}`);
assert("diagnose has hasScope", typeof diag.hasScope === "boolean");
assert("diagnose has hasModules", typeof diag.hasModules === "boolean");
assert("diagnose has capturedUsage", diag.capturedUsage === null, `got ${JSON.stringify(diag.capturedUsage)}`);
assert("diagnose has lastSeenModel", diag.lastSeenModel === null);
assert("diagnose has webSocketIntercepted", typeof diag.webSocketIntercepted === "boolean");
assert("diagnose has fetchIntercepted", typeof diag.fetchIntercepted === "boolean");

// Test 3: Verify interceptors were installed
assert("WebSocket intercepted", diag.webSocketIntercepted === true);
assert("fetch intercepted", diag.fetchIntercepted === true);

// Test 4: refresh doesn't throw
try {
  api.refresh();
  assert("refresh doesn't throw", true);
} catch (e) {
  assert("refresh doesn't throw", false, e.message);
}

// Test 5: Simulate network-captured usage and verify it shows up
// We need to trigger the message listener with a fake usage payload
const messageListeners = eventListeners["message"] || [];
if (messageListeners.length > 0) {
  const fakeUsage = {
    type: "response.completed",
    response: {
      model: "gpt-5",
      usage: {
        input_tokens: 50000,
        output_tokens: 5000,
        total_tokens: 55000,
      },
    },
  };
  try {
    messageListeners.forEach((fn) => fn({ data: JSON.stringify(fakeUsage), source: window }));
    assert("message listener accepts usage payload", true);
  } catch (e) {
    assert("message listener accepts usage payload", false, e.message);
  }

  // Check if capturedUsage was set
  const diag2 = api.diagnose();
  assert("capturedUsage set after message", diag2.capturedUsage !== null, `got ${JSON.stringify(diag2.capturedUsage)}`);

  if (diag2.capturedUsage) {
    assert("capturedUsage has used", typeof diag2.capturedUsage.used === "number");
    assert("capturedUsage has limit", typeof diag2.capturedUsage.limit === "number");
    // input_tokens (50000) is the correct value for context usage, not total_tokens (55000)
    assert("capturedUsage used is 50000 (input_tokens)", diag2.capturedUsage.used === 50000, `got ${diag2.capturedUsage.used}`);
    assert("capturedUsage limit is 400000 (gpt-5)", diag2.capturedUsage.limit === 400000, `got ${diag2.capturedUsage.limit}`);
    assert("lastSeenModel is gpt-5", diag2.lastSeenModel === "gpt-5", `got ${diag2.lastSeenModel}`);
  }
} else {
  assert("message listener installed", false, "no message listeners found");
}

// Test 6: Simulate API-format usage with model for context window lookup
const fakeApiUsage2 = {
  model: "gpt-4.1",
  usage: {
    input_tokens: 100000,
    output_tokens: 10000,
    total_tokens: 110000,
  },
};
try {
  messageListeners.forEach((fn) => fn({ data: JSON.stringify(fakeApiUsage2), source: window }));
  const diag3 = api.diagnose();
  assert("capturedUsage updated with gpt-4.1", diag3.capturedUsage !== null);
  if (diag3.capturedUsage) {
    assert("gpt-4.1 limit is 1047576", diag3.capturedUsage.limit === 1047576, `got ${diag3.capturedUsage.limit}`);
    assert("lastSeenModel updated to gpt-4.1", diag3.lastSeenModel === "gpt-4.1", `got ${diag3.lastSeenModel}`);
  }
} catch (e) {
  assert("capturedUsage updated with gpt-4.1", false, e.message);
}

// Summary
// Test 7: GLM5.2N model context window
const glmUsage = {
  model: "GLM5.2N",
  usage: {
    input_tokens: 200000,
    output_tokens: 10000,
    total_tokens: 210000,
  },
};
try {
  messageListeners.forEach((fn) => fn({ data: JSON.stringify(glmUsage), source: window }));
  const diag4 = api.diagnose();
  assert("GLM5.2N capturedUsage set", diag4.capturedUsage !== null);
  if (diag4.capturedUsage) {
    assert("GLM5.2N limit is 1048576 (1M)", diag4.capturedUsage.limit === 1048576, `got ${diag4.capturedUsage.limit}`);
    assert("GLM5.2N lastSeenModel is GLM5.2N", diag4.lastSeenModel === "GLM5.2N", `got ${diag4.lastSeenModel}`);
  }
} catch (e) {
  assert("GLM5.2N capturedUsage set", false, e.message);
}

// Test 8: lowercase glm-5.2n variant
const glmUsage2 = {
  model: "glm-5.2n",
  usage: { input_tokens: 50000, total_tokens: 55000 },
};
try {
  messageListeners.forEach((fn) => fn({ data: JSON.stringify(glmUsage2), source: window }));
  const diag5 = api.diagnose();
  assert("glm-5.2n limit is 1048576", diag5.capturedUsage && diag5.capturedUsage.limit === 1048576, `got ${diag5.capturedUsage && diag5.capturedUsage.limit}`);
} catch (e) {
  assert("glm-5.2n limit is 1048576", false, e.message);
}

// Test 9: switching conversations must reset the context meter (v111 fix).
// Captured network usage used to bleed across conversations because the API
// response carries no conversationId, so the captured reading got re-tagged
// with whatever conversation was active at scan time.
const realDateNow = Date.now;
// Start well past any lookup timestamps cached by earlier tests (which used real time),
// so the active-conversation / thread-content lookup caches are treated as stale.
let testClock = realDateNow() + 1000000;
Date.now = () => testClock;

// Simulate the Codex app conversation window so hasThreadContentSurface() is true.
const appLocation = { href: "app://-/index.html", pathname: "/index.html", search: "", hash: "" };
global.location = appLocation;
window.location = appLocation;

// Rich mock element whose querySelector returns a child for any selector,
// so ensureRoot/bindRootElements can wire up the render surface.
function richMock(tag) {
  const el = makeMockElement(tag);
  el.nodeType = Node.ELEMENT_NODE;
  el.isConnected = true;
  el.querySelector = () => richMock("div");
  el.querySelectorAll = () => [];
  return el;
}

let activeThreadId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const sidebarEl = richMock("div");
sidebarEl.getAttribute = (k) => k === "data-app-action-sidebar-thread-id" ? activeThreadId : null;
sidebarEl.parentElement = null;
const mainEl = richMock("main");

const origQuerySelector = document.querySelector;
const origGetElementById = document.getElementById;
const origCreateElement = document.createElement;
document.querySelector = function (selector) {
  if (selector === "main") return mainEl;
  if (/aria-current|aria-selected|thread-active/.test(selector)) return sidebarEl;
  return null;
};
document.getElementById = function () { return null; };
document.createElement = function (tag) { return richMock(tag); };

try {
  // Step 1: activate conversation A.
  testClock += 1000;
  api.refresh();
  assert("active conversation is A", api.getState().activeConversationId === activeThreadId, `got ${api.getState().activeConversationId}`);

  // Step 2: capture usage while A is active.
  const usageA = { model: "gpt-5", usage: { input_tokens: 50000, total_tokens: 55000 } };
  messageListeners.forEach((fn) => fn({ data: JSON.stringify(usageA), source: window }));
  const diagA = api.diagnose();
  assert("captured usage associated with A", diagA.capturedUsageConversationId === activeThreadId, `got ${diagA.capturedUsageConversationId}`);

  // Step 3: refresh shows A's reading.
  testClock += 1000;
  api.refresh();
  const diagA2 = api.diagnose();
  assert("lastReading reflects A usage", diagA2.lastReading && diagA2.lastReading.used === 50000, `got ${JSON.stringify(diagA2.lastReading && diagA2.lastReading.used)}`);

  // Step 4: switch to conversation B — meter must reset, not bleed A's reading.
  activeThreadId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  sidebarEl.getAttribute = (k) => k === "data-app-action-sidebar-thread-id" ? activeThreadId : null;
  testClock += 1000;
  api.refresh();
  const diagB = api.diagnose();
  assert("switched active conversation is B", api.getState().activeConversationId === activeThreadId, `got ${api.getState().activeConversationId}`);
  assert("lastReading reset after switch (no bleed)", !diagB.lastReading || diagB.lastReading.used !== 50000, `got ${JSON.stringify(diagB.lastReading && diagB.lastReading.used)}`);

  // Step 5: switching back to A still shows A's captured reading.
  activeThreadId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  sidebarEl.getAttribute = (k) => k === "data-app-action-sidebar-thread-id" ? activeThreadId : null;
  testClock += 1000;
  api.refresh();
  const diagA3 = api.diagnose();
  assert("lastReading shows A usage after switching back", diagA3.lastReading && diagA3.lastReading.used === 50000, `got ${JSON.stringify(diagA3.lastReading && diagA3.lastReading.used)}`);
} catch (e) {
  assert("conversation switch test ran without throwing", false, e.stack || e.message);
} finally {
  Date.now = realDateNow;
  document.querySelector = origQuerySelector;
  document.getElementById = origGetElementById;
  document.createElement = origCreateElement;
}

// Re-print summary
console.log(`\n${passed} passed, ${failed} failed`);
// Test 10: XHR interception is installed (v112).
assert("diagnose has xhrIntercepted", typeof api.diagnose().xhrIntercepted === "boolean");
assert("XHR intercepted", api.diagnose().xhrIntercepted === true);

// Test 11: SSE stream fragment parsing (v112).
// A streaming response sends usage in `data:` lines; the merged extractor
// should parse each fragment and capture the usage.
const ssePayload = [
  'data: {"type":"response.output_text.delta","delta":"hello"}',
  '',
  'data: {"type":"response.completed","response":{"model":"gpt-5","usage":{"input_tokens":80000,"output_tokens":8000,"total_tokens":88000}}}',
  'data: [DONE]',
  ''
].join("\n");
try {
  messageListeners.forEach((fn) => fn({ data: ssePayload, source: window }));
  const diagSse = api.diagnose();
  assert("SSE: capturedUsage set", diagSse.capturedUsage !== null);
  if (diagSse.capturedUsage) {
    assert("SSE: used is 80000 (input_tokens)", diagSse.capturedUsage.used === 80000, `got ${diagSse.capturedUsage.used}`);
    assert("SSE: limit is 400000 (gpt-5)", diagSse.capturedUsage.limit === 400000, `got ${diagSse.capturedUsage.limit}`);
    assert("SSE: lastSeenModel is gpt-5", diagSse.lastSeenModel === "gpt-5", `got ${diagSse.lastSeenModel}`);
  }
} catch (e) {
  assert("SSE parsing ran without throwing", false, e.message);
}

// Test 12: Cached token fields are captured in the normalized usage (v112).
// Anthropic-style response with cached_tokens.
const cachedUsage = {
  model: "gpt-5",
  usage: {
    input_tokens: 30000,
    output_tokens: 3000,
    total_tokens: 33000,
    cached_tokens: 20000,
  },
};
try {
  messageListeners.forEach((fn) => fn({ data: JSON.stringify(cachedUsage), source: window }));
  const diagCached = api.diagnose();
  assert("cached: capturedUsage set", diagCached.capturedUsage !== null);
  if (diagCached.capturedUsage) {
    assert("cached: used is 30000 (input_tokens, not total)", diagCached.capturedUsage.used === 30000, `got ${diagCached.capturedUsage.used}`);
  }
} catch (e) {
  assert("cached token test ran without throwing", false, e.message);
}
