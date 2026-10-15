import { CATALOG_URL, MAX_ENVELOPE_LENGTH, verifyEnvelope, dateTimestamp } from "./catalog.js";

const feed = document.querySelector("#news-feed");
const status = document.querySelector("#feed-status");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const CACHE_KEY = "chlenix-signed-catalog-v1";
const POLL_INTERVAL = 60000;
const expandedEntries = new Set();
let currentPayload = null;
let inFlight = null;
let timer = null;
let lastCheck = 0;
let motionFigures = [];
let initialHashHandled = false;
let ready = false;

function showFeedError(message = "") {
  status.textContent = message;
  status.hidden = !message;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function bodyParagraphs(container, body) {
  for (const paragraph of body.split(/\r?\n\s*\r?\n/)) {
    const element = node("p", null, paragraph);
    // Single newlines in authored text are preserved without interpreting markup.
    element.classList.add("authored-paragraph");
    container.append(element);
  }
}

function formatDate(date) {
  const timestamp = dateTimestamp(date);
  return timestamp ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(timestamp) : date;
}

function externalLink(url, label, className = "media-link") {
  const link = node("a", className, label);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function imageElement(url, item, title) {
  const image = node("img");
  image.src = url;
  image.alt = item.alt || `Иллюстрация к новости «${title}»`;
  image.width = item.width;
  image.height = item.height;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => {
    const message = node("p", "media-unavailable", "Изображение сейчас недоступно.");
    image.replaceWith(message);
  }, { once: true });
  return image;
}

function posterImage(item, title) {
  return imageElement(item.poster.url, { ...item, width: item.poster.width ?? item.width, height: item.poster.height ?? item.height }, title);
}

function renderMedia(figure, item, title) {
  figure.replaceChildren();
  if (!item) { figure.append(node("p", "media-unavailable", "Медиа не удалось показать. Текст новости доступен.")); return; }
  if (item.type === "image") {
    if (item.webp && item.poster && reducedMotion.matches) {
      figure.append(posterImage(item, title), externalLink(item.url, "Открыть WebP ↗"));
    } else figure.append(imageElement(item.url, item, title));
  } else if (item.type === "gif") {
    if (reducedMotion.matches) {
      if (item.poster) figure.append(posterImage(item, title));
      else figure.append(node("p", "media-unavailable", "Анимация скрыта по настройке уменьшения движения."));
      figure.append(externalLink(item.url, "Открыть GIF ↗"));
    } else {
      figure.append(imageElement(item.url, item, title));
    }
  } else if (item.playable) {
    const video = node("video");
    video.controls = true;
    video.preload = "none";
    video.playsInline = true;
    video.width = item.width;
    video.height = item.height;
    video.setAttribute("aria-label", item.alt || `Видео к новости «${title}»`);
    if (item.poster) video.poster = item.poster.url;
    video.src = item.url;
    video.append(externalLink(item.url, "Открыть видео ↗"));
    video.addEventListener("error", () => {
      video.replaceWith(node("p", "media-unavailable", "Видео сейчас недоступно."));
    }, { once: true });
    figure.append(video, externalLink(item.url, "Открыть видео отдельно ↗"));
  } else {
    if (item.poster) figure.append(posterImage(item, title));
    figure.append(externalLink(item.url, "Открыть видео ↗"));
  }
  if (item.alt) figure.append(node("figcaption", null, item.alt));
}

function renderBody(content, entry) {
  const full = node("div", "news-body");
  full.id = `body-${entry.id}`;
  bodyParagraphs(full, entry.body);
  const long = entry.body.length > 900 || entry.body.split(/\r?\n\s*\r?\n/).length > 5;
  if (!long) { content.append(full); return; }
  const preview = node("div", "news-body news-preview");
  const paragraphs = entry.body.split(/\r?\n\s*\r?\n/);
  const first = paragraphs[0];
  const excerpt = first.length <= 500 ? first : first.slice(0, 460).replace(/\s+\S*$/, "") + "…";
  bodyParagraphs(preview, excerpt);
  const toggle = node("button", "read-more");
  toggle.type = "button";
  toggle.dataset.focusKey = "read-more";
  toggle.setAttribute("aria-controls", full.id);
  function update() {
    const expanded = expandedEntries.has(entry.id);
    preview.hidden = expanded;
    full.hidden = !expanded;
    toggle.textContent = expanded ? "Свернуть ↑" : "Читать полностью ↓";
    toggle.setAttribute("aria-expanded", String(expanded));
  }
  toggle.addEventListener("click", () => {
    if (expandedEntries.has(entry.id)) expandedEntries.delete(entry.id); else expandedEntries.add(entry.id);
    update();
  });
  update();
  content.append(preview, full, toggle);
}

function renderNews(news) {
  const activeEntry = document.activeElement?.closest(".news-entry");
  const activeId = activeEntry?.id;
  const focusKey = document.activeElement?.dataset.focusKey;
  const visibleEntry = [...feed.children].find(element => {
    const rect = element.getBoundingClientRect();
    return rect.top <= window.innerHeight * .35 && rect.bottom > 0;
  });
  const position = visibleEntry ? { id: visibleEntry.id, top: visibleEntry.getBoundingClientRect().top } : null;
  const fragment = document.createDocumentFragment();
  motionFigures = [];
  for (const entry of news) {
    const article = node("article", "news-entry");
    article.id = `news-${entry.id}`;
    article.tabIndex = -1;
    article.setAttribute("aria-labelledby", `title-${entry.id}`);
    const meta = node("div", "news-meta");
    const date = node("time", null, formatDate(entry.date));
    const timestamp = dateTimestamp(entry.date);
    if (timestamp) date.dateTime = new Date(timestamp).toISOString().slice(0, 10);
    meta.append(date, node("span", null, entry.version));
    const content = node("div", "news-content");
    const heading = node("h3", "news-title");
    heading.id = `title-${entry.id}`;
    const permalink = node("a", null, entry.title);
    permalink.href = `#${article.id}`;
    permalink.dataset.focusKey = "permalink";
    heading.append(permalink);
    content.append(heading);
    renderBody(content, entry);
    for (const item of entry.media) {
      const figure = node("figure", "news-media");
      renderMedia(figure, item, entry.title);
      if (item && (item.type === "gif" || item.webp)) motionFigures.push({ figure, item, title: entry.title });
      content.append(figure);
    }
    article.append(meta, content);
    fragment.append(article);
  }
  if (!news.length) fragment.append(node("p", "news-empty", "Здесь появятся новости проекта."));
  feed.replaceChildren(fragment);
  feed.setAttribute("aria-busy", "false");
  if (activeId) {
    const restored = document.getElementById(activeId);
    const target = focusKey ? restored?.querySelector(`[data-focus-key="${focusKey}"]`) : restored;
    target?.focus({ preventScroll: true });
  }
  if (position) {
    const restored = document.getElementById(position.id);
    if (restored) window.scrollBy(0, restored.getBoundingClientRect().top - position.top);
  }
  if (!initialHashHandled) initialHashHandled = !window.location.hash.startsWith("#news-") || openHash();
}

function openHash() {
  const hash = window.location.hash.slice(1);
  if (!/^news-[a-zA-Z0-9_-]+$/.test(hash)) return false;
  const target = document.getElementById(hash);
  if (!target) return false;
  const toggle = target.querySelector(".read-more");
  if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
  return true;
}

async function acceptEnvelope(envelope) {
  const catalog = await verifyEnvelope(envelope);
  if (envelope.payload !== currentPayload) {
    renderNews(catalog.news);
    currentPayload = envelope.payload;
    document.querySelector("#game-build").textContent = catalog.gameBuildId;
  }
  showFeedError();
}

async function fetchEnvelope(url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!response.ok) throw new Error("Каталог недоступен.");
    if (Number(response.headers.get("Content-Length")) > MAX_ENVELOPE_LENGTH) throw new Error("Каталог слишком большой.");
    const text = await response.text();
    if (text.length > MAX_ENVELOPE_LENGTH) throw new Error("Каталог слишком большой.");
    return JSON.parse(text);
  } finally { window.clearTimeout(timeout); }
}

