export const SUPPORTED_LOCALES = ["en-US", "pt-BR"];
export const DEFAULT_LOCALE = "en-US";
const LOCALE_STORAGE_KEY = "openfloat_locale";
const textSources = new WeakMap();
const attributeSources = new WeakMap();
let activeMessages = {};
let translationObserver = null;

export function getActiveMessages() {
  return activeMessages;
}

export function getSavedLocale(storage) {
  const savedLocale = storage.getItem(LOCALE_STORAGE_KEY);
  return SUPPORTED_LOCALES.includes(savedLocale) ? savedLocale : DEFAULT_LOCALE;
}

export function saveLocalePreference(locale, storage) {
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw new RangeError(`Unsupported locale preference: ${locale}`);
  }
  storage.setItem(LOCALE_STORAGE_KEY, locale);
}

function notifyLocaleChanged(locale, messages) {
  window.dispatchEvent(new CustomEvent("openfloat-locale-changed", {
    detail: { locale, messages },
  }));
}

function sourceText(node) {
  const current = node.nodeValue;
  const source = textSources.get(node);
  if (!source) {
    textSources.set(node, { value: current, rendered: current });
    return current;
  }
  if (current !== source.rendered) {
    source.value = current;
    source.rendered = current;
  }
  return source.value;
}

export function translateMessage(source, messages = activeMessages) {
  const phrase = source.trim();
  if (!phrase) return source;
  let translated = messages._text?.[phrase];
  if (typeof translated !== "string") {
    for (const entry of messages._patterns || []) {
      try {
        const match = phrase.match(new RegExp(entry.pattern));
        if (match) {
          translated = entry.replacement
            .replace(/\$t(\d+)/g, (_, index) => {
              const captured = match[Number(index)] || "";
              return translateMessage(captured, messages);
            })
            .replace(/\$(\d+)/g, (_, index) => match[Number(index)] || "");
          break;
        }
      } catch (error) {
        console.error("Invalid translation pattern:", error);
      }
    }
  }
  if (typeof translated !== "string") return source;
  const prefix = source.match(/^\s*/)?.[0] || "";
  const suffix = source.match(/\s*$/)?.[0] || "";
  return `${prefix}${translated}${suffix}`;
}

function translateTree(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const source = sourceText(node);
    const translated = translateMessage(source);
    if (node.nodeValue !== translated) node.nodeValue = translated;
    textSources.get(node).rendered = translated;
  }
  const attributeSelector = "[title], [aria-label], [placeholder]";
  const attributeElements = root.nodeType === Node.ELEMENT_NODE && root.matches(attributeSelector)
    ? [root, ...root.querySelectorAll(attributeSelector)]
    : root.querySelectorAll?.(attributeSelector) || [];
  attributeElements.forEach((element) => {
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      if (!element.hasAttribute(attribute)) continue;
      let sources = attributeSources.get(element);
      if (!sources) {
        sources = new Map();
        attributeSources.set(element, sources);
      }
      let source = sources.get(attribute);
      const current = element.getAttribute(attribute);
      if (!source) {
        source = { value: current, rendered: current };
        sources.set(attribute, source);
      } else if (current !== source.rendered) {
        source.value = current;
        source.rendered = current;
      }
      const translated = translateMessage(source.value);
      if (typeof translated === "string" && element.getAttribute(attribute) !== translated) {
        element.setAttribute(attribute, translated);
      }
      source.rendered = translated;
    }
  });
  const i18nSelector = "[data-i18n], [data-i18n-title], [data-i18n-aria-label]";
  const i18nElements = root.nodeType === Node.ELEMENT_NODE && root.matches(i18nSelector)
    ? [root, ...root.querySelectorAll(i18nSelector)]
    : root.querySelectorAll?.(i18nSelector) || [];
  i18nElements.forEach((element) => {
    const message = element.dataset.i18n && activeMessages[element.dataset.i18n];
    if (message && element.textContent !== message) element.textContent = message;
    const title = element.dataset.i18nTitle && activeMessages[element.dataset.i18nTitle];
    if (title) {
      if (element.tagName === "TITLE") {
        if (document.title !== title) document.title = title;
        if (element.textContent !== title) element.textContent = title;
      } else if (element.title !== title) element.title = title;
    }
    const label = element.dataset.i18nAriaLabel && activeMessages[element.dataset.i18nAriaLabel];
    if (label && element.getAttribute("aria-label") !== label) element.setAttribute("aria-label", label);
  });
}

export async function fetchLocale(locale = DEFAULT_LOCALE) {
  const safeLocale = SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const response = await fetch(`./locales/${safeLocale}.json`);
  if (!response.ok) throw new Error(`Could not load locale ${safeLocale}: ${response.status}`);
  return { locale: safeLocale, messages: await response.json() };
}

export function applyLocale(messages, root = document) {
  activeMessages = messages;
  if (root === document) document.documentElement.lang = messages.locale || document.documentElement.lang;
  translateTree(root);
  if (root === document && !translationObserver) {
    translationObserver = new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === "characterData") translateTree(change.target.parentElement || document);
        else if (change.type === "attributes") translateTree(change.target);
        else change.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) translateTree(node);
          else if (node.nodeType === Node.TEXT_NODE) {
            const translated = translateMessage(sourceText(node));
            if (node.nodeValue !== translated) node.nodeValue = translated;
            textSources.get(node).rendered = translated;
          }
        });
      }
    });
    translationObserver.observe(document.body, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["title", "aria-label", "placeholder"],
      subtree: true,
    });
  }
}

export async function initLocalization(select) {
  let locale = DEFAULT_LOCALE;
  try {
    locale = getSavedLocale(localStorage);
  } catch (error) {
    console.error("Could not read saved language preference:", error);
  }
  try {
    const loaded = await fetchLocale(locale);
    locale = loaded.locale;
    applyLocale(loaded.messages);
    notifyLocaleChanged(locale, loaded.messages);
  } catch (error) {
    console.error("Failed to load selected language:", error);
    try {
      const fallback = await fetchLocale(DEFAULT_LOCALE);
      locale = DEFAULT_LOCALE;
      applyLocale(fallback.messages);
      notifyLocaleChanged(locale, fallback.messages);
    } catch (fallbackError) {
      console.error("Failed to load default language:", fallbackError);
      locale = DEFAULT_LOCALE;
    }
  }
  if (select) {
    select.value = locale;
    document.documentElement.lang = locale;
    select.addEventListener("change", async () => {
      try {
        const selected = await fetchLocale(select.value);
        saveLocalePreference(selected.locale, localStorage);
        applyLocale(selected.messages);
        document.documentElement.lang = selected.locale;
        locale = selected.locale;
        notifyLocaleChanged(selected.locale, selected.messages);
      } catch (error) {
        console.error("Failed to apply selected language:", error);
        select.value = locale;
      }
    });
  }
  return locale;
}
