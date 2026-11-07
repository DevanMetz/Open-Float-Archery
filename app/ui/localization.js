const LANGUAGE_INDEX_URL = "./locales/index.json";
const LOCALE_STORAGE_KEY = "openfloat_locale";
const FALLBACK_LOCALE = "en-US";
const originalText = new WeakMap();
const originalAttributes = new WeakMap();

let languages = [];
let currentLocale = FALLBACK_LOCALE;
let currentDictionary = { strings: {}, placeholders: {} };

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function translateString(value) {
  const translation = currentDictionary.strings[normalizeText(value)];
  return translation ?? normalizeText(value);
}

function translationForText(value) {
  const normalized = normalizeText(value);
  const exact = currentDictionary.strings[normalized];
  if (exact !== undefined) return exact;

  const cant = normalized.match(/^Cant:\s*(.+)$/);
  if (cant && currentDictionary.strings["Cant:"]) {
    return `${currentDictionary.strings["Cant:"]} ${cant[1]}`;
  }

  const selection = normalized.match(/^(\d+) selected$/);
  if (selection) {
    const key = Number(selection[1]) === 1 ? "One selected count" : "Many selected count";
    const suffix = currentDictionary.strings[key];
    if (suffix) return `${selection[1]} ${suffix}`;
  }

  const shotTitle = normalized.match(/^Shot #(\d+)$/);
  if (shotTitle && currentDictionary.strings.Shot) {
    return `${currentDictionary.strings.Shot} #${shotTitle[1]}`;
  }

  return normalized;
}

function translateTextNode(node) {
  if (node.parentElement?.closest("script, style, textarea, code, pre")) return;
  const currentValue = node.nodeValue;
  const previous = originalText.get(node);
  const source = previous && currentValue === previous.translated
    ? previous.source
    : currentValue;
  const trimmed = normalizeText(source);
  const translation = translationForText(trimmed);
  const leading = source.match(/^\s*/)?.[0] ?? "";
  const trailing = source.match(/\s*$/)?.[0] ?? "";
  const translatedValue = `${leading}${translation}${trailing}`;
  originalText.set(node, { source, translated: translatedValue });
  if (node.nodeValue !== translatedValue) node.nodeValue = translatedValue;
}

function translateAttribute(element, attribute) {
  const value = element.getAttribute(attribute);
  if (value === null) return;
  let originals = originalAttributes.get(element);
  if (!originals) {
    originals = new Map();
    originalAttributes.set(element, originals);
  }
  const previous = originals.get(attribute);
  const source = previous && value === previous.translated
    ? previous.source
    : value;
  const translations = attribute === "placeholder"
    ? currentDictionary.placeholders
    : currentDictionary.strings;
  const translation = translations[normalizeText(source)] ?? source;
  originals.set(attribute, { source, translated: translation });
  if (value !== translation) element.setAttribute(attribute, translation);
}

function translateDocument() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) translateTextNode(node);

  document.querySelectorAll("[title], [aria-label], [placeholder]").forEach((element) => {
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      translateAttribute(element, attribute);
    }
  });
  document.documentElement.lang = currentLocale;
}

async function loadDictionary(language) {
  const response = await fetch(`./${language.file}`);
  if (!response.ok) {
    throw new Error(`Could not load ${language.file}: HTTP ${response.status}`);
  }
  const dictionary = await response.json();
  if (
    dictionary.code !== language.code
    || !dictionary.strings
    || typeof dictionary.strings !== "object"
    || !dictionary.placeholders
    || typeof dictionary.placeholders !== "object"
  ) {
    throw new Error(`Invalid translation file for ${language.code}`);
  }
  return dictionary;
}

export async function initializeLocalization({ select, status }) {
  const setStatus = (message) => {
    if (status) status.textContent = message;
  };

  try {
    const response = await fetch(LANGUAGE_INDEX_URL);
    if (!response.ok) throw new Error(`Language index returned HTTP ${response.status}`);
    const index = await response.json();
    if (!Array.isArray(index.languages)) throw new Error("Language index has no languages array");
    languages = index.languages.filter((language) =>
      typeof language.code === "string"
      && typeof language.name === "string"
      && typeof language.file === "string"
    );
    if (!languages.length) {
      throw new Error("Language index contains no valid language entries");
    }
  } catch (error) {
    console.error("Could not initialize the language selector:", error);
    currentDictionary = await loadDictionary({ code: FALLBACK_LOCALE, file: "locales/en-US.json" });
    translateDocument();
    setStatus(translateString("Could not load the language list."));
    if (select) select.disabled = true;
    return;
  }

  if (select) {
    select.replaceChildren(...languages.map((language) => {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.name;
      return option;
    }));
  }

  const savedLocale = localStorage.getItem(LOCALE_STORAGE_KEY);
  const selectedLanguage = languages.find((language) => language.code === savedLocale)
    || languages.find((language) => language.code === FALLBACK_LOCALE)
    || languages[0];

  try {
    currentDictionary = await loadDictionary(selectedLanguage);
    currentLocale = selectedLanguage.code;
  } catch (error) {
    console.error("Could not load the selected language:", error);
    const english = languages.find((language) => language.code === FALLBACK_LOCALE);
    if (!english) throw error;
    currentDictionary = await loadDictionary(english);
    currentLocale = english.code;
    setStatus(translateString("Could not load this language file."));
  }
  if (select) select.value = currentLocale;
  translateDocument();

  select?.addEventListener("change", async () => {
    const language = languages.find((entry) => entry.code === select.value);
    if (!language) return;

    select.disabled = true;
    try {
      const dictionary = await loadDictionary(language);
      currentDictionary = dictionary;
      currentLocale = language.code;
      localStorage.setItem(LOCALE_STORAGE_KEY, currentLocale);
      translateDocument();
      setStatus("");
      window.dispatchEvent(new CustomEvent("openfloat:localechange", {
        detail: { locale: currentLocale },
      }));
    } catch (error) {
      console.error(`Could not switch language to ${language.code}:`, error);
      setStatus(translateString("Could not load this language file."));
      select.value = currentLocale;
    } finally {
      select.disabled = false;
    }
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        translateTextNode(mutation.target);
        continue;
      }
      if (mutation.type === "attributes") {
        translateAttribute(mutation.target, mutation.attributeName);
        continue;
      }
      for (const addedNode of mutation.addedNodes) {
        if (addedNode.nodeType === Node.TEXT_NODE) {
          translateTextNode(addedNode);
        } else if (addedNode.nodeType === Node.ELEMENT_NODE) {
          const walker = document.createTreeWalker(addedNode, NodeFilter.SHOW_TEXT);
          let textNode;
          while ((textNode = walker.nextNode())) translateTextNode(textNode);
          if (addedNode.matches("[title], [aria-label], [placeholder]")) {
            for (const attribute of ["title", "aria-label", "placeholder"]) {
              translateAttribute(addedNode, attribute);
            }
          }
          addedNode.querySelectorAll?.("[title], [aria-label], [placeholder]").forEach((element) => {
            for (const attribute of ["title", "aria-label", "placeholder"]) {
              translateAttribute(element, attribute);
            }
          });
        }
      }
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["title", "aria-label", "placeholder"],
  });
}