function schedule() {
  window.clearTimeout(timer);
  timer = null;
  if (!ready || document.visibilityState !== "visible" || inFlight) return;
  timer = window.setTimeout(checkForUpdates, Math.max(0, POLL_INTERVAL - (Date.now() - lastCheck)));
}

function checkForUpdates() {
  if (!ready || document.visibilityState !== "visible" || inFlight) return inFlight;
  lastCheck = Date.now();
  inFlight = (async () => {
    try {
      const envelope = await fetchEnvelope(CATALOG_URL);
      await acceptEnvelope(envelope);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(envelope)); } catch { /* Storage may be disabled. */ }
    } catch {
      showFeedError(currentPayload ? "Не удалось обновить новости. Показаны сохранённые записи." : "Новости сейчас недоступны. Попробуем снова через минуту.");
      feed.setAttribute("aria-busy", "false");
      if (!currentPayload && !feed.childElementCount) feed.append(node("p", "news-empty", "Новости также доступны в Launcher."));
    } finally {
      inFlight = null;
      schedule();
    }
  })();
  return inFlight;
}

async function start() {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached && cached.length <= MAX_ENVELOPE_LENGTH) await acceptEnvelope(JSON.parse(cached));
  } catch { /* Cached envelopes are never trusted without verification. */ }
  if (!currentPayload) {
    try { await acceptEnvelope(await fetchEnvelope("assets/catalog.json")); } catch { /* Continue with the public source. */ }
  }
  ready = true;
  if (document.visibilityState === "visible") checkForUpdates();
}

document.addEventListener("visibilitychange", () => {
  if (!ready) return;
  if (document.visibilityState === "visible" && !inFlight && Date.now() - lastCheck >= POLL_INTERVAL) checkForUpdates();
  else schedule();
});
window.addEventListener("hashchange", openHash);
reducedMotion.addEventListener("change", () => {
  for (const { figure, item, title } of motionFigures) renderMedia(figure, item, title);
});
start();
