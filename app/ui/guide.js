// Guide tab: renders the docs/ folder tree (from the generated docs/index.json)
// as a collapsible sidebar, fetches the selected Markdown page at runtime, and
// renders it with a small dependency-free Markdown converter. Pages are
// deep-linkable via the URL hash (`#/guide/<pageId>`) so individual guides can
// be shared. Regenerate the index with `python tools/build_docs_index.py`.

const HASH_PREFIX = "#/guide/";
const INDEX_URL = "docs/index.json";

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Inline formatting applied to already-HTML-escaped text: `code`, **bold**,
// and [label](url) links.
function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  return out;
}

// Minimal block-level Markdown -> HTML. Supports headings, fenced code blocks,
// blockquotes, ordered/unordered lists, horizontal rules, and paragraphs —
// the subset used by the guide content in docs/.
function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;

  const flushList = (buffer, ordered) => {
    if (!buffer.length) return;
    const tag = ordered ? "ol" : "ul";
    html.push(`<${tag}>`);
    buffer.forEach((item) => html.push(`<li>${renderInline(item)}</li>`));
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
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
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
      html.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
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
    html.push(`<p>${renderInline(para.join(" "))}</p>`);
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

export function mountGuide({ sidebar, content }) {
  if (!sidebar || !content) return null;

  const pages = new Map();
  const linkById = new Map();
  const firstRef = { id: null };
  let defaultId = null;
  let activeId = null;
  let ready = false;
  const fetchCache = new Map();

  function highlight(id) {
    linkById.forEach((link, pageId) => {
      link.classList.toggle("active", pageId === id);
    });
  }

  async function loadPage(id) {
    const page = pages.get(id) || pages.get(defaultId);
    if (!page) return;
    if (page.id === activeId) return;
    activeId = page.id;
    highlight(page.id);

    if (fetchCache.has(page.id)) {
      content.innerHTML = fetchCache.get(page.id);
      content.scrollTop = 0;
      return;
    }

    content.innerHTML = '<p class="guide-loading">Loading…</p>';
    try {
      const res = await fetch(page.path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const md = await res.text();
      const rendered = renderMarkdown(md);
      fetchCache.set(page.id, rendered);
      content.innerHTML = rendered;
      content.scrollTop = 0;
    } catch (err) {
      activeId = null;
      content.innerHTML = `<p class="guide-error">Could not load this guide (${escapeHtml(
        String(err.message || err),
      )}).</p>`;
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
          window.location.hash = `${HASH_PREFIX}${node.id}`;
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
      return hash.slice(HASH_PREFIX.length);
    }
    return null;
  }

  // Fetch the generated index and build the sidebar tree.
  const loaded = (async () => {
    sidebar.innerHTML = '<p class="guide-loading">Loading…</p>';
    try {
      const res = await fetch(INDEX_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const tree = data.tree || [];
      indexFiles(tree, pages, firstRef);
      defaultId = chooseDefault(pages, firstRef);
      sidebar.innerHTML = "";
      renderTree(tree, sidebar, 0);
      ready = true;
    } catch (err) {
      sidebar.innerHTML = `<p class="guide-error">Could not load the guide index (${escapeHtml(
        String(err.message || err),
      )}). Run <code>python tools/build_docs_index.py</code>.</p>`;
    }
  })();

  async function show() {
    await loaded;
    if (!ready) return;
    loadPage(pageIdFromHash() || activeId || defaultId);
  }

  return {
    // Called when the Guide tab becomes visible.
    show,
    hasHashTarget() {
      return Boolean(pageIdFromHash());
    },
  };
}
