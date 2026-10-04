// ============================================================
// CONFIGURACIÓN BÁSICA
// ============================================================
const DB_NAME = "audiolibrosDB";
const DB_VERSION = 3;
const STORE_AUDIO = "audios";
const STORE_COVERS = "covers";
const STORE_META  = "metadatos";
const STORE_SUBTITLES = "subtitles";

let db = null;
let currentBook = null;
let currentChapterIndex = 0;
let saveInterval = null;
let isRestoringProgress = false;

let musicMetadata = null;
let kuromojiTokenizer = null;

// Estado de los subtítulos del capítulo actual
let currentSubs = {
  original: [],
  translation: [],
  activeOrigIdx: -1,
  activeTradIdx: -1,
  lastOrigIdx: -1,
  lastTradIdx: -1
};

// Guardar referencias a URLs de portadas para revocarlas y evitar fugas de memoria
const activeBlobUrls = new Set();

function createCleanObjectURL(blob) {
  const url = URL.createObjectURL(blob);
  activeBlobUrls.add(url);
  return url;
}

function revokeAllBlobUrls() {
  activeBlobUrls.forEach(url => URL.revokeObjectURL(url));
  activeBlobUrls.clear();
}

// ============================================================
// DETECCIÓN DE DISPOSITIVO
// ============================================================
const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform));
console.log("📱 isMobile:", isMobile);

// ============================================================
// SCREEN WAKE LOCK (evita que se apague la pantalla)
// ============================================================
let wakeLock = null;
let wakeLockInterval = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  if (wakeLock && !wakeLock.released) return;

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      console.log("🔅 Wake Lock liberado (evento)");
    });
  } catch (err) {
    console.warn("No se pudo activar Wake Lock:", err.message || err);
  }
}

async function releaseWakeLock() {
  if (wakeLock && !wakeLock.released) {
    try {
      await wakeLock.release();
      wakeLock = null;
    } catch (err) {
      console.warn("Error liberando Wake Lock:", err);
    }
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    const modalAbierto = !document.getElementById("playerModal").classList.contains("hidden");
    if (modalAbierto) {
      setTimeout(() => requestWakeLock(), 200);
    }
  }
});

function startWakeLockLoop() {
  if (!isMobile) return;
  if (wakeLockInterval) clearInterval(wakeLockInterval);
  wakeLockInterval = setInterval(() => {
    const modalAbierto = !document.getElementById("playerModal").classList.contains("hidden");
    if (modalAbierto && !player.paused) {
      requestWakeLock();
    }
  }, 30000);
}

function stopWakeLockLoop() {
  if (wakeLockInterval) {
    clearInterval(wakeLockInterval);
    wakeLockInterval = null;
  }
}

// ============================================================
// CARGA DINÁMICA DE BIBLIOTECAS
// ============================================================
(async function loadMusicMetadata() {
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/music-metadata@11.0.0/+esm');
    musicMetadata = { parseBlob: mod.parseBlob, selectCover: mod.selectCover };
  } catch (err) {
    console.warn("⚠️ music-metadata no disponible:", err);
  }
})();

async function loadKuromoji() {
  if (kuromojiTokenizer) return kuromojiTokenizer;
  try {
    const kuromoji = await import('https://cdn.jsdelivr.net/npm/@patdx/kuromoji@1.0.4/+esm');
    const myLoader = {
      async loadArrayBuffer(url) {
        url = url.replace('.gz', '');
        const res = await fetch('https://cdn.jsdelivr.net/npm/@aiktb/kuromoji@1.0.2/dict/' + url);
        if (!res.ok) throw new Error(`Failed to fetch ${url}`);
        return res.arrayBuffer();
      }
    };
    kuromojiTokenizer = await new kuromoji.TokenizerBuilder({ loader: myLoader }).build();
    return kuromojiTokenizer;
  } catch (err) {
    console.warn("⚠️ No se pudo cargar kuromoji:", err);
    return null;
  }
}

function katakanaToHiragana(str) {
  return str.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

// ============================================================
// AJUSTES DEL REPRODUCTOR (localStorage)
// ============================================================
const SETTINGS_KEY = "audiolibro_settings_v1";
const DEFAULT_SETTINGS = {
  alwaysShowSubs: false,
  origColor: "#ffffff",
  origSize: 2.2,
  tradColor: "#b8b8b8",
  tradSize: 1.5,
  tradBlur: false,
  syncOffset: 0,
  dictEnabled: true
};

let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) { console.warn("No se pudieron cargar ajustes:", e); }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch (e) { console.warn("No se pudieron guardar ajustes:", e); }
}

function applySettingsToDOM() {
  const orig = document.getElementById("subtitleOriginal");
  const trad = document.getElementById("subtitleTranslation");

  if (orig) {
    orig.style.color = settings.origColor;
    orig.style.fontSize = settings.origSize + "rem";
  }

  if (trad) {
    trad.style.color = settings.tradColor;
    trad.style.fontSize = settings.tradSize + "rem";
    trad.classList.toggle("blurred", settings.tradBlur);
  }

  const setAlwaysShowSubs = document.getElementById("setAlwaysShowSubs");
  if (setAlwaysShowSubs) setAlwaysShowSubs.checked = settings.alwaysShowSubs;

  const setOrigColor = document.getElementById("setOrigColor");
  if (setOrigColor) setOrigColor.value = settings.origColor;
  
  const setOrigSize = document.getElementById("setOrigSize");
  if (setOrigSize) setOrigSize.value = settings.origSize;

  const setOrigSizeVal = document.getElementById("setOrigSizeVal");
  if (setOrigSizeVal) setOrigSizeVal.textContent = settings.origSize.toFixed(1) + "rem";

  const setTradColor = document.getElementById("setTradColor");
  if (setTradColor) setTradColor.value = settings.tradColor;

  const setTradSize = document.getElementById("setTradSize");
  if (setTradSize) setTradSize.value = settings.tradSize;

  const setTradSizeVal = document.getElementById("setTradSizeVal");
  if (setTradSizeVal) setTradSizeVal.textContent = settings.tradSize.toFixed(1) + "rem";

  const setTradBlur = document.getElementById("setTradBlur");
  if (setTradBlur) setTradBlur.checked = settings.tradBlur;

  const setDictEnabled = document.getElementById("setDictEnabled");
  if (setDictEnabled) setDictEnabled.checked = settings.dictEnabled;

  const syncValue = document.getElementById("syncValue");
  if (syncValue) syncValue.textContent = settings.syncOffset.toFixed(1) + "s";
}

