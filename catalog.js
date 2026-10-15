// This public key matches Chlenix.Launcher.Core/ReleaseTrust.cs.
export const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyiXjccZc7ELuqO+88SrtIVZcji4F
sMsYZ0CF7FW4rYRd6ZlBK2ZZNlsHsT/zcddWIiiNkGDwVLMhkPMtqPUSDQ==
-----END PUBLIC KEY-----`;
export const CATALOG_URL = "https://raw.githubusercontent.com/gatekeeper3s/chlenix-releases/main/update.json";
export const MAX_ENVELOPE_LENGTH = 262144;
const MAX_PAYLOAD_LENGTH = 262144;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const VIDEO_HOSTS = new Set(["youtube.com", "www.youtube.com", "youtu.be", "vimeo.com", "www.vimeo.com"]);
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|webp)$/i;
const POSTER_EXTENSIONS = /\.(png|jpg|jpeg)$/i;
let verificationKey;

function decodeBase64(value, maximum) {
  if (typeof value !== "string" || value.length > maximum || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Некорректный формат каталога.");
  }
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function getVerificationKey() {
  if (!globalThis.crypto?.subtle) throw new Error("Браузер не поддерживает проверку подписи.");
  if (!verificationKey) {
    const der = PUBLIC_KEY_PEM.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    verificationKey = crypto.subtle.importKey("spki", decodeBase64(der, 512), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  }
  return verificationKey;
}

function textField(value, maximum, allowEmpty = false) {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) throw new Error("Некорректные данные новости.");
  return value;
}

export async function newsId(entry) {
  if (typeof entry.id === "string" && ID_PATTERN.test(entry.id)) return entry.id;
  // Shared with the Launcher: compact JSON array, UTF-8, first 16 SHA-256 hex digits.
  const input = JSON.stringify([entry.version, entry.date, entry.title, entry.body]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return "legacy-" + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function releaseAssetUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) return null;
    if (!/^\/gatekeeper3s\/chlenix-releases\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname)) return null;
    if (/%2f|%5c/i.test(url.pathname) || url.pathname.includes("\\")) return null;
    return url.href;
  } catch { return null; }
}

export function externalVideoUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !VIDEO_HOSTS.has(url.hostname) || url.port || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function positiveInteger(value, maximum) { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }

function normalizePoster(poster) {
  if (!poster || typeof poster !== "object") return null;
  const url = releaseAssetUrl(poster.url);
  if (!url || !POSTER_EXTENSIONS.test(new URL(url).pathname) || !SHA256_PATTERN.test(poster.sha256 ?? "") || !positiveInteger(poster.size, 8000000)) return null;
  if (!positiveInteger(poster.width, 4096) || !positiveInteger(poster.height, 4096) || poster.width * poster.height > 12000000) return null;
  return { url, sha256: poster.sha256.toLowerCase(), size: poster.size, width: poster.width, height: poster.height };
}

export function normalizeMedia(item) {
  if (!item || typeof item !== "object" || !["image", "gif", "video"].includes(item.type)) return null;
  const ownedUrl = releaseAssetUrl(item.url);
  const externalUrl = item.type === "video" ? externalVideoUrl(item.url) : null;
  if (!ownedUrl && !externalUrl) return null;
  const limit = item.type === "video" ? 40000000 : 8000000;
  // External videos are links, not downloaded files. File media carry size and SHA-256.
  if (ownedUrl && (!SHA256_PATTERN.test(item.sha256 ?? "") || !positiveInteger(item.size, limit))) return null;
  if (ownedUrl) {
    const pathname = new URL(ownedUrl).pathname;
    if (item.type === "video" ? !/\.mp4$/i.test(pathname) : item.type === "gif" ? !/\.gif$/i.test(pathname) : !IMAGE_EXTENSIONS.test(pathname)) return null;
  }
  if (!positiveInteger(item.width, 4096) || !positiveInteger(item.height, 4096) || item.width * item.height > 12000000) return null;
  if (typeof item.alt !== "string" || !item.alt.trim() || item.alt.length > 500) return null;
  const poster = normalizePoster(item.poster);
  if (item.poster != null && !poster) return null;
  if ((item.type === "gif" || item.type === "video") && !poster) return null;
  const webp = item.type === "image" && /\.webp$/i.test(new URL(ownedUrl).pathname);
  if (webp && !poster) return null;
  return {
    type: item.type, url: ownedUrl ?? externalUrl, external: Boolean(externalUrl),
    sha256: ownedUrl ? item.sha256.toLowerCase() : null, size: ownedUrl ? item.size : null,
    width: item.width, height: item.height, alt: item.alt, poster, webp,
    playable: item.type === "video" && Boolean(ownedUrl) && /\.mp4$/i.test(new URL(ownedUrl).pathname)
  };
}

export function dateTimestamp(value) {
  if (typeof value !== "string") return 0;
  const local = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!local && !iso) return 0;
  const [year, month, day] = local ? [Number(local[3]), Number(local[2]), Number(local[1])] : [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  const timestamp = Date.UTC(year, month - 1, day);
  const result = new Date(timestamp);
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day ? timestamp : 0;
}

export async function verifyEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") throw new Error("Некорректный каталог.");
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > MAX_ENVELOPE_LENGTH) throw new Error("Каталог слишком большой.");
  const payload = decodeBase64(envelope.payload, Math.ceil(MAX_PAYLOAD_LENGTH / 3) * 4);
  const signature = decodeBase64(envelope.signature, 88);
  if (payload.length > MAX_PAYLOAD_LENGTH || signature.length !== 64) throw new Error("Некорректная подпись каталога.");
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await getVerificationKey(), signature, payload);
  if (!valid) throw new Error("Подпись каталога не подтверждена.");
  const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  return normalizeCatalog(data);
}

export async function normalizeCatalog(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.news) || data.news.length > 30) throw new Error("Некорректная лента.");
  const version = textField(data.version, 40);
  const launcherVersion = textField(data.launcherVersion, 40);
  const gameBuildId = textField(data.gameBuildId, 40);
  const normalized = await Promise.all(data.news.map(async (entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error("Некорректная новость.");
    const news = {
      version: textField(entry.version, 50), date: textField(entry.date, 32),
      title: textField(entry.title, 300), body: textField(entry.body, 8000, true),
      id: entry.id, index
    };
    if (entry.id != null && (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id))) throw new Error("Некорректный адрес новости.");
    news.id = await newsId(news);
    if (entry.media != null && (!Array.isArray(entry.media) || entry.media.length > 4)) throw new Error("Некорректный список медиа.");
    news.media = (entry.media ?? []).map(normalizeMedia);
    return news;
  }));
  // Keep authored order for entries on the same date; newest calendar dates come first.
  normalized.sort((a, b) => dateTimestamp(b.date) - dateTimestamp(a.date) || a.index - b.index);
  const seen = new Set();
  const news = normalized.filter(entry => { if (seen.has(entry.id)) return false; seen.add(entry.id); return true; });
  return { version, launcherVersion, gameBuildId, news };
}
