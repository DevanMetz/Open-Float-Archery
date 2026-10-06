// Guide tab: renders the docs/ folder tree (from the generated docs/index.json)
// as a collapsible sidebar, fetches the selected Markdown page at runtime, and
// renders it with a small dependency-free Markdown converter. Pages are
// deep-linkable via the URL hash (`#/guide/<pageId>`) so individual guides can
// be shared. Regenerate the index with `python tools/build_docs_index.py`.

const HASH_PREFIX = "#/guide/";
const APP_URL = new URL("../../", import.meta.url);
const INDEX_URL = new URL("docs/index.json", APP_URL);

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(text) {
  return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function guideHash(id, anchor = "") {
  return HASH_PREFIX + id.split("/").map(encodeURIComponent).join("/") + anchor;
}

// Build HTML once per token: generated tags and literal code must not be
// interpreted again as Markdown. Raw HTML stays text.
function renderInline(text, options) {
  const tokens = /`([^`]+)`|(!?)\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let out = "", end = 0;
  for (const match of text.matchAll(tokens)) {
    out += escapeHtml(text.slice(end, match.index));
    end = match.index + match[0].length;
    const [, code, image, label, destination, bold] = match;
    if (code !== undefined) {
      out += `<code>${escapeHtml(code)}</code>`;
    } else if (bold !== undefined) {
      out += `<strong>${renderInline(bold, options)}</strong>`;
    } else {
      let url;
      try { url = new URL(destination.trim(), options.pageUrl); } catch (_) {}
      if (!url || !["http:", "https:"].includes(url.protocol)) {
        out += escapeHtml(label);
      } else if (image) {
        out += `<img src="${escapeAttribute(url.href)}" alt="${escapeAttribute(label)}" loading="lazy" decoding="async">`;
      } else {
        const pageId = !url.search && options.pages?.get(url.origin + url.pathname);
        const href = pageId ? guideHash(pageId, url.hash) : url.href;
        const external = pageId ? "" : ' target="_blank" rel="noopener noreferrer"';
        out += `<a href="${escapeAttribute(href)}"${external}>${renderInline(label, options)}</a>`;
      }
    }
  }
  return out + escapeHtml(text.slice(end));
}

// Minimal block-level Markdown -> HTML. Supports headings, fenced code blocks,
// blockquotes, ordered/unordered lists, horizontal rules, paragraphs, links,
// and images - the subset used by the guide content in docs/.
export function renderMarkdown(md, options = {}) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const headingIds = new Set();
  let i = 0;

  const flushList = (buffer, ordered) => {
    if (!buffer.length) return;
    const tag = ordered ? "ol" : "ul";
    html.push(`<${tag}>`);
    buffer.forEach((item) => html.push(`<li>${renderInline(item, options)}</li>`));
    html.push(`</${tag}>`);
    buffer.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(escapeHtml(lines[i]));
        i += 1;
      }
      i += 1; // consume closing fence
      html.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      html.push("<hr>");
      i += 1;
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const slug = heading[2].trim().toLowerCase()
        .replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/\s+/g, "-") || "section";
      let id = slug, suffix = 0;
      while (headingIds.has(id)) id = `${slug}-${++suffix}`;
      headingIds.add(id);
      html.push(`<h${level} id="${escapeAttribute(id)}">${renderInline(heading[2], options)}</h${level}>`);
      i += 1;
      continue;
    }

    // Blockquote (one or more consecutive lines)
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      html.push(`<blockquote>${renderInline(quote.join(" "), options)}</blockquote>`);
      continue;
    }

    // A line that starts a new block, so it cannot be a lazy list continuation.
    const startsBlock = (l) =>
      /^\s*$/.test(l) ||
      /^```/.test(l) ||
      /^(#{1,4})\s+/.test(l) ||
      /^---+\s*$/.test(l) ||
      /^>\s?/.test(l) ||
      /^[-*]\s+/.test(l) ||
      /^\d+\.\s+/.test(l);

    // Collect a list, folding wrapped (lazily-continued) lines into each item.
    const collectList = (marker) => {
      const buffer = [];
      while (i < lines.length && marker.test(lines[i])) {
        let item = lines[i].replace(marker, "");
        i += 1;
        while (i < lines.length && !startsBlock(lines[i])) {
          item += ` ${lines[i].trim()}`;
          i += 1;
        }
        buffer.push(item);
      }
      return buffer;
    };

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      flushList(collectList(/^[-*]\s+/), false);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      flushList(collectList(/^\d+\.\s+/), true);
      continue;
    }

    // Blank line
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-special lines
    const para = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${renderInline(para.join(" "), options)}</p>`);
  }

  return html.join("\n");
}

// Preferred default landing pages, in priority order, when one exists.
const HOME_IDS = ["quick-start", "home", "index", "readme"];

// Walk the index tree, collecting file nodes into an id -> node lookup and
// recording the first file (a fallback default page).
function indexFiles(tree, map, firstRef) {
  tree.forEach((node) => {
    if (node.type === "folder") {
      indexFiles(node.children || [], map, firstRef);
    } else if (node.type === "file") {
      map.set(node.id, node);
      if (!firstRef.id) firstRef.id = node.id;
    }
  });
}

// Pick a sensible home page: a known home id if present, else the first file.
function chooseDefault(pages, firstRef) {
  for (const id of HOME_IDS) {
    if (pages.has(id)) return id;
  }
  return firstRef.id;
}

export function mountGuide({ sidebar, content, header }) {
  if (!sidebar || !content) return null;

  const pages = new Map();
  const pageByUrl = new Map();
  const linkById = new Map();
  const firstRef = { id: null };
  let defaultId = null;
  let activeId = null;
  let activeAnchor = "";
  let ready = false;
  let pageRequest = 0;
  let loadingIndex = null;
  const fetchCache = new Map();

  function highlight(id) {
    linkById.forEach((link, pageId) => {
      link.classList.toggle("active", pageId === id);
    });
  }

  function scrollPage(anchor) {
    let target = content;
    if (anchor) {
      const heading = [...content.querySelectorAll("[id]")].find((node) => node.id === anchor);
      if (heading) target = heading;
    }
    // The sticky header wraps on smaller screens; use its current height so
    // section links and the sidebar stay readable at every viewport width.
    const offset = `${(header?.getBoundingClientRect().height || 0) + 12}px`;
    sidebar.style.top = offset;
    target.style.scrollMarginTop = offset;
    if (target === content) content.scrollTop = 0;
    target.scrollIntoView({ block: "start" });
  }

  async function loadPage(id, anchor = "") {
    const page = pages.get(id) || pages.get(defaultId);
    if (!page) return;
    activeAnchor = anchor;
    if (page.id === activeId) {
      if (fetchCache.has(page.id) && anchor) scrollPage(anchor);
      return;
    }
    const request = ++pageRequest;
    activeId = page.id;
    highlight(page.id);

    if (fetchCache.has(page.id)) {
      content.innerHTML = fetchCache.get(page.id);
      scrollPage(activeAnchor);
      return;
    }

    content.innerHTML = '<p class="guide-loading">Loading…</p>';
    try {
      const pageUrl = new URL(page.path, APP_URL);
      const res = await fetch(pageUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const md = await res.text();
      const rendered = renderMarkdown(md, { pageUrl, pages: pageByUrl });
      fetchCache.set(page.id, rendered);
      if (request !== pageRequest) return;
      content.innerHTML = rendered;
      scrollPage(activeAnchor);
    } catch (err) {
      if (request !== pageRequest) return;
      activeId = null;
      content.innerHTML = `<p class="guide-error">Could not load this guide (${escapeHtml(
        String(err.message || err),
      )}). Open Guide again to retry.</p>`;
    }
  }

  // Recursively render folder/file nodes into a container element.
  function renderTree(nodes, container, depth) {
    nodes.forEach((node) => {
      if (node.type === "folder") {
        const group = document.createElement("div");
        group.className = "guide-nav-group";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "guide-nav-folder";
        toggle.style.paddingLeft = `${8 + depth * 12}px`;
        toggle.innerHTML = `<span class="guide-folder-caret">▾</span><span>${escapeHtml(
          node.name,
        )}</span>`;

        const childWrap = document.createElement("div");
        childWrap.className = "guide-nav-children";

        toggle.addEventListener("click", () => {
          const collapsed = group.classList.toggle("collapsed");
          childWrap.style.display = collapsed ? "none" : "";
        });

        group.appendChild(toggle);
        group.appendChild(childWrap);
        container.appendChild(group);
        renderTree(node.children || [], childWrap, depth + 1);
      } else if (node.type === "file") {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "guide-nav-link";
        link.style.paddingLeft = `${10 + depth * 12}px`;
        link.textContent = node.name;
        link.addEventListener("click", () => {
          window.location.hash = guideHash(node.id);
          loadPage(node.id);
        });
        container.appendChild(link);
        linkById.set(node.id, link);
      }
    });
  }

  // Open the page named in the URL hash, if any.
  function pageIdFromHash() {
    const hash = window.location.hash || "";
    if (hash.startsWith(HASH_PREFIX)) {
      const [id, anchor = ""] = hash.slice(HASH_PREFIX.length).split("#");
      try { return { id: decodeURIComponent(id), anchor: decodeURIComponent(anchor) }; }
      catch (_) { return null; }
    }
    return null;
  }

  // Fetch the generated index and build the sidebar tree.
  function loadIndex() {
    if (ready) return Promise.resolve();
    if (loadingIndex) return loadingIndex;
    loadingIndex = (async () => {
      sidebar.innerHTML = '<p class="guide-loading">Loading…</p>';
      try {
        const res = await fetch(INDEX_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const tree = data.tree || [];
        pages.clear();
        linkById.clear();
        pageByUrl.clear();
        firstRef.id = null;
        indexFiles(tree, pages, firstRef);
        pages.forEach((page) => {
          pageByUrl.set(new URL(page.path, APP_URL).href, page.id);
        });
        defaultId = chooseDefault(pages, firstRef);
        sidebar.innerHTML = "";
        renderTree(tree, sidebar, 0);
        ready = true;
      } catch (err) {
        sidebar.innerHTML = `<p class="guide-error">Could not load the guide index (${escapeHtml(
          String(err.message || err),
        )}). Open Guide again to retry.</p>`;
      }
    })().finally(() => { loadingIndex = null; });
    return loadingIndex;
  }
  loadIndex();

  async function show() {
    await loadIndex();
    if (!ready) return;
    const target = pageIdFromHash();
    return loadPage(target?.id || activeId || defaultId, target?.anchor);
  }

  return {
    // Called when the Guide tab becomes visible.
    show,
    hasHashTarget() {
      return Boolean(pageIdFromHash());
    },
  };
}