// ============================================================
// DICCIONARIO Y TRADUCCIÓN
// ============================================================
const DICT_CACHE = new Map();
const MAX_CACHE_SIZE = 500;

const CYRILLIC_TO_LATIN = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z',
  'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch',
  'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
  'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z',
  'И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R',
  'С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch',
  'Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya'
};

function detectLanguage(text) {
  if (!text) return "latin";
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text)) return "ja";
  if (/[а-яА-ЯёЁ]/.test(text)) return "ru";
  return "latin";
}

function transliterateRussian(word) {
  let result = "";
  for (const ch of word) {
    result += CYRILLIC_TO_LATIN[ch] !== undefined ? CYRILLIC_TO_LATIN[ch] : ch;
  }
  return result;
}

async function translateToEnglish(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data || !data[0]) return "";
  return data[0].map(seg => seg[0]).join("");
}

async function lookupWord(word, lang) {
  const key = lang + "|" + word.toLowerCase();
  if (DICT_CACHE.has(key)) return DICT_CACHE.get(key);

  const entry = { translation: null, pron: null, error: null };

  if (lang === "ru") {
    entry.pron = transliterateRussian(word);
  } else if (lang === "ja") {
    const tokenizer = await loadKuromoji();
    if (tokenizer) {
      try {
        const tokens = tokenizer.tokenize(word);
        const token = tokens.find(t => t.surface_form === word) || tokens[0];
        if (token && token.reading && token.reading !== '*') {
          entry.pron = katakanaToHiragana(token.reading);
        }
      } catch (err) {
        console.warn("Error tokenizando:", word, err);
      }
    }
  }

  try {
    entry.translation = await translateToEnglish(word);
  } catch (err) {
    entry.error = "No se pudo traducir";
  }

  if (DICT_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = DICT_CACHE.keys().next().value;
    DICT_CACHE.delete(firstKey);
  }
  DICT_CACHE.set(key, entry);
  return entry;
}

