import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderMarkdown, mountGuide } from "../app/ui/guide.js";

const pageUrl = "https://example.com/openfloat/docs/feature-status.md";
const pages = new Map([
  [pageUrl, "feature-status"],
  ["https://example.com/openfloat/docs/quick-start.md", "quick-start"],
  ["https://example.com/openfloat/docs/reference/ble-commands.md", "reference/ble-commands"],
]);
const render = (md) => renderMarkdown(md, { pageUrl, pages });

test("guide images resolve from their Markdown page and keep alt text as text", () => {
  const html = render('![Dashboard "preview" <safe>](images/dashboard-live.png)');
  assert.match(html, /<img /);
  assert.match(html, /src="https:\/\/example.com\/openfloat\/docs\/images\/dashboard-live.png"/);
  assert.match(html, /alt="Dashboard &quot;preview&quot; &lt;safe&gt;"/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("indexed Markdown links stay in the guide while other files resolve relative to the document", () => {
  const html = render('[Quick Start](quick-start.md) [BLE](reference/ble-commands.md) [Blueprint](../Blueprint.md)');
  assert.match(html, /href="#\/guide\/quick-start"/);
  assert.match(html, /href="#\/guide\/reference\/ble-commands"/);
  assert.match(html, /href="https:\/\/example.com\/openfloat\/Blueprint.md" target="_blank" rel="noopener noreferrer"/);
  assert.match(render('[Download](quick-start.md?download=1)'), /href="https:\/\/example.com\/openfloat\/docs\/quick-start.md\?download=1"/);
});

test("section links keep their destination and headings receive stable unique anchors", () => {
  const html = render('[Setup](quick-start.md#7-connect-over-bluetooth)\n\n## 7. Connect over Bluetooth\n\n## 7. Connect over Bluetooth');
  assert.match(html, /href="#\/guide\/quick-start#7-connect-over-bluetooth"/);
  assert.match(html, /<h2 id="7-connect-over-bluetooth">/);
  assert.match(html, /<h2 id="7-connect-over-bluetooth-1">/);
  assert.match(render('[This section](#setup)'), /href="#\/guide\/feature-status#setup"/);
  const ids = [...render("# A\n\n# A\n\n# A-1").matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, 3);
});

test("inline code is literal and formatting inside link labels stays readable", () => {
  const html = render('`[example](quick-start.md)` [**Quick Start**](quick-start.md)');
  assert.match(html, /<code>\[example\]\(quick-start.md\)<\/code>/);
  assert.match(html, /<a href="#\/guide\/quick-start"><strong>Quick Start<\/strong><\/a>/);
});

test("guide content cannot introduce executable URL schemes or HTML attributes", () => {
  for (const destination of ['javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>', 'file:///C:/private.txt']) {
    const html = render(`[Unsafe](${destination}) ![Unsafe](${destination})`);
    assert.doesNotMatch(html, /href=|src=/, destination);
  }
  const html = render('[Quoted](https://example.com/?q="&value=<tag>) <script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>|<tag>|href="[^"]*"&/);
  assert.match(html, /&amp;value=/);
});

test("links in the shipped guides resolve without losing their existing block formatting", () => {
  const quick = renderMarkdown(readFileSync(new URL("../docs/quick-start.md", import.meta.url), "utf8"), {
    pageUrl: "https://example.com/openfloat/docs/quick-start.md", pages,
  });
  assert.match(quick, /src="https:\/\/example.com\/openfloat\/docs\/images\/dashboard-live.png"/);
  assert.match(quick, /href="https:\/\/example.com\/openfloat\/firmware\/BUILDING.md"/);
  assert.match(quick, /<pre><code>/);
  assert.match(quick, /<ol>/);
  const feature = render(readFileSync(new URL("../docs/feature-status.md", import.meta.url), "utf8"));
  assert.match(feature, /href="#\/guide\/quick-start"/);
  assert.match(feature, /href="#\/guide\/reference\/ble-commands"/);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function guideFixture(t, indexFailures = 0) {
  const scrolled = [];
  function element() {
    const classes = new Set();
    return {
      innerHTML: "", style: {}, children: [], events: {},
      classList: { toggle(name, force) {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      } },
      appendChild(child) { this.children.push(child); },
      addEventListener(type, callback) { this.events[type] = callback; },
      scrollIntoView() {},
      querySelectorAll() {
        return [...this.innerHTML.matchAll(/ id="([^"]+)"/g)].map((match) => ({
          id: match[1], style: {}, scrollIntoView: () => scrolled.push(match[1]),
        }));
      },
    };
  }
  const location = { hash: "" };
  for (const [key, value] of Object.entries({ window: { location }, document: { createElement: element } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const waiting = new Map(), calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith("/docs/index.json")) {
      if (indexFailures-- > 0) throw new Error("Offline");
      return new Response(JSON.stringify({ tree: [
        { type: "file", id: "quick-start", path: "docs/quick-start.md", name: "Quick Start" },
        { type: "file", id: "feature-status", path: "docs/feature-status.md", name: "Feature Status" },
      ] }));
    }
    const id = path.endsWith("quick-start.md") ? "quick-start" : "feature-status";
    return new Promise((resolve, reject) => waiting.set(id, { resolve: (body) => resolve(new Response(body)), reject }));
  });
  const sidebar = element(), content = element();
  const guide = mountGuide({ sidebar, content });
  return { guide, sidebar, content, location, waiting, calls, scrolled };
}

for (const failOld of [false, true]) {
  test(`an older guide ${failOld ? "failure" : "response"} cannot replace the newest selection`, async (t) => {
    const f = guideFixture(t);
    const first = f.guide.show();
    await flush();
    f.location.hash = "#/guide/feature-status";
    const latest = f.guide.show();
    await flush();
    f.waiting.get("feature-status").resolve("# Feature Status");
    await latest;
    if (failOld) f.waiting.get("quick-start").reject(new Error("Old request failed"));
    else f.waiting.get("quick-start").resolve("# Quick Start");
    await first;
    assert.ok(f.content.innerHTML.includes("Feature Status"));
    assert.ok(!f.content.innerHTML.includes("Quick Start") && !f.content.innerHTML.includes("guide-error"));
  });
}

test("a cached guide selection cancels a different pending page without another fetch", async (t) => {
  const f = guideFixture(t);
  const first = f.guide.show();
  await flush();
  f.waiting.get("quick-start").resolve("# Quick Start");
  await first;
  f.location.hash = "#/guide/feature-status";
  const pending = f.guide.show();
  await flush();
  f.location.hash = "#/guide/quick-start";
  await f.guide.show();
  f.waiting.get("feature-status").resolve("# Feature Status");
  await pending;
  assert.ok(f.content.innerHTML.includes("Quick Start"));
  assert.equal(f.calls.filter((path) => path.endsWith("quick-start.md")).length, 1);
});

test("an anchor chosen during a pending page load is applied after rendering", async (t) => {
  const f = guideFixture(t);
  const first = f.guide.show();
  await flush();
  f.location.hash = "#/guide/quick-start#connect-sensor";
  await f.guide.show();
  f.waiting.get("quick-start").resolve("# Quick Start\n\n## Connect sensor");
  await first;
  assert.deepEqual(f.scrolled, ["connect-sensor"]);
  f.location.hash = "#/guide/quick-start#quick-start";
  await f.guide.show();
  assert.deepEqual(f.scrolled, ["connect-sensor", "quick-start"]);
});

test("failed guide indexes and page loads can be retried by reopening Guide", async (t) => {
  const f = guideFixture(t, 1);
  await flush();
  assert.ok(f.sidebar.innerHTML.includes("retry"));
  const first = f.guide.show();
  await flush();
  f.waiting.get("quick-start").reject(new Error("Page offline"));
  await first;
  assert.ok(f.content.innerHTML.includes("guide-error"));
  const retry = f.guide.show();
  await flush();
  f.waiting.get("quick-start").resolve("# Quick Start");
  await retry;
  assert.ok(f.content.innerHTML.includes("Quick Start"));
  assert.equal(f.calls.filter((path) => path.endsWith("index.json")).length, 2);
  assert.equal(f.calls.filter((path) => path.endsWith("quick-start.md")).length, 2);
});