// ============================================================
// INDEXEDDB
// ============================================================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_AUDIO))
        database.createObjectStore(STORE_AUDIO, { keyPath: "id" });
      if (!database.objectStoreNames.contains(STORE_COVERS))
        database.createObjectStore(STORE_COVERS, { keyPath: "id" });
      if (!database.objectStoreNames.contains(STORE_META))
        database.createObjectStore(STORE_META, { keyPath: "id" });
      if (!database.objectStoreNames.contains(STORE_SUBTITLES))
        database.createObjectStore(STORE_SUBTITLES, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================
// UTILIDADES
// ============================================================
function formatTime(sec) {
  if (!isFinite(sec)) return "00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function uid() {
  return "book_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

function escapeHTML(str) {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

const PLACEHOLDER_COVER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220">
       <rect width="100%" height="100%" fill="#333"/>
       <text x="50%" y="50%" fill="#666" font-family="sans-serif"
             font-size="16" text-anchor="middle" dy=".3em">Sin portada</text>
     </svg>`
  );

// ============================================================
// PARSER SRT
// ============================================================
function parseSRT(text) {
  const content = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!content) return [];

  const blocks = content.split(/\n\n+/);
  const result = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter(l => l.trim() !== "");
    if (lines.length < 2) continue;

    let timeLineIdx = lines.findIndex(l => l.includes("-->"));
    if (timeLineIdx === -1) continue;

    const timeLine = lines[timeLineIdx];
    const match = timeLine.match(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/
    );
    if (!match) continue;

    const start =
      parseInt(match[1]) * 3600 +
      parseInt(match[2]) * 60 +
      parseInt(match[3]) +
      parseInt(match[4].padEnd(3, "0")) / 1000;

    const end =
      parseInt(match[5]) * 3600 +
      parseInt(match[6]) * 60 +
      parseInt(match[7]) +
      parseInt(match[8].padEnd(3, "0")) / 1000;

    const textLines = lines.slice(timeLineIdx + 1);
    const textContent = textLines.join("\n").trim();
    if (!textContent) continue;

    result.push({ start, end, text: textContent });
  }

  return result;
}

// ============================================================
// CARGA Y TOKENIZACIÓN DE SUBTÍTULOS
// ============================================================
async function loadSubtitlesForChapter(chapter) {
  currentSubs = {
    original: [],
    translation: [],
    activeOrigIdx: -1,
    activeTradIdx: -1,
    lastOrigIdx: -1,
    lastTradIdx: -1
  };

  document.getElementById("subtitleOriginal").textContent = "";
  document.getElementById("subtitleTranslation").textContent = "";

  if (!chapter) return;

  if (chapter.subtitleOriginalId) {
    const rec = await idbGet(STORE_SUBTITLES, chapter.subtitleOriginalId);
    if (rec && rec.blob) {
      const text = await rec.blob.text();
      currentSubs.original = parseSRT(text);
    }
  }

  if (chapter.subtitleTranslationId) {
    const rec = await idbGet(STORE_SUBTITLES, chapter.subtitleTranslationId);
    if (rec && rec.blob) {
      const text = await rec.blob.text();
      currentSubs.translation = parseSRT(text);
    }
  }
}

function wrapWordsInSpans(text) {
  return text
    .split(/\s+/)
    .map(word => {
      const match = word.match(/^([¿¡«"'(\[]*)(.*?)([»"')\].,;:!?…]*)$/);
      const prefix = match ? match[1] : "";
      const core   = match ? match[2] : word;
      const suffix = match ? match[3] : "";

      if (!core) return escapeHTML(prefix + suffix);

      return escapeHTML(prefix)
        + `<span class="word" data-word="${escapeHTML(core)}">${escapeHTML(core)}</span>`
        + escapeHTML(suffix);
    })
    .join(" ");
}

async function wrapJapaneseInSpans(text) {
  const tokenizer = await loadKuromoji();
  if (!tokenizer) return escapeHTML(text);

  try {
    const tokens = tokenizer.tokenize(text);
    return tokens.map(token => {
      const surface = token.surface_form;
      if (surface === "\n") return "<br>";
      return `<span class="word" data-word="${escapeHTML(surface)}">${escapeHTML(surface)}</span>`;
    }).join("");
  } catch (err) {
    console.warn("Error tokenizando línea japonesa:", err);
    return escapeHTML(text);
  }
}

function updateSubtitles(time) {
  const syncTime = time - settings.syncOffset;

  let origIdx = findLineAtTime(currentSubs.original, syncTime);
  if (origIdx >= 0) {
    currentSubs.lastOrigIdx = origIdx;
  } else if (settings.alwaysShowSubs) {
    origIdx = findLastPassedLine(currentSubs.original, syncTime, currentSubs.lastOrigIdx);
  }

  if (origIdx !== currentSubs.activeOrigIdx) {
    currentSubs.activeOrigIdx = origIdx;
    const el = document.getElementById("subtitleOriginal");
    const text = origIdx >= 0 ? currentSubs.original[origIdx].text : "";

    if (settings.dictEnabled && text) {
      const lang = detectLanguage(text);
      if (lang === "ja") {
        el.innerHTML = "…";
        const capturedIdx = origIdx;
        wrapJapaneseInSpans(text).then(html => {
          if (currentSubs.activeOrigIdx === capturedIdx) {
            el.innerHTML = html;
          }
        });
      } else {
        el.innerHTML = wrapWordsInSpans(text);
      }
    } else {
      el.textContent = text;
    }
  }

  let tradIdx = findLineAtTime(currentSubs.translation, syncTime);
  if (tradIdx >= 0) {
    currentSubs.lastTradIdx = tradIdx;
  } else if (settings.alwaysShowSubs) {
    tradIdx = findLastPassedLine(currentSubs.translation, syncTime, currentSubs.lastTradIdx);
  }

  if (tradIdx !== currentSubs.activeTradIdx) {
    currentSubs.activeTradIdx = tradIdx;
    const el = document.getElementById("subtitleTranslation");
    el.textContent = tradIdx >= 0 ? currentSubs.translation[tradIdx].text : "";
  }
}

function findLineAtTime(lines, time) {
  let lo = 0, hi = lines.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time < lines[mid].start) hi = mid - 1;
    else if (time > lines[mid].end) lo = mid + 1;
    else { found = mid; break; }
  }
  return found;
}

function findLastPassedLine(lines, time, lastKnownIdx) {
  if (!lines || lines.length === 0) return -1;
  if (lastKnownIdx >= 0 && lastKnownIdx < lines.length && lines[lastKnownIdx].start <= time) {
    let idx = lastKnownIdx;
    while (idx + 1 < lines.length && lines[idx + 1].start <= time) {
      idx++;
    }
    return idx;
  }
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= time) found = i;
    else break;
  }
  return found;
}

// ============================================================
// METADATOS Y BÚSQUEDA EXTERNA
// ============================================================
async function extractMetadataFromFile(file) {
  const result = { title: null, artist: null, album: null, coverBlob: null };
  if (!musicMetadata) return result;
  try {
    const metadata = await musicMetadata.parseBlob(file);
    const common = metadata.common || {};
    if (common.title)  result.title  = common.title;
    if (common.artist) result.artist = common.artist;
    if (common.album)  result.album  = common.album;
    const picture = musicMetadata.selectCover(common.picture);
    if (picture && picture.data && picture.data.length > 0) {
      result.coverBlob = new Blob([picture.data], { type: picture.format || "image/jpeg" });
    }
  } catch (err) {
    console.warn("No se pudieron leer metadatos de", file.name, err);
  }
  return result;
}

function parseFileName(name) {
  let base = name.replace(/\.[^/.]+$/, "");
  let title = base, author = "";
  if (base.includes(" - ")) {
    const parts = base.split(" - ");
    title = parts[0].trim();
    author = parts.slice(1).join(" - ").trim();
  } else if (/\(.+\)$/.test(base)) {
    const match = base.match(/^(.+?)\s*\((.+?)\)$/);
    if (match) { title = match[1].trim(); author = match[2].trim(); }
  }
  return { title, author };
}

async function fetchBookMetadata(title, author = "") {
  const results = { title: null, author: null, synopsis: null, coverUrl: null };
  const query = author ? `${title} ${author}` : title;
  const encoded = encodeURIComponent(query);

  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encoded}&maxResults=1`);
    if (res.ok) {
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        const info = data.items[0].volumeInfo;
        results.title = info.title || null;
        results.author = info.authors ? info.authors.join(", ") : null;
        results.synopsis = info.description || null;
        if (info.imageLinks) {
          let url = info.imageLinks.thumbnail || info.imageLinks.smallThumbnail;
          if (url) {
            url = url.replace("zoom=1", "zoom=2").replace("&edge=curl", "");
            url = url.replace(/^http:\/\//, "https://");
            results.coverUrl = url;
          }
        }
      }
    }
  } catch (err) { console.warn("Error Google Books:", err); }

  if (!results.coverUrl || !results.synopsis) {
    try {
      const res = await fetch(
        `https://openlibrary.org/search.json?q=${encoded}&limit=1&fields=title,author_name,cover_i,first_sentence,subject`
      );
      if (res.ok) {
        const data = await res.json();
        if (data.docs && data.docs.length > 0) {
          const doc = data.docs[0];
          results.title = results.title || doc.title || null;
          results.author = results.author || (doc.author_name ? doc.author_name.join(", ") : null);
          if (!results.synopsis) {
            if (doc.first_sentence) {
              results.synopsis = Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : doc.first_sentence;
            } else if (doc.subject) {
              results.synopsis = `Temas: ${doc.subject.slice(0, 6).join(", ")}`;
            }
          }
          if (!results.coverUrl && doc.cover_i) {
            results.coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
          }
        }
      }
    } catch (err) { console.warn("Error Open Library:", err); }
  }
  return results;
}

async function applyMetadataToBook(bookId, metadata) {
  if (!metadata) return;
  const meta = await idbGet(STORE_META, bookId);
  if (!meta) return;

  if (metadata.title && (!meta.title || meta.title === meta.folderName)) meta.title = metadata.title;
  if (metadata.author && (!meta.author || meta.author === "Autor desconocido")) meta.author = metadata.author;
  if (metadata.synopsis && !meta.synopsis) meta.synopsis = metadata.synopsis;

  if (metadata.coverUrl && !meta.coverId) {
    try {
      const res = await fetch(metadata.coverUrl);
      if (res.ok) {
        const blob = await res.blob();
        const coverId = "cover_" + bookId;
        await idbPut(STORE_COVERS, { id: coverId, blob });
        meta.coverId = coverId;
      }
    } catch (err) { console.warn("No se pudo descargar portada:", err); }
  }

  meta.needsMetadata = false;
  await idbPut(STORE_META, meta);
  renderLibrary();
}

// ============================================================
// RENDER DE LA BIBLIOTECA
// ============================================================
async function renderLibrary() {
  revokeAllBlobUrls();
  const library = document.getElementById("library");
  if (!library) return;
  library.innerHTML = "";

  const metas = await idbGetAll(STORE_META);
  metas.sort((a, b) => b.addedAt - a.addedAt);

  if (metas.length === 0) {
    library.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:#666;padding:2rem;">
      No hay audiolibros aún. Pulsa "Añadir archivo" o "Añadir carpeta" para empezar.
    </p>`;
    return;
  }

  for (const meta of metas) {
    let coverURL = PLACEHOLDER_COVER;
    if (meta.coverId) {
      const coverRec = await idbGet(STORE_COVERS, meta.coverId);
      if (coverRec && coverRec.blob) coverURL = createCleanObjectURL(coverRec.blob);
    }

    const pct = meta.duration ? (meta.progress / meta.duration) * 100 : 0;
    const chapterInfo = meta.chapters && meta.chapters.length > 1
      ? ` · ${meta.chapters.length} capítulos` : "";

    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = meta.id;

    card.innerHTML = `
      <div class="cover-wrapper" data-action="cover">
        <img class="cover" src="${coverURL}" alt="Portada">
      </div>
      <div class="card-body">
        <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
        <h3 data-action="edit-title" title="Clic para editar título">
          <span class="title-text">${escapeHTML(meta.title) || "Sin título"}</span>
          <span class="edit-icon">✏️</span>
        </h3>
        <p class="author" data-action="edit-author" title="Clic para editar autor">
          <span class="author-text">${escapeHTML(meta.author) || "Autor desconocido"}</span>
          <span class="edit-icon">✏</span>
          <span style="color:#666;font-size:0.75rem;">${chapterInfo}</span>
        </p>
        <p class="synopsis">${escapeHTML(meta.synopsis) || "Sin sinopsis disponible."}</p>
        <div class="card-actions">
          <button class="btn-play" data-action="play">▶ Reproducir</button>
          <button class="btn-delete" data-action="delete">🗑️ Eliminar</button>
        </div>
      </div>
    `;
    library.appendChild(card);
  }
}

// Event Delegation para la biblioteca
const libraryContainer = document.getElementById("library");
if (libraryContainer) {
  libraryContainer.addEventListener("click", async (e) => {
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const card = actionEl.closest(".card");
    if (!card) return;

    const id = card.dataset.id;
    const action = actionEl.dataset.action;

    if (action === "play") openBook(id);
    else if (action === "delete") {
      if (confirm("¿Eliminar este audiolibro?")) await deleteBook(id);
    }
    else if (action === "cover") {
      const coverInput = document.getElementById("coverInput");
      coverInput.dataset.bookId = id;
      coverInput.value = "";
      coverInput.click();
    }
    else if (action === "edit-title") startInlineEdit(actionEl, id, "title");
    else if (action === "edit-author") startInlineEdit(actionEl, id, "author");
  });
}

// ============================================================
// ELIMINAR Y EDITAR
// ============================================================
async function deleteBook(id) {
  const meta = await idbGet(STORE_META, id);
  if (!meta) return;
  if (currentBook && currentBook.id === id) closeModal();

  if (meta.chapters && meta.chapters.length > 0) {
    for (const ch of meta.chapters) {
      await idbDelete(STORE_AUDIO, ch.audioId);
      if (ch.subtitleOriginalId) await idbDelete(STORE_SUBTITLES, ch.subtitleOriginalId);
      if (ch.subtitleTranslationId) await idbDelete(STORE_SUBTITLES, ch.subtitleTranslationId);
    }
  } else {
    await idbDelete(STORE_AUDIO, id);
  }
  if (meta.coverId) await idbDelete(STORE_COVERS, meta.coverId);
  await idbDelete(STORE_META, id);
  renderLibrary();
}

const coverInput = document.getElementById("coverInput");
if (coverInput) {
  coverInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    const bookId = e.target.dataset.bookId;
    if (!file || !bookId) return;
    if (!file.type.startsWith("image/")) { alert("Selecciona una imagen válida"); return; }

    const coverId = "cover_" + bookId;
    await idbPut(STORE_COVERS, { id: coverId, blob: file });
    const meta = await idbGet(STORE_META, bookId);
    if (meta) { meta.coverId = coverId; await idbPut(STORE_META, meta); }
    if (currentBook && currentBook.id === bookId) {
      currentBook.coverId = coverId;
      document.getElementById("playerCover").src = URL.createObjectURL(file);
    }
    e.target.dataset.bookId = "";
    e.target.value = "";
    renderLibrary();
  });
}

function startInlineEdit(el, id, field) {
  if (el.querySelector("input")) return;
  const span = el.querySelector(field === "title" ? ".title-text" : ".author-text");
  const currentValue = span.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "edit-input";
  input.value = (currentValue === "Sin título" || currentValue === "Autor desconocido") ? "" : currentValue;
  span.replaceWith(input);
  input.focus();
  input.select();

  const finish = async (save) => {
    if (save) {
      const newValue = input.value.trim();
      const meta = await idbGet(STORE_META, id);
      if (meta) {
        meta[field] = newValue;
        await idbPut(STORE_META, meta);
        if (currentBook && currentBook.id === id) {
          currentBook[field] = newValue;
          if (field === "title") document.getElementById("playerTitle").textContent = newValue || "Sin título";
          if (field === "author") document.getElementById("playerAuthor").textContent = newValue || "Autor desconocido";
        }
      }
    }
    renderLibrary();
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    if (ev.key === "Escape") { ev.preventDefault(); renderLibrary(); }
  });
}

// ============================================================
// CARGA DE ARCHIVOS / CARPETAS
// ============================================================
const AUDIO_EXTENSIONS = [".mp3",".m4a",".m4b",".aac",".ogg",".opus",".wav",".flac",".weba",".webm"];
const SUBTITLE_EXTENSIONS = [".srt"];

const ORIG_FOLDER_NAMES = ["original","originales","orig","source","source subtitle"];
const TRAD_FOLDER_NAMES = ["traduccion","traducción","traducciones","translation","translation subtitle","subtitulos","subtítulos"];

function isAudioFile(name) { return AUDIO_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext)); }
function isSubtitleFile(name) { return SUBTITLE_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext)); }

function detectFolderType(relativePath) {
  const parts = relativePath.split("/").map(p => p.toLowerCase());
  for (let i = 0; i < parts.length - 1; i++) {
    const folder = parts[i].normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (ORIG_FOLDER_NAMES.some(n => folder === n || folder.includes(n))) return "original";
    if (TRAD_FOLDER_NAMES.some(n => folder === n || folder.includes(n))) return "translation";
  }
  return null;
}

const btnAddFile = document.getElementById("btnAddFile");
if (btnAddFile) btnAddFile.onclick = () => document.getElementById("fileInput").click();

const btnAddFolder = document.getElementById("btnAddFolder");
if (btnAddFolder) btnAddFolder.onclick = () => document.getElementById("folderInput").click();

const fileInput = document.getElementById("fileInput");
if (fileInput) {
  fileInput.onchange = (e) => {
    const files = Array.from(e.target.files).filter(f => isAudioFile(f.name));
    if (files.length === 0) return;
    if (files.length === 1) addBookFromFiles(files, files[0].name.replace(/\.[^/.]+$/, ""));
    else files.forEach(f => addBookFromFiles([f], f.name.replace(/\.[^/.]+$/, "")));
    e.target.value = "";
  };
}

const folderInput = document.getElementById("folderInput");
if (folderInput) {
  folderInput.onchange = (e) => {
    const allFiles = Array.from(e.target.files);
    const audioFiles = allFiles.filter(f => isAudioFile(f.name));
    const subFiles = allFiles.filter(f => isSubtitleFile(f.name));

    if (audioFiles.length === 0) {
      alert("La carpeta no contiene archivos de audio compatibles.");
      return;
    }

    const folderName = audioFiles[0].webkitRelativePath.split("/")[0] || "Audiolibro";
    addBookFromFiles(audioFiles, folderName, subFiles);
    e.target.value = "";
  };
}

// ============================================================
// CREAR LIBRO Y PROCESAR ARCHIVOS
// ============================================================
async function addBookFromFiles(files, bookName, subtitleFiles = []) {
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const bookId = uid();
  const chapters = [];
  let totalDuration = 0;
  let extracted = { title: null, artist: null, synopsis: null, coverBlob: null };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const audioId = bookId + "_ch" + i;
    await idbPut(STORE_AUDIO, { id: audioId, blob: file });

    const duration = await getAudioDuration(file);
    totalDuration += duration;

    const baseName = file.name.replace(/\.[^/.]+$/, "").toLowerCase();
    let subtitleOriginalId = null;
    let subtitleTranslationId = null;

    for (const sub of subtitleFiles) {
      const subBase = sub.name.replace(/\.[^/.]+$/, "").toLowerCase();
      if (subBase !== baseName) continue;

      const type = detectFolderType(sub.webkitRelativePath || sub.name);
      if (type === "original" && !subtitleOriginalId) {
        subtitleOriginalId = bookId + "_sub_orig_ch" + i;
        await idbPut(STORE_SUBTITLES, { id: subtitleOriginalId, blob: sub });
      }
      if (type === "translation" && !subtitleTranslationId) {
        subtitleTranslationId = bookId + "_sub_trad_ch" + i;
        await idbPut(STORE_SUBTITLES, { id: subtitleTranslationId, blob: sub });
      }
    }

    chapters.push({
      id: i,
      fileName: file.name,
      duration,
      audioId,
      subtitleOriginalId,
      subtitleTranslationId
    });

    if (i === 0 || (!extracted.coverBlob && !extracted.title)) {
      const info = await extractMetadataFromFile(file);
      if (info.title && !extracted.title)   extracted.title  = info.title;
      if (info.artist && !extracted.artist) extracted.artist = info.artist;
      if (info.album && !extracted.title)   extracted.title  = info.album;
      if (info.coverBlob && !extracted.coverBlob) extracted.coverBlob = info.coverBlob;
    }
  }

  let coverId = null;
  if (extracted.coverBlob) {
    coverId = "cover_" + bookId;
    await idbPut(STORE_COVERS, { id: coverId, blob: extracted.coverBlob });
  }

  const finalTitle = extracted.title || bookName;
  const finalAuthor = extracted.artist || "Autor desconocido";

  const meta = {
    id: bookId,
    title: finalTitle,
    author: finalAuthor,
    synopsis: extracted.synopsis || "",
    coverId,
    duration: totalDuration,
    progress: 0,
    addedAt: Date.now(),
    folderName: bookName,
    chapters,
    needsMetadata: !extracted.title && !coverId
  };

  await idbPut(STORE_META, meta);
  renderLibrary();

  const needsSearch = !extracted.title || !extracted.artist || !extracted.coverBlob || !extracted.synopsis;
  if (needsSearch) {
    const parsed = parseFileName(bookName);
    const searchTitle = extracted.title || parsed.title || bookName;
    const searchAuthor = extracted.artist || parsed.author || (finalAuthor !== "Autor desconocido" ? finalAuthor : "");
    if (searchTitle && searchTitle.length > 2) {
      fetchBookMetadata(searchTitle, searchAuthor).then(md => {
        if (md && (md.title || md.synopsis || md.coverUrl || md.author)) {
          applyMetadataToBook(bookId, md);
        }
      });
    }
  }
}

function getAudioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = url;
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(isFinite(audio.duration) ? audio.duration : 0);
    };
    audio.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
  });
}

// ============================================================
// ABRIR Y REPRODUCIR LIBRO
// ============================================================
async function openBook(id) {
  const meta = await idbGet(STORE_META, id);
  if (!meta) return;

  // Consultar progreso remoto
  try {
    const res = await fetch(`/api/progress/${id}`);
    if (res.ok) {
      const data = await res.json();
      if (data.progress !== undefined && data.progress > meta.progress) {
        meta.progress = data.progress;
        await idbPut(STORE_META, meta);
      }
    }
  } catch (err) {
    console.warn("Servidor desconectado o sin autenticar, usando progreso local.");
  }

  if (!meta.chapters) {
    meta.chapters = [{
      id: 0,
      fileName: meta.fileName || "audio",
      duration: meta.duration || 0,
      audioId: meta.id,
      subtitleOriginalId: null,
      subtitleTranslationId: null
    }];
  }

  currentBook = meta;
  const { chapterIndex, offset } = globalToChapter(meta, meta.progress || 0);
  currentChapterIndex = chapterIndex;

  await updatePlayerUI(meta);
  await loadChapter(currentChapterIndex, offset);
  applySettingsToDOM();

  document.getElementById("playerModal").classList.remove("hidden");
  requestWakeLock();
  startWakeLockLoop();
  
  // Iniciar guardado recurrente
  if (saveInterval) clearInterval(saveInterval);
  saveInterval = setInterval(saveProgress, 3000);
}

async function updatePlayerUI(meta) {
  let coverURL = PLACEHOLDER_COVER;
  if (meta.coverId) {
    const coverRec = await idbGet(STORE_COVERS, meta.coverId);
    if (coverRec && coverRec.blob) coverURL = URL.createObjectURL(coverRec.blob);
  }
  document.getElementById("playerCover").src = coverURL;
  document.getElementById("playerTitle").textContent = meta.title || "Sin título";
  document.getElementById("playerAuthor").textContent = meta.author || "Autor desconocido";
  updateChapterInfo();
}

function updateChapterInfo() {
  if (!currentBook) return;
  const total = currentBook.chapters.length;
  const el = document.getElementById("playerChapterInfo");
  if (total > 1) {
    el.textContent = `Capítulo ${currentChapterIndex + 1} de ${total} · ${currentBook.chapters[currentChapterIndex].fileName}`;
  } else {
    el.textContent = currentBook.chapters[0].fileName;
  }
}

function globalToChapter(meta, globalSeconds) {
  let accumulated = 0;
  for (let i = 0; i < meta.chapters.length; i++) {
    const ch = meta.chapters[i];
    if (globalSeconds < accumulated + ch.duration || i === meta.chapters.length - 1) {
      return { chapterIndex: i, offset: Math.max(0, globalSeconds - accumulated) };
    }
    accumulated += ch.duration;
  }
  return { chapterIndex: 0, offset: 0 };
}

function chapterToGlobal(meta, chapterIndex, offset) {
  let accumulated = 0;
  for (let i = 0; i < chapterIndex; i++) accumulated += meta.chapters[i].duration;
  return accumulated + offset;
}

async function loadChapter(index, startOffset = 0) {
  if (!currentBook) return;
  const chapter = currentBook.chapters[index];
  if (!chapter) return;

  const audioRec = await idbGet(STORE_AUDIO, chapter.audioId);
  if (!audioRec) return;

  const player = document.getElementById("player");
  const url = URL.createObjectURL(audioRec.blob);
  player.src = url;
  player.playbackRate = parseFloat(document.getElementById("speedSelect").value) || 1;

  isRestoringProgress = true;
  player.onloadedmetadata = () => {
    if (startOffset > 0 && startOffset < player.duration - 1) player.currentTime = startOffset;
    document.getElementById("duration").textContent = formatTime(currentBook.duration);
    updateProgressBar();
    isRestoringProgress = false;
  };

  await loadSubtitlesForChapter(chapter);
  updateChapterInfo();

  player.play().catch(() => {});
  document.getElementById("btnPlay").textContent = "⏸";
}

const player = document.getElementById("player");
const progressBar = document.getElementById("progressBar");

player.addEventListener("ended", async () => {
  if (!currentBook) return;
  if (currentChapterIndex < currentBook.chapters.length - 1) {
    currentChapterIndex++;
    await loadChapter(currentChapterIndex, 0);
  } else {
    document.getElementById("btnPlay").textContent = "▶";
    releaseWakeLock();
  }
});

function updateProgressBar() {
  if (!currentBook) return;
  const globalTime = chapterToGlobal(currentBook, currentChapterIndex, player.currentTime);
  progressBar.max = currentBook.duration;
  progressBar.value = globalTime;
  document.getElementById("currentTime").textContent = formatTime(globalTime);
  document.getElementById("duration").textContent = formatTime(currentBook.duration);
}

player.addEventListener("timeupdate", () => {
  updateProgressBar();
  if (!currentBook || isRestoringProgress) return;
  updateSubtitles(player.currentTime);
});

async function saveProgress() {
  if (!currentBook || isRestoringProgress || player.paused) return;
  const globalTime = chapterToGlobal(currentBook, currentChapterIndex, player.currentTime);
  
  const meta = await idbGet(STORE_META, currentBook.id);
  if (!meta) return;
  meta.progress = globalTime;
  await idbPut(STORE_META, meta);
  updateCardProgress(meta.id, globalTime, meta.duration);

  try {
    await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: currentBook.id, progress: globalTime })
    });
  } catch (err) {
    console.warn("No se pudo sincronizar en la nube:", err);
  }
}

function updateCardProgress(bookId, progress, duration) {
  const card = document.querySelector(`.card[data-id="${bookId}"]`);
  if (!card) return;
  const fill = card.querySelector(".progress-fill");
  if (fill && duration) fill.style.width = ((progress / duration) * 100) + "%";
}

window.addEventListener("beforeunload", () => {
  if (currentBook) {
    const globalTime = chapterToGlobal(currentBook, currentChapterIndex, player.currentTime);
    const meta = { ...currentBook, progress: globalTime };
    idbPut(STORE_META, meta);
  }
});

// ============================================================
// BOTONES DEL REPRODUCTOR
// ============================================================
document.getElementById("btnPlay").onclick = () => {
  if (player.paused) {
    player.play();
    requestWakeLock();
    startWakeLockLoop();
  } else {
    player.pause();
    releaseWakeLock();
    stopWakeLockLoop();
  }
  document.getElementById("btnPlay").textContent = player.paused ? "▶" : "⏸";
};

document.getElementById("btnBack").onclick = async () => {
  if (!currentBook) return;
  const globalTime = chapterToGlobal(currentBook, currentChapterIndex, player.currentTime);
  const newGlobal = Math.max(0, globalTime - 15);
  const { chapterIndex, offset } = globalToChapter(currentBook, newGlobal);
  if (chapterIndex !== currentChapterIndex) {
    currentChapterIndex = chapterIndex;
    await loadChapter(chapterIndex, offset);
  } else {
    player.currentTime = offset;
  }
};

document.getElementById("btnFwd").onclick = async () => {
  if (!currentBook) return;
  const globalTime = chapterToGlobal(currentBook, currentChapterIndex, player.currentTime);
  const newGlobal = Math.min(currentBook.duration, globalTime + 15);
  const { chapterIndex, offset } = globalToChapter(currentBook, newGlobal);
  if (chapterIndex !== currentChapterIndex) {
    currentChapterIndex = chapterIndex;
    await loadChapter(chapterIndex, offset);
  } else {
    player.currentTime = offset;
  }
};

document.getElementById("btnCloseModal").onclick = closeModal;

async function closeModal() {
  await saveProgress();
  if (saveInterval) { clearInterval(saveInterval); saveInterval = null; }
  stopWakeLockLoop();
  player.pause();
  player.src = "";
  currentBook = null;
  currentChapterIndex = 0;
  currentSubs = { original: [], translation: [], activeOrigIdx: -1, activeTradIdx: -1, lastOrigIdx: -1, lastTradIdx: -1 };
  document.getElementById("subtitleOriginal").textContent = "";
  document.getElementById("subtitleTranslation").textContent = "";
  releaseWakeLock();
  document.getElementById("playerModal").classList.add("hidden");
  renderLibrary();
}

progressBar.addEventListener("input", async () => {
  if (!currentBook) return;
  const globalTime = parseFloat(progressBar.value);
  const { chapterIndex, offset } = globalToChapter(currentBook, globalTime);
  if (chapterIndex !== currentChapterIndex) {
    currentChapterIndex = chapterIndex;
    await loadChapter(chapterIndex, offset);
  } else {
    player.currentTime = offset;
  }
  document.getElementById("currentTime").textContent = formatTime(globalTime);
});

document.getElementById("speedSelect").addEventListener("change", (e) => {
  player.playbackRate = parseFloat(e.target.value);
});

// ============================================================
// ATAJOS DE TECLADO (W, A, S, D)
// ============================================================
document.addEventListener("keydown", (e) => {
  if (document.getElementById("playerModal").classList.contains("hidden")) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const key = e.key.toLowerCase();

  if (key === "w") {
    e.preventDefault();
    if (player.paused) {
      player.play();
      requestWakeLock();
      startWakeLockLoop();
    } else {
      player.pause();
      releaseWakeLock();
      stopWakeLockLoop();
    }
    document.getElementById("btnPlay").textContent = player.paused ? "▶" : "⏸";
  }
  else if (key === "s") { e.preventDefault(); repeatCurrentSubtitle(); }
  else if (key === "a") { e.preventDefault(); goToSubtitle(-1); }
  else if (key === "d") { e.preventDefault(); goToSubtitle(1); }
});

function repeatCurrentSubtitle() {
  const lines = currentSubs.original;
  if (!lines || lines.length === 0) return;
  const syncTime = player.currentTime - settings.syncOffset;
  const idx = findLineAtTime(lines, syncTime);
  let targetStart;

  if (idx >= 0) {
    targetStart = lines[idx].start;
  } else {
    let closest = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].start <= syncTime) closest = i;
      else break;
    }
    if (closest >= 0) targetStart = lines[closest].start;
  }

  if (targetStart !== undefined) {
    player.currentTime = targetStart + settings.syncOffset;
    if (player.paused) player.play();
  }
}

function goToSubtitle(direction) {
  const lines = currentSubs.original;
  if (!lines || lines.length === 0) return;

  const syncTime = player.currentTime - settings.syncOffset;
  const idx = findLineAtTime(lines, syncTime);
  let target;

  if (idx >= 0) {
    target = idx + direction;
  } else {
    if (direction > 0) {
      target = lines.findIndex(l => l.start > syncTime);
      if (target === -1) target = lines.length - 1;
    } else {
      let closest = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].start <= syncTime) closest = i;
        else break;
      }
      target = closest;
    }
  }

  if (target < 0) target = 0;
  if (target >= lines.length) target = lines.length - 1;

  player.currentTime = lines[target].start + settings.syncOffset;
  if (player.paused) player.play();
}

// ============================================================
// CARGA Y ASIGNACIÓN POR CARPETAS DE SUBTÍTULOS
// ============================================================
const btnLoadSubOrig = document.getElementById("btnLoadSubOrig");
if (btnLoadSubOrig) {
  btnLoadSubOrig.onclick = () => {
    const input = document.getElementById("subOrigFolderInput");
    if (input) {
      input.value = "";
      input.click();
    }
  };
}

const btnLoadSubTrad = document.getElementById("btnLoadSubTrad");
if (btnLoadSubTrad) {
  btnLoadSubTrad.onclick = () => {
    const input = document.getElementById("subTradFolderInput");
    if (input) {
      input.value = "";
      input.click();
    }
  };
}

// Cargar carpeta completa para Subtítulos Originales
const subOrigFolderInput = document.getElementById("subOrigFolderInput");
if (subOrigFolderInput) {
  subOrigFolderInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files).filter(f => isSubtitleFile(f.name));
    if (files.length === 0 || !currentBook) {
      alert("No se encontraron archivos SRT válidos en la carpeta seleccionada.");
      return;
    }

    const meta = await idbGet(STORE_META, currentBook.id);
    if (!meta) return;

    let matchCount = 0;
    for (let i = 0; i < meta.chapters.length; i++) {
      const chapter = meta.chapters[i];
      const chapterBase = chapter.fileName.replace(/\.[^/.]+$/, "").toLowerCase();

      // Buscar el archivo SRT correspondiente al nombre del capítulo
      const matchedSub = files.find(f => f.name.replace(/\.[^/.]+$/, "").toLowerCase() === chapterBase);

      if (matchedSub) {
        const subId = currentBook.id + "_sub_orig_ch" + i;
        await idbPut(STORE_SUBTITLES, { id: subId, blob: matchedSub });
        meta.chapters[i].subtitleOriginalId = subId;
        matchCount++;
      }
    }

    await idbPut(STORE_META, meta);
    currentBook = meta;
    await loadSubtitlesForChapter(currentBook.chapters[currentChapterIndex]);
    updateSubtitles(player.currentTime);
    alert(`Se vincularon ${matchCount} subtítulos originales.`);
  });
}

// Cargar carpeta completa para Subtítulos Traducidos
const subTradFolderInput = document.getElementById("subTradFolderInput");
if (subTradFolderInput) {
  subTradFolderInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files).filter(f => isSubtitleFile(f.name));
    if (files.length === 0 || !currentBook) {
      alert("No se encontraron archivos SRT válidos en la carpeta seleccionada.");
      return;
    }

    const meta = await idbGet(STORE_META, currentBook.id);
    if (!meta) return;

    let matchCount = 0;
    for (let i = 0; i < meta.chapters.length; i++) {
      const chapter = meta.chapters[i];
      const chapterBase = chapter.fileName.replace(/\.[^/.]+$/, "").toLowerCase();

      // Buscar el archivo SRT correspondiente al nombre del capítulo
      const matchedSub = files.find(f => f.name.replace(/\.[^/.]+$/, "").toLowerCase() === chapterBase);

      if (matchedSub) {
        const subId = currentBook.id + "_sub_trad_ch" + i;
        await idbPut(STORE_SUBTITLES, { id: subId, blob: matchedSub });
        meta.chapters[i].subtitleTranslationId = subId;
        matchCount++;
      }
    }

    await idbPut(STORE_META, meta);
    currentBook = meta;
    await loadSubtitlesForChapter(currentBook.chapters[currentChapterIndex]);
    updateSubtitles(player.currentTime);
    alert(`Se vincularon ${matchCount} subtítulos traducidos.`);
  });
}
// ============================================================
// PANEL DE AJUSTES
// ============================================================
document.getElementById("btnSettings").onclick = () => {
  document.getElementById("settingsPanel").classList.remove("hidden");
};

document.getElementById("btnCloseSettings").onclick = () => {
  document.getElementById("settingsPanel").classList.add("hidden");
};

document.getElementById("setAlwaysShowSubs").addEventListener("change", (e) => {
  settings.alwaysShowSubs = e.target.checked;
  saveSettings();
  currentSubs.activeOrigIdx = -1;
  currentSubs.activeTradIdx = -1;
  updateSubtitles(player.currentTime);
});

document.getElementById("setOrigColor").addEventListener("input", (e) => {
  settings.origColor = e.target.value;
  saveSettings();
  applySettingsToDOM();
});

document.getElementById("setOrigSize").addEventListener("input", (e) => {
  settings.origSize = parseFloat(e.target.value);
  saveSettings();
  applySettingsToDOM();
});

document.getElementById("setTradColor").addEventListener("input", (e) => {
  settings.tradColor = e.target.value;
  saveSettings();
  applySettingsToDOM();
});

document.getElementById("setTradSize").addEventListener("input", (e) => {
  settings.tradSize = parseFloat(e.target.value);
  saveSettings();
  applySettingsToDOM();
});

document.getElementById("setTradBlur").addEventListener("change", (e) => {
  settings.tradBlur = e.target.checked;
  saveSettings();
  applySettingsToDOM();
  currentSubs.activeOrigIdx = -1;
  currentSubs.activeTradIdx = -1;
  updateSubtitles(player.currentTime);
});

document.getElementById("btnSyncMinus").onclick = () => {
  settings.syncOffset = +(settings.syncOffset - 0.1).toFixed(2);
  saveSettings();
  applySettingsToDOM();
};

document.getElementById("btnSyncPlus").onclick = () => {
  settings.syncOffset = +(settings.syncOffset + 0.1).toFixed(2);
  saveSettings();
  applySettingsToDOM();
};

document.getElementById("btnSyncReset").onclick = () => {
  settings.syncOffset = 0;
  saveSettings();
  applySettingsToDOM();
};

document.getElementById("btnResetAll").onclick = () => {
  if (!confirm("¿Restablecer todos los ajustes a los valores por defecto?")) return;
  settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  applySettingsToDOM();
};

// ============================================================
// TOOLTIP Y DICCIONARIO
// ============================================================
const tooltipEl = document.getElementById("wordTooltip");
const tooltipWordEl = document.getElementById("tooltipWord");
const tooltipPronEl = document.getElementById("tooltipPron");
const tooltipTransEl = document.getElementById("tooltipTranslation");

let currentHoveredWord = null;

async function handleWordInteraction(e) {
  const span = e.target.closest(".word");
  if (!span) return;
  if (!settings.dictEnabled) return;

  const word = span.dataset.word;
  if (!word) return;

  if (currentHoveredWord === word && !tooltipEl.classList.contains("hidden")) return;
  currentHoveredWord = word;

  const fullText = currentSubs.original[currentSubs.activeOrigIdx]?.text || "";
  const lang = detectLanguage(fullText);

  tooltipWordEl.textContent = word;
  tooltipPronEl.textContent = "";
  tooltipTransEl.textContent = "Buscando…";
  tooltipTransEl.className = "tooltip-translation loading";
  positionTooltip(e);
  tooltipEl.classList.remove("hidden");

  const entry = await lookupWord(word, lang);

  if (currentHoveredWord !== word) return;

  tooltipPronEl.textContent = entry.pron || "";

  if (entry.error) {
    tooltipTransEl.textContent = entry.error;
    tooltipTransEl.className = "tooltip-translation error";
  } else {
    tooltipTransEl.textContent = entry.translation || "—";
    tooltipTransEl.className = "tooltip-translation";
  }

  positionTooltip(e);
}

document.getElementById("subtitleOriginal").addEventListener("mouseover", handleWordInteraction);
document.getElementById("subtitleOriginal").addEventListener("click", (e) => {
  if (isMobile) handleWordInteraction(e);
});

document.getElementById("subtitleOriginal").addEventListener("mousemove", (e) => {
  if (!isMobile && e.target.closest(".word")) positionTooltip(e);
});

document.getElementById("subtitleOriginal").addEventListener("mouseout", (e) => {
  if (isMobile) return;
  const related = e.relatedTarget;
  if (related && related.closest && related.closest(".word")) return;
  currentHoveredWord = null;
  tooltipEl.classList.add("hidden");
});

if (isMobile) {
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".word") && !e.target.closest("#wordTooltip")) {
      currentHoveredWord = null;
      tooltipEl.classList.add("hidden");
    }
  });
}

function positionTooltip(e) {
  const margin = 15;
  const rect = tooltipEl.getBoundingClientRect();
  let x = e.clientX + margin;
  let y = e.clientY + margin;

  if (x + rect.width > window.innerWidth - 10) x = e.clientX - rect.width - margin;
  if (y + rect.height > window.innerHeight - 10) y = e.clientY - rect.height - margin;
  if (x < 10) x = 10;
  if (y < 10) y = 10;

  tooltipEl.style.left = x + "px";
  tooltipEl.style.top  = y + "px";
}

document.getElementById("setDictEnabled").addEventListener("change", (e) => {
  settings.dictEnabled = e.target.checked;
  saveSettings();
  applySettingsToDOM();
  currentSubs.activeOrigIdx = -1;
  updateSubtitles(player.currentTime);

  if (!settings.dictEnabled) {
    tooltipEl.classList.add("hidden");
    currentHoveredWord = null;
  }
});

// Toggle para texto borroso/desenfocado de traducción
document.getElementById("subtitleTranslation").addEventListener("click", (e) => {
  if (!settings.tradBlur) return;
  e.stopPropagation();
  const trad = document.getElementById("subtitleTranslation");
  trad.classList.toggle("revealed");
});

// ============================================================
// INICIALIZACIÓN
// ============================================================
(async function init() {
  console.log("Inicializando aplicación...");
  loadSettings();
  db = await openDB();
  await renderLibrary();

  const modal = document.getElementById("playerModal");
  if (modal) {
    modal.addEventListener("click", () => {
      if (!modal.classList.contains("hidden")) {
        requestWakeLock();
      }
    }, { passive: true });
  }

  console.log("✅ App lista");
})();
