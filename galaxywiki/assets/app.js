const state = {
  meta: null,
  entities: [],
  route: "gallery",
  slug: null,
  query: "",
  filter: "all",
  filtersOpen: false,
  searchMode: "name",
  coordRA: "",
  coordDec: "",
  coordResults: null,
  sortKey: "mentions",
  sortDir: "desc",
  theme: "light",
  visibleLimit: 720,
  lastVisibleCount: 0,
  searchIndex: null,
  searchPromise: null,
  fullIndexLoaded: false,
  fullIndexPromise: null,
  loadedShards: new Map(),
  expandedAliases: new Set(),
  expandedQuotes: new Set(),
  sourceLimits: new Map(),
  imageObserver: null,
};

const INITIAL_VISIBLE_LIMIT = 720;
const VISIBLE_STEP = 720;
const INITIAL_SOURCE_LIMIT = 48;
const SOURCE_STEP = 96;
const CITATION_PATTERN = /\[((?:arXiv:(?:[a-z-]+\/\d{7}(?:v\d+)?|\d{4}\.\d{4,5}(?:v\d+)?)(?:,\s*)?)+)\]/gi;

// Filters are every UAT (Unified Astronomy Thesaurus) concept carried by more
// than one galaxy in the loaded atlas, ranked by how many galaxies carry each
// term. A galaxy matches a chip when that UAT term is among its topic_keys.
let _filterCache = null;
let _filterBasis = -1;

function getFilters() {
  if (_filterCache && _filterBasis === state.entities.length) return _filterCache;
  const counts = new Map();
  for (const entity of state.entities) {
    for (const term of entity.topic_keys || []) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }
  const filters = [{ id: "all", label: "All", count: state.entities.length, test: () => true }];
  for (const [term, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (count <= 1) continue;
    filters.push({
      id: "uat:" + term,
      label: term,
      count,
      test: (entity) => (entity.topic_keys || []).includes(term),
    });
  }
  _filterCache = filters;
  _filterBasis = state.entities.length;
  return filters;
}

const root = document.getElementById("root");

function decodeEntities(payload) {
  if (!payload.fields?.length) return payload.entities || [];
  const fields = payload.fields;
  const featureNames = payload.feature_flags || [];
  const hipsValues = payload.hips_values || [];
  const featureMaskIndex = fields.indexOf("feature_mask");
  const hipsIndexIndex = fields.indexOf("hips_index");
  return (payload.entities || []).map((row) => {
    const entity = {};
    fields.forEach((field, index) => {
      entity[field] = row[index];
    });
    const mask = featureMaskIndex >= 0 ? row[featureMaskIndex] || 0 : 0;
    entity.feature_flags = Object.fromEntries(
      featureNames.map((name, index) => [name, Boolean(mask & (1 << index))]),
    );
    entity.hips = hipsIndexIndex >= 0 ? hipsValues[row[hipsIndexIndex]] || null : entity.hips;
    delete entity.feature_mask;
    delete entity.hips_index;
    return entity;
  });
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#039;";
    }
  });
}

function fmtCount(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function fmtRA(deg) {
  if (deg == null || Number.isNaN(deg)) return null;
  const h = deg / 15;
  const hh = Math.floor(h);
  const m = (h - hh) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${String(hh).padStart(2, "0")}ʰ ${String(mm).padStart(2, "0")}ᵐ ${ss.toFixed(1).padStart(4, "0")}ˢ`;
}

function fmtDec(deg) {
  if (deg == null || Number.isNaN(deg)) return null;
  const sign = deg < 0 ? "−" : "+";
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${sign}${String(d).padStart(2, "0")}° ${String(mm).padStart(2, "0")}′ ${ss.toFixed(1).padStart(4, "0")}″`;
}

function fmtAng(arcmin) {
  if (arcmin == null || Number.isNaN(arcmin)) return null;
  if (arcmin >= 1) return `${arcmin.toFixed(2)}′`;
  return `${(arcmin * 60).toFixed(2)}″`;
}

// Decimal-degree coordinate formatting (the atlas prefers decimals).
function fmtRADeg(deg) {
  if (deg == null || Number.isNaN(deg)) return null;
  return `${Number(deg).toFixed(4)}°`;
}

function fmtDecDeg(deg) {
  if (deg == null || Number.isNaN(deg)) return null;
  const sign = deg < 0 ? "−" : "+";
  return `${sign}${Math.abs(Number(deg)).toFixed(4)}°`;
}

// Parse an RA value: accepts decimal degrees ("187.7"), or sexagesimal in
// hours ("12 30 49" / "12:30:49" / "12h30m49s"). Returns degrees or null.
function parseRA(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (/^[-+]?\d*\.?\d+\s*°?$/.test(raw)) {
    const v = parseFloat(raw);
    return Number.isFinite(v) ? ((v % 360) + 360) % 360 : null;
  }
  const parts = raw.replace(/[hms:]/gi, " ").trim().split(/\s+/).map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  const [h = 0, m = 0, s = 0] = parts;
  const deg = (h + m / 60 + s / 3600) * 15;
  return Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : null;
}

// Parse a Dec value: decimal degrees, or sexagesimal degrees ("-30 32 43").
function parseDec(input) {
  if (input == null) return null;
  const raw = String(input).trim().replace(/[−—–]/g, "-");
  if (!raw) return null;
  if (/^[-+]?\d*\.?\d+\s*°?$/.test(raw)) {
    const v = parseFloat(raw);
    return Number.isFinite(v) && v >= -90 && v <= 90 ? v : null;
  }
  const neg = /^-/.test(raw) || /^\+/.test(raw) === false && raw.startsWith("-");
  const sign = raw.trim().startsWith("-") ? -1 : 1;
  const parts = raw.replace(/[dms°'":]/gi, " ").replace(/^[+-]/, "").trim().split(/\s+/).map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  const [d = 0, m = 0, s = 0] = parts;
  const deg = sign * (Math.abs(d) + m / 60 + s / 3600);
  return Number.isFinite(deg) && deg >= -90 && deg <= 90 ? deg : null;
}

// Angular separation between two sky points, in degrees (Vincenty/haversine).
function angularSeparation(ra1, dec1, ra2, dec2) {
  const d2r = Math.PI / 180;
  const a1 = ra1 * d2r, d1 = dec1 * d2r, a2 = ra2 * d2r, d2 = dec2 * d2r;
  const sinDd = Math.sin((d2 - d1) / 2);
  const sinDa = Math.sin((a2 - a1) / 2);
  const h = sinDd * sinDd + Math.cos(d1) * Math.cos(d2) * sinDa * sinDa;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / d2r;
}

// Format an angular separation (degrees) into a human label.
function fmtSeparation(deg) {
  if (deg == null) return "";
  if (deg < 1 / 60) return `${(deg * 3600).toFixed(1)}″`;
  if (deg < 1) return `${(deg * 60).toFixed(1)}′`;
  return `${deg.toFixed(2)}°`;
}

function arxivId(pid) {
  if (!pid) return null;
  const neu = String(pid).match(/^(\d{4})_(\d+)$/);
  if (neu) return `${neu[1]}.${neu[2]}`;
  const old = String(pid).match(/^([a-z]+-?[a-z]*)(\d{7,})$/i);
  if (old) return `${old[1]}/${old[2]}`;
  return String(pid);
}

function arxivAbsUrl(pid) {
  const id = arxivId(pid);
  return id ? `https://arxiv.org/abs/${id}` : null;
}

function arxivLabel(pid) {
  const id = arxivId(pid);
  return id ? `arXiv:${id}` : pid;
}

function canonicalArxivId(value) {
  if (!value) return null;
  const raw = String(value).trim().replace(/^arXiv:/i, "");
  const id = arxivId(raw);
  return id ? id.replace(/v\d+$/i, "").toLowerCase() : null;
}

function safeDomId(value) {
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function sourceArxivKey(source) {
  return canonicalArxivId(source?.arxiv_id || source?.paper_id);
}

function overviewCitationOrder(entity) {
  const seen = new Set();
  const ordered = [];
  const text = String(entity?.overview || "");
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const labels = match[1].split(/\s*,\s*/).filter(Boolean);
    for (const label of labels) {
      const key = canonicalArxivId(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}

function sortedSourcesByDiscussion(entity) {
  return [...(entity.sources || [])].sort((a, b) => (b.sentence_count || 0) - (a.sentence_count || 0));
}

function orderedSourcesForEntry(entity) {
  const sources = sortedSourcesByDiscussion(entity);
  const byKey = new Map();
  sources.forEach((source) => {
    const key = sourceArxivKey(source);
    if (key && !byKey.has(key)) byKey.set(key, source);
  });
  const citedKeys = overviewCitationOrder(entity).filter((key) => byKey.has(key));
  const citedSet = new Set(citedKeys);
  return [
    ...citedKeys.map((key) => byKey.get(key)),
    ...sources.filter((source) => !citedSet.has(sourceArxivKey(source))),
  ];
}

function sourceAnchorId(source, index) {
  const key = sourceArxivKey(source) || source?.mention_id || index + 1;
  return `source-${index + 1}-${safeDomId(key)}`;
}

function citationIndexForSources(sources) {
  const refs = new Map();
  sources.forEach((source, index) => {
    const key = sourceArxivKey(source);
    if (!key || refs.has(key)) return;
    refs.set(key, {
      number: index + 1,
      anchor: sourceAnchorId(source, index),
      label: arxivLabel(source.arxiv_id || source.paper_id),
    });
  });
  return refs;
}

function citedTextHTML(value, citationIndex = new Map()) {
  const text = String(value || "");
  let cursor = 0;
  let html = "";
  for (const match of text.matchAll(CITATION_PATTERN)) {
    html += escapeHTML(text.slice(cursor, match.index));
    const labels = match[1].split(/\s*,\s*/).filter(Boolean);
    html += `<span class="citation-bracket">[${labels
      .map((label) => {
        const ref = citationIndex.get(canonicalArxivId(label));
        return ref
          ? `<a href="#${escapeHTML(ref.anchor)}" data-cite-source="${escapeHTML(ref.anchor)}" data-source-number="${ref.number}" title="Jump to paper ${ref.number}: ${escapeHTML(ref.label)}">${ref.number}</a>`
          : `<span title="${escapeHTML(label)}">?</span>`;
      })
      .join(",")}]</span>`;
    cursor = match.index + match[0].length;
  }
  html += escapeHTML(text.slice(cursor));
  return html;
}

function ar5ivQuoteUrl(pid, quote) {
  const id = arxivId(pid);
  if (!id || !quote) return null;
  const words = quote.trim().split(/\s+/).slice(0, 5).join(" ").replace(/[.,;:!?]+$/, "");
  return `https://ar5iv.labs.arxiv.org/html/${id}#:~:text=${encodeURIComponent(words)}`;
}

function simbadUrl(ra, dec) {
  if (ra == null || dec == null) return null;
  const sign = dec >= 0 ? "+" : "-";
  const coord = `${ra.toFixed(4)}d${sign}${Math.abs(dec).toFixed(4)}d`;
  const params = new URLSearchParams({
    Coord: coord,
    CooFrame: "ICRS",
    CooEpoch: "2000",
    CooEqui: "2000",
    Radius: "2",
    "Radius.unit": "arcmin",
    submit: "submit query",
    CoordList: "",
  });
  return `https://simbad.u-strasbg.fr/simbad/sim-coo?${params.toString()}`;
}

function imgUrl(entity) {
  return entity.image_path || entity.image?.url || (entity.entity_id ? `assets/images/${entity.entity_id}.webp` : null);
}

function hasImage(entity) {
  return Boolean(imgUrl(entity));
}

function placeholderField(slug) {
  let h = 0;
  for (let index = 0; index < slug.length; index += 1) {
    h = ((h << 5) - h + slug.charCodeAt(index)) | 0;
  }
  function next() {
    h = (h * 1664525 + 1013904223) | 0;
    return (h >>> 0) / 4294967296;
  }
  const stars = [];
  for (let index = 0; index < 60; index += 1) {
    const x = (next() * 100).toFixed(2);
    const y = (next() * 100).toFixed(2);
    const r = (next() * 0.7 + 0.15).toFixed(2);
    const o = (next() * 0.7 + 0.3).toFixed(2);
    stars.push(`<circle cx="${x}%" cy="${y}%" r="${r}" fill="#ece7dc" opacity="${o}"></circle>`);
  }
  return stars.join("");
}

function topTopic(entity) {
  const topic = entity.top_topic || entity.uat_eligible?.[0]?.term;
  if (!topic) return null;
  return topic.replace("Galaxy ", "").replace(" galaxy", "").replace(" Galaxy", "");
}

function topicKeys(entity) {
  if (entity.topic_keys?.length) return entity.topic_keys;
  return (entity.uat_eligible || []).map((topic) => topic.term).filter(Boolean);
}

function uatHas(entity, needles) {
  const terms = [...(entity.uat_eligible || []), ...(entity.uat_all || [])].map((topic) =>
    String(topic.term || "").toLowerCase(),
  );
  return needles.some((needle) => terms.some((term) => term.includes(needle)));
}

function eyebrow(entity) {
  const flags = entity.feature_flags || {};
  if (flags.dwarfs) {
    return `Dwarf · ${flags.shells || flags.tidal || flags.streams ? "merger remnant" : "tidal source"}`;
  }
  if (flags.shells) return "Shell galaxy";
  if (flags.streams) return "Stream host";
  if (flags.mergers) return "Merger remnant";
  if (flags.tidal) return "Tidal source";
  if (uatHas(entity, ["dwarf"])) {
    return `Dwarf · ${uatHas(entity, ["shell", "tidal", "stream"]) ? "merger remnant" : "tidal source"}`;
  }
  if (uatHas(entity, ["shell", "shells"])) return "Shell galaxy";
  if (uatHas(entity, ["stellar streams"])) return "Stream host";
  if (uatHas(entity, ["galaxy mergers", "galaxy collisions"])) return "Merger remnant";
  if (uatHas(entity, ["tidal tails", "tidal interaction"])) return "Tidal source";
  return "Galaxy literature source";
}

function resetVisibleLimit() {
  state.visibleLimit = INITIAL_VISIBLE_LIMIT;
}

function resetAtlasState() {
  state.query = "";
  state.filter = "all";
  state.searchMode = "name";
  state.coordRA = "";
  state.coordDec = "";
  state.coordQueryRA = null;
  state.coordQueryDec = null;
  state.coordResults = null;
  state.coordError = null;
  state.sortKey = "mentions";
  state.sortDir = "desc";
  state.focusField = "heroName";
  resetVisibleLimit();
}

async function ensureSearchIndex() {
  if (state.searchIndex) return state.searchIndex;
  if (!state.searchPromise) {
    state.searchPromise = fetch("data/search.json")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load data/search.json");
        return response.json();
      })
      .then((payload) => {
        state.searchIndex = new Map(
          (payload.search || []).map((row) => [row.slug, String(row.q || "").toLowerCase()]),
        );
        return state.searchIndex;
      })
      .catch((error) => {
        console.error(error);
        state.searchPromise = null;
        return null;
      });
  }
  return state.searchPromise;
}

async function loadFullIndex({ renderAfter = true } = {}) {
  if (state.fullIndexLoaded) return state.entities;
  if (!state.fullIndexPromise) {
    const needsEntryRerender = state.route === "entry" && !currentSummary();
    state.fullIndexPromise = fetch("data/entities.json")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load data/entities.json");
        return response.json();
      })
      .then((payload) => {
        state.meta = payload.meta || state.meta || {};
        state.entities = decodeEntities(payload);
        state.fullIndexLoaded = true;
        if (renderAfter && (state.route === "gallery" || needsEntryRerender)) render();
        return state.entities;
      })
      .catch((error) => {
        console.error(error);
        state.fullIndexPromise = null;
        return state.entities;
      });
  }
  return state.fullIndexPromise;
}

function scheduleFullIndexLoad() {
  const start = () => loadFullIndex({ renderAfter: state.route === "gallery" });
  if (state.route === "entry" && !currentSummary()) {
    start();
    return;
  }
  window.setTimeout(start, 2600);
}

function queryTokens(query) {
  return String(query || "")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9.+-]*/g) || [];
}

function queryMatchesSearch(entity, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  if (String(entity.name || "").toLowerCase().includes(q)) return true;
  const haystack = state.searchIndex?.get(entity.slug) || "";
  if (haystack.includes(q)) return true;
  const tokens = queryTokens(q).filter((token) => token.length > 1 || /^\d+$/.test(token));
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function searchScore(entity, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 0;
  const name = String(entity.name || "").toLowerCase();
  const haystack = state.searchIndex?.get(entity.slug) || "";
  const tokens = queryTokens(q).filter((token) => token.length > 1 || /^\d+$/.test(token));
  let score = 0;
  if (name === q) score += 1000;
  if (name.replace(/[^a-z0-9]+/g, " ") === q.replace(/[^a-z0-9]+/g, " ")) score += 900;
  if (name.startsWith(q)) score += 650;
  if (name.includes(q)) score += 480;
  if (haystack.startsWith(q)) score += 260;
  if (haystack.includes(q)) score += 180;
  for (const token of tokens) {
    if (name.includes(token)) score += 90;
    if (haystack.includes(token)) score += 25;
  }
  return score + Math.min(entity.paper_count_total || 0, 40);
}

function sortValue(entity, key) {
  if (key === "size") return entity.ang_major_arcmin || 0;
  return entity.paper_count_total || entity.mention_count || 0;
}

function sortEntities(a, b) {
  const av = sortValue(a, state.sortKey);
  const bv = sortValue(b, state.sortKey);
  if (av !== bv) return state.sortDir === "asc" ? av - bv : bv - av;
  return a.name.localeCompare(b.name);
}

function visibleEntities() {
  let visible = state.entities;
  if (state.filter && state.filter !== "all") {
    if (state.filter.startsWith("uat:")) {
      const term = state.filter.slice(4);
      visible = visible.filter((entity) => (entity.topic_keys || []).includes(term));
    } else {
      const filter = getFilters().find((item) => item.id === state.filter);
      if (filter) visible = visible.filter(filter.test);
    }
  }
  if (state.query.trim()) {
    visible = visible.filter((entity) => queryMatchesSearch(entity, state.query));
  }
  return [...visible].sort((a, b) => {
    if (state.query.trim()) {
      const scoreDiff = searchScore(b, state.query) - searchScore(a, state.query);
      if (scoreDiff !== 0) return scoreDiff;
    }
    return sortEntities(a, b);
  });
}

function mastheadHTML() {
  const total = state.meta?.entity_count || state.entities.length;
  const showing = state.route === "gallery"
    ? state.fullIndexLoaded
      ? state.lastVisibleCount || state.entities.length
      : getFilters().find((f) => f.id === state.filter)?.count || state.lastVisibleCount || state.entities.length
    : total;
  return `
    <header class="masthead">
      <div class="masthead-inner">
        <a class="wordmark" href="#" data-action="home-reset">
          <span class="glyph">Encyclopedia<em>Galactica</em></span>
        </a>
        <div class="masthead-right">
          <div class="meta-counts">
            <div><span class="num">${fmtCount(showing)}</span>showing</div>
            <div><span class="num">${fmtCount(total)}</span>entities</div>
          </div>
          <div class="theme-toggle" role="group" aria-label="Theme">
            <button class="${state.theme === "dark" ? "on" : ""}" data-theme-choice="dark" title="Dark" aria-label="Dark theme">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"></path></svg>
            </button>
            <button class="${state.theme === "light" ? "on" : ""}" data-theme-choice="light" title="Light" aria-label="Light theme">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>
            </button>
          </div>
        </div>
      </div>
    </header>
  `;
}

function galleryIntroHTML(stats) {
  return `
    <div class="console">
      <div class="console-head">
        <h1>Every galaxy ever discussed.<sup class="hero-note-mark">*</sup></h1>
        <p class="hero-note"><span class="hero-note-mark">*</span>In &gt;2 sentences on arXiv.</p>
        <p class="console-lede">
          Look up a galaxy by name, descriptor, or drop its coordinates
          to see whether astronomers have discussed it.
          <strong>${fmtCount(stats.entities)}</strong> galaxies.
        </p>
      </div>
      <div class="searchbox">
        <div class="sb-group">
          <div class="sb-label">Name or keyword</div>
          <div class="sb-field">
            <svg class="sb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
            <input class="sb-input" data-field="heroName" placeholder="NGC 1068 · Sombrero · “tidal stream” · shell galaxy…" value="${escapeHTML(state.query)}" spellcheck="false" autocomplete="off">
            <button class="sb-clear ${state.query ? "" : "hidden"}" data-action="clear-search">clear</button>
          </div>
          <div class="sb-hint">Matches names, aliases, and the full text of every quoted passage in the corpus.</div>
        </div>
        <div class="sb-group">
          <div class="sb-label">Sky coordinates</div>
          <div class="coord-field">
            <label class="coord-cell"><span class="coord-lab">RA</span><input class="coord-input" data-field="ra" placeholder="187.7066  or  12 30 49" value="${escapeHTML(state.coordRA)}" spellcheck="false" autocomplete="off"></label>
            <label class="coord-cell"><span class="coord-lab">Dec</span><input class="coord-input" data-field="dec" placeholder="−0.0132  or  −00 00 47" value="${escapeHTML(state.coordDec)}" spellcheck="false" autocomplete="off"></label>
            <button class="find-btn" data-action="coord-search">Find nearest</button>
          </div>
          <div class="sb-hint">${
            state.coordError
              ? `<span class="sb-error">${escapeHTML(state.coordError)}</span>`
              : "Decimal degrees or sexagesimal. RA in hours, Dec in degrees. Returns the closest catalogued galaxies."
          }</div>
        </div>
      </div>
    </div>
  `;
}

function coordResultsHTML() {
  const results = state.coordResults || [];
  const raLabel = fmtRADeg(state.coordQueryRA);
  const decLabel = fmtDecDeg(state.coordQueryDec);
  if (!results.length) {
    return `<div class="coord-results">
      <div class="coord-results-head">
        <div class="crh-title">No catalogued galaxy near <strong>${escapeHTML(raLabel || "")}, ${escapeHTML(decLabel || "")}</strong></div>
        <button class="crh-clear" data-action="coord-clear">← Back to the atlas</button>
      </div>
      <p class="coord-empty">This patch of sky has no resolved galaxy mention in the corpus. The nearest entries are still listed when within a few degrees — try widening your coordinates or searching by name.</p>
    </div>`;
  }
  const best = results[0];
  return `<div class="coord-results">
    <div class="coord-results-head">
      <div class="crh-title">Nearest to <strong>${escapeHTML(raLabel)}, ${escapeHTML(decLabel)}</strong></div>
      <button class="crh-clear" data-action="coord-clear">← Back to the atlas</button>
    </div>
    <div class="hit-list">
      ${results.map((r, i) => {
        const e = r.entity;
        const img = imgUrl(e);
        const papers = e.paper_count_total || e.mention_count || 0;
        return `
          <a class="coord-hit ${i === 0 ? "best" : ""}" data-open="${escapeHTML(e.slug)}">
            <div class="hit-thumb">${
              img
                ? `<img src="${escapeHTML(img)}" alt="${escapeHTML(e.name)}" loading="eager" fetchpriority="high" decoding="async" data-img-slug="${escapeHTML(e.slug)}">`
                : `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${placeholderField(e.slug)}</svg>`
            }</div>
            <div class="hit-body">
              ${i === 0 ? '<div class="hit-flag">Closest match</div>' : ""}
              <div class="hit-name">${escapeHTML(e.name)}</div>
              <div class="hit-meta">${escapeHTML(fmtRADeg(e.ra_deg) || "")}, ${escapeHTML(fmtDecDeg(e.dec_deg) || "")} · ${fmtCount(papers)} paper${papers === 1 ? "" : "s"}</div>
            </div>
            <div class="hit-sep"><span class="sep-val">${escapeHTML(fmtSeparation(r.sep))}</span><span class="sep-lab">away</span></div>
          </a>`;
      }).join("")}
    </div>
  </div>`;
}

function filterbarHTML() {
  const chips = getFilters().map((filter) => {
    const count = filter.count ?? state.entities.filter(filter.test).length;
    return `
      <button class="chip ${state.filter === filter.id ? "active" : ""}" data-filter="${filter.id}">
        ${escapeHTML(filter.label)}
        <span class="ct">${fmtCount(count)}</span>
      </button>
    `;
  }).join("");
  const sorts = [
    ["mentions", "Number of mentions"],
    ["size", "Angular size"],
  ]
    .map(([key, label]) => {
      const active = state.sortKey === key;
      const dir = active ? ` <span class="sort-dir">${state.sortDir === "asc" ? "↑" : "↓"}</span>` : "";
      const next = active && state.sortDir === "desc" ? "low to high" : "high to low";
      return `<button class="${active ? `on ${state.sortDir}` : ""}" data-sort="${key}" title="Sort ${next}">${label}${dir}</button>`;
    })
    .join("");
  const allFilters = getFilters();
  const filterCount = allFilters.length - 1;
  const active = allFilters.find((f) => f.id === state.filter) || allFilters[0];
  const activeLabel = active.id === "all" ? "All galaxies" : active.label;
  const activeCount = active.count ?? state.entities.filter(active.test).length;
  return `
    <aside class="filter-rail ${state.filtersOpen ? "open" : ""}">
      <button class="filter-toggle ${state.filter !== "all" ? "is-filtered" : ""}" data-action="toggle-filters" aria-expanded="${state.filtersOpen ? "true" : "false"}">
        <span class="ft-lead">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="7" y1="12" x2="17" y2="12"></line><line x1="10" y1="18" x2="14" y2="18"></line></svg>
          <span>Filter &amp; sort</span>
        </span>
        <span class="ft-current">${escapeHTML(activeLabel)} <span class="ft-ct">${fmtCount(activeCount)}</span></span>
        <svg class="ft-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
      </button>
      <div class="rail-block">
        <div class="rail-head">Sort</div>
        <div class="rail-sort">${sorts}</div>
      </div>
      <div class="rail-block">
        <div class="rail-head">Filter <span class="rail-count">${fmtCount(filterCount)} concepts</span></div>
        <div class="rail-chips">
          ${chips}
        </div>
      </div>
    </aside>
  `;
}

function tileHTML(entity, index = 0) {
  const ra = entity.ra_deg;
  const dec = entity.dec_deg;
  const papers = entity.paper_count_total || entity.mention_count || 0;
  const corner = ra != null && dec != null ? `${ra.toFixed(1)}°, ${dec >= 0 ? "+" : ""}${dec.toFixed(1)}°` : "—";
  const image = imgUrl(entity);
  const href = dossierHref(entity.slug);
  if (!image) {
    return `
      <a class="tile noimg" href="${href}" data-open="${escapeHTML(entity.slug)}">
        <svg class="field" viewBox="0 0 100 100" preserveAspectRatio="none">${placeholderField(entity.slug)}</svg>
        <div class="scrim"></div>
        <div class="corner">${ra != null ? `${ra.toFixed(1)}°` : "—"}</div>
        ${papers > 0 ? `<div class="papers">${fmtCount(papers)}</div>` : ""}
        <div class="meta">
          <div class="name">${escapeHTML(entity.name)}</div>
        </div>
      </a>
    `;
  }
  return `
    <a class="tile" href="${href}" data-open="${escapeHTML(entity.slug)}">
      <img src="${escapeHTML(image)}" alt="${escapeHTML(entity.name)}" loading="eager" fetchpriority="high" decoding="async" data-img-slug="${escapeHTML(entity.slug)}" data-img-index="${index}">
      <div class="scrim"></div>
      <div class="corner">${escapeHTML(corner)}</div>
      ${papers > 5 ? `<div class="papers">${fmtCount(papers)}</div>` : ""}
      <div class="meta">
        <div class="name">${escapeHTML(entity.name)}</div>
      </div>
    </a>
  `;
}

function galleryResultsHTML() {
  const visible = visibleEntities();
  state.lastVisibleCount = visible.length;
  const shown = visible.slice(0, state.visibleLimit);
  const remaining = visible.length - shown.length;
  return `
    <div class="gallery-results">
      ${
        state.coordResults
          ? coordResultsHTML()
          : `<div class="gallery-body">
              <div class="gallery-main">
              ${
                visible.length === 0
                  ? '<div class="empty">No galaxies match. Try another term.</div>'
                  : `<div class="grid">${shown.map(tileHTML).join("")}</div>
                     ${
                       remaining > 0
                         ? `<div class="gallery-more">
                              <button data-action="show-more">Show ${fmtCount(Math.min(VISIBLE_STEP, remaining))} more</button>
                              <span>${fmtCount(shown.length)} of ${fmtCount(visible.length)}</span>
                            </div>`
                         : !state.fullIndexLoaded
                           ? '<div class="gallery-more"><span>Loading full atlas...</span></div>'
                         : ""
                     }`
              }
              </div>
              ${filterbarHTML()}
            </div>`
      }
    </div>
  `;
}

function galleryHTML() {
  const stats = {
    entities: state.meta?.entity_count || state.entities.length,
    mentions: state.meta?.resolved_mention_count || 0,
    sources:
      state.meta?.resolved_mention_count ||
      state.entities.reduce((sum, entity) => sum + (entity.src_count || 0), 0),
  };
  return `
    <div class="gallery-page">
      ${galleryIntroHTML(stats)}
      ${galleryResultsHTML()}
    </div>
    ${footerHTML(stats)}
  `;
}

function footerHTML(stats) {
  return `
    <footer class="footer">
      <div class="col">
        <h4>How this atlas was made</h4>
        <p>
          Galaxy mentions were resolved into <strong style="color: var(--ink)">${fmtCount(stats.entities)}</strong>
          one-arcsecond sky entities, preserving every paper-facing raw name alongside resolved aliases.
        </p>
      </div>
      <div class="col">
        <h4>Imagery</h4>
        <p>
          Imagery from alasky.cds.unistra.fr, mainly DESI Legacy Imaging Surveys DR10.
        </p>
      </div>
      <div class="col">
        <h4>Dossier contents</h4>
        <p>
          Each page contains resolved coordinates, UAT keywords, and the paper mentions.
        </p>
        <p><strong style="color: var(--ink)">${fmtCount(stats.sources)}</strong> paper mentions in total.</p>
      </div>
    </footer>
  `;
}

function currentSummary() {
  return state.entities.find((entity) => entity.slug === state.slug) || null;
}

async function loadEntity(summary) {
  if (!summary) return null;
  if (summary.sources) return summary;
  if (!state.loadedShards.has(summary.shard)) {
    const response = await fetch(`data/shards/${summary.shard}`);
    if (!response.ok) throw new Error(`Could not load ${summary.shard}`);
    const payload = await response.json();
    state.loadedShards.set(summary.shard, payload.entities || {});
  }
  return state.loadedShards.get(summary.shard)?.[summary.entity_id] || summary;
}

function overviewHTML(entity, sources) {
  const overview = String(entity.overview || "").trim();
  if (!overview) return "";
  return `<div class="overview"><p>${citedTextHTML(overview, citationIndexForSources(sources || []))}</p></div>`;
}

function heroHTML(entity) {
  const image = imgUrl(entity);
  if (image) {
    const scale = scaleBar(entity);
    return `
      <div class="hero">
        <img src="${escapeHTML(image)}" alt="${escapeHTML(entity.name)}" fetchpriority="high" data-img-slug="${escapeHTML(entity.slug)}">
        ${
          scale
            ? `<div class="scale"><span class="bar" style="width: ${scale.frac * 100}%; max-width: 40%"></span><span>${escapeHTML(scale.label)}</span></div>`
            : ""
        }
        <div class="compass">N↑ · E←</div>
      </div>
    `;
  }
  const initials = entity.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
  return `
    <div class="hero">
      <svg style="position:absolute;inset:0;width:100%;height:100%" viewBox="0 0 100 100" preserveAspectRatio="none">${placeholderField(entity.slug)}</svg>
      <div class="field-placeholder">
        <div class="glyph">${escapeHTML(initials)}</div>
        <div>No survey image</div>
      </div>
    </div>
  `;
}

function scaleBar(entity) {
  const fov = entity.image?.fov_deg || entity.fov_deg;
  if (!fov) return null;
  const totalArcmin = fov * 60;
  const target = totalArcmin * 0.25;
  if (!Number.isFinite(target) || target <= 0) return null;
  const mag = 10 ** Math.floor(Math.log10(target));
  const norm = target / mag;
  let pick = 1;
  if (norm >= 5) pick = 5;
  else if (norm >= 2) pick = 2;
  pick *= mag;
  return {
    frac: pick / totalArcmin,
    label: pick >= 1 ? `${formatScaleNumber(pick)}′` : `${formatScaleNumber(pick * 60)}″`,
  };
}

function formatScaleNumber(value) {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return String(Math.round(value));
  if (value >= 1) return value.toFixed(value >= 5 ? 0 : 1).replace(/\.0$/, "");
  return value.toFixed(1).replace(/\.0$/, "");
}

function titleBlockHTML(entity, sources) {
  const aliases = [
    ...(entity.aliases_local || []).filter((alias) => alias !== entity.name),
    ...(entity.aliases_external || []),
  ];
  const seen = new Set([entity.name.toLowerCase()]);
  const uniq = aliases.filter((alias) => {
    const key = String(alias).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const showAll = state.expandedAliases.has(entity.slug);
  const shown = showAll ? uniq : uniq.slice(0, 8);
  const more = uniq.length - 8;
  const raStr = fmtRADeg(entity.ra_deg);
  const decStr = fmtDecDeg(entity.dec_deg);
  const papers = entity.paper_count_eligible || entity.paper_count_total || 0;
  const sizeStr = entity.ang_major_arcmin && entity.ang_minor_arcmin
    ? `${fmtAng(entity.ang_major_arcmin)} × ${fmtAng(entity.ang_minor_arcmin)}`
    : entity.ang_major_arcmin
      ? fmtAng(entity.ang_major_arcmin)
      : null;
  const simbad = simbadUrl(entity.ra_deg, entity.dec_deg);

  return `
    <div class="title-block">
      <h1>${escapeHTML(entity.name)}</h1>
      ${
        uniq.length
          ? `<div class="aliases">
              ${shown.map((alias) => `<span class="alias">${escapeHTML(alias)}</span>`).join("")}
              ${!showAll && more > 0 ? `<span class="alias-more" data-action="aliases-more">+${more} more</span>` : ""}
              ${showAll && uniq.length > 8 ? '<span class="alias-more" data-action="aliases-less">show fewer</span>' : ""}
            </div>`
          : ""
      }
      ${overviewHTML(entity, sources)}
      <dl class="infobox">
        ${raStr ? `<dt>Right asc.</dt><dd>${escapeHTML(raStr)}</dd>` : ""}
        ${decStr ? `<dt>Declination</dt><dd>${escapeHTML(decStr)}</dd>` : ""}
        ${sizeStr ? `<dt>Angular size</dt><dd>${escapeHTML(sizeStr)}</dd>` : ""}
        <dt>Papers</dt>
        <dd class="sans"><span style="color: var(--ink)">${fmtCount(papers)}</span><span style="color: var(--ink-faint)"> paper${papers === 1 ? "" : "s"}</span></dd>
        ${entity.viewer_url ? `<dt>Imagery</dt><dd><a class="viewer-link" href="${escapeHTML(entity.viewer_url)}" target="_blank" rel="noopener">Legacy Survey viewer ${externalIcon()}</a></dd>` : ""}
        ${simbad ? `<dt>Catalog</dt><dd><a class="viewer-link" href="${escapeHTML(simbad)}" target="_blank" rel="noopener">SIMBAD coordinate lookup ${externalIcon()}</a></dd>` : ""}
      </dl>
    </div>
  `;
}

function externalIcon() {
  return '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 3h7v7"></path><path d="M13 3 4 12"></path></svg>';
}

function quoteBlockHTML(source, quote, index) {
  const quoteText = quote.quote || "";
  if (!quoteText) return "";
  const id = quote.quote_id || `${source.mention_id || source.paper_id}-quote-${index}`;
  const quoteUrl = ar5ivQuoteUrl(source.paper_id || source.arxiv_id, quoteText);
  // Whether a passage is collapsible depends on rendered height, not word
  // count, so the toggle starts hidden and refreshQuoteClamps() reveals it
  // only for passages that actually overflow the clamp.
  const expanded = state.expandedQuotes.has(id);
  return `
    <div class="quote-block">
      <blockquote class="quote ${expanded ? "" : "collapsed"}">${escapeHTML(quoteText)}</blockquote>
      <div class="quote-actions">
        <button class="quote-toggle" data-quote="${escapeHTML(id)}" hidden>${expanded ? "— Collapse passage" : "— Read full passage"}</button>
        ${
          quoteUrl
            ? `<a class="quote-jump" href="${escapeHTML(quoteUrl)}" target="_blank" rel="noopener">Jump to passage ${externalIcon()}</a>`
            : ""
        }
      </div>
    </div>
  `;
}

// Reveal the collapse toggle only for passages whose text overflows the
// clamped height; passages that already fit get no button and no clamp.
function refreshQuoteClamps(scope) {
  scope.querySelectorAll(".quote-block").forEach((block) => {
    const quote = block.querySelector(".quote");
    const toggle = block.querySelector(".quote-toggle");
    if (!quote || !toggle) return;
    const expanded = state.expandedQuotes.has(toggle.dataset.quote);
    quote.classList.add("collapsed");
    const overflows = quote.scrollHeight - quote.clientHeight > 1;
    toggle.hidden = !overflows;
    if (!overflows || expanded) quote.classList.remove("collapsed");
  });
}

function sourceHTML(source, index) {
  const absUrl = source.arxiv_url || arxivAbsUrl(source.paper_id || source.arxiv_id);
  const anchor = sourceAnchorId(source, index);
  const number = index + 1;
  const quotes = source.quotes?.length
    ? source.quotes
    : source.quote
      ? [{ quote_id: `${source.mention_id}-quote`, quote: source.quote }]
      : [];
  return `
    <div class="source" id="${escapeHTML(anchor)}" data-source-number="${number}">
      <div class="source-meta">
        <a class="source-number" href="#${escapeHTML(anchor)}" data-cite-source="${escapeHTML(anchor)}" data-source-number="${number}" aria-label="Paper ${number}">[${number}]</a>
        ${
          absUrl
            ? `<a class="paper" href="${escapeHTML(absUrl)}" target="_blank" rel="noopener" title="Open on arXiv">${escapeHTML(arxivLabel(source.paper_id || source.arxiv_id))}${externalIcon()}</a>`
            : `<span class="paper">${escapeHTML(arxivLabel(source.paper_id || source.arxiv_id))}</span>`
        }
        ${source.original_name ? `<span class="as">as “${escapeHTML(source.original_name)}”</span>` : ""}
      </div>
      <div class="source-body">
        ${source.summary ? `<p class="summary">${escapeHTML(source.summary)}</p>` : ""}
        ${quotes.map((quote, index) => quoteBlockHTML(source, quote, index)).join("")}
        ${
          source.uat_terms?.length
            ? `<div class="uat-row">${source.uat_terms.map((term) => `<span class="uat-tag" data-uat="${escapeHTML(term)}">${escapeHTML(term)}</span>`).join("")}</div>`
            : ""
        }
      </div>
    </div>
  `;
}

function relatedEntities(entity) {
  const mine = new Set(topicKeys(entity).slice(0, 5).map((topic) => String(topic).toLowerCase()));
  return state.entities
    .filter((candidate) => candidate.slug !== entity.slug && hasImage(candidate))
    .map((candidate) => {
      const theirs = new Set(topicKeys(candidate).slice(0, 5).map((topic) => String(topic).toLowerCase()));
      let overlap = 0;
      mine.forEach((term) => {
        if (theirs.has(term)) overlap += 1;
      });
      return { candidate, overlap };
    })
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || (b.candidate.paper_count_total || 0) - (a.candidate.paper_count_total || 0))
    .slice(0, 6)
    .map((item) => item.candidate);
}

function entryHTML(entity, loading = false) {
  const sources = orderedSourcesForEntry(entity);
  const sourceLimit = state.sourceLimits.get(entity.slug) || INITIAL_SOURCE_LIMIT;
  const shownSources = sources.slice(0, sourceLimit);
  const remainingSources = sources.length - shownSources.length;
  const related = relatedEntities(entity);
  return `
    <div class="entry-shell">
      <nav class="crumbs">
        <a href="#" data-action="home">Atlas</a>
        <span class="sep">/</span>
        <span class="cur">${escapeHTML(entity.name)}</span>
      </nav>
      <div class="entry-head">
        ${heroHTML(entity)}
        ${titleBlockHTML(entity, sources)}
      </div>
      <div class="entry-body">
        <div>
          <section class="section">
            <header class="section-head">
              <h2>From the literature</h2>
              <span class="count">${
                loading
                  ? "loading"
                  : remainingSources > 0
                    ? `${fmtCount(shownSources.length)} / ${fmtCount(sources.length)} papers`
                    : `${fmtCount(sources.length)} paper${sources.length === 1 ? "" : "s"}`
              }</span>
            </header>
            ${
              loading
                ? '<div class="empty">Loading dossier...</div>'
                : `<div class="sources">${shownSources.map(sourceHTML).join("")}</div>
                   ${
                     remainingSources > 0
                       ? `<div class="sources-more">
                            <button data-action="sources-more">Show ${fmtCount(Math.min(SOURCE_STEP, remainingSources))} more passages</button>
                            <button data-action="sources-all">Show all ${fmtCount(sources.length)}</button>
                          </div>`
                       : ""
                   }`
            }
          </section>
        </div>
        <aside class="entry-side">
          ${
            entity.uat_all?.length
              ? `<div class="side-block">
                  <h3>Unified Astronomy Thesaurus</h3>
                  <div class="uat-row" style="margin-top:0">
                    ${entity.uat_all.slice(0, 24).map((topic) => `<span class="uat-tag" data-uat="${escapeHTML(topic.term)}" title="${fmtCount(topic.count)} mention${topic.count === 1 ? "" : "s"} — filter the atlas">${escapeHTML(topic.term)}</span>`).join("")}
                  </div>
                </div>`
              : ""
          }
          ${
            related.length
              ? `<div class="side-block">
                  <h3>${entity.top_topic ? `Also tagged “${escapeHTML(entity.top_topic)}”` : "Galaxies sharing these topics"}</h3>
                  <div class="related-grid">
                    ${related.map((item) => `
                      <a class="r-tile" href="${dossierHref(item.slug)}" data-open="${escapeHTML(item.slug)}">
                        <img src="${escapeHTML(imgUrl(item))}" alt="${escapeHTML(item.name)}" loading="eager" fetchpriority="high" decoding="async" data-img-slug="${escapeHTML(item.slug)}">
                        <div class="rname">${escapeHTML(item.name)}</div>
                      </a>
                    `).join("")}
                  </div>
                </div>`
              : ""
          }
        </aside>
      </div>
    </div>
  `;
}

function updateMastheadCounts() {
  const total = state.meta?.entity_count || state.entities.length;
  const showing = state.route === "gallery"
    ? state.fullIndexLoaded
      ? state.lastVisibleCount || state.entities.length
      : getFilters().find((f) => f.id === state.filter)?.count || state.lastVisibleCount || state.entities.length
    : total;
  const counts = root.querySelector(".meta-counts");
  if (!counts) return;
  counts.innerHTML = `
    <div><span class="num">${fmtCount(showing)}</span>showing</div>
    <div><span class="num">${fmtCount(total)}</span>entities</div>
  `;
}

function updateSearchControls() {
  const clear = root.querySelector(".sb-clear[data-action='clear-search']");
  if (clear) clear.classList.toggle("hidden", !state.query);
}

function refreshGalleryResults() {
  if (state.route !== "gallery") {
    render();
    return;
  }
  const mount = root.querySelector(".gallery-results");
  if (!mount) {
    render();
    return;
  }
  mount.outerHTML = galleryResultsHTML();
  updateMastheadCounts();
  updateSearchControls();
  initImages(root);
}

function render({ focusSearch = false } = {}) {
  const summary = currentSummary();
  const loadedEntity = summary
    ? state.loadedShards.get(summary.shard)?.[summary.entity_id] || summary
    : null;
  const page = state.route === "entry"
    ? summary
      ? entryHTML(loadedEntity, !state.loadedShards.get(summary.shard)?.[summary.entity_id])
      : `<div class="entry-shell"><div class="empty">Loading dossier...</div></div>`
    : galleryHTML();
  root.innerHTML = `<div class="app">${mastheadHTML()}${page}</div>`;
  bindEvents();
  initImages(root);
  refreshQuoteClamps(root);
  const focusSel = state.focusField ? `[data-field="${state.focusField}"]` : (focusSearch ? '[data-field="heroName"]' : null);
  if (focusSel) {
    const input = root.querySelector(focusSel);
    if (input) {
      input.focus();
      if (input.value != null) input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  state.focusField = null;
}

function runNameSearch(value) {
  state.query = value;
  state.coordResults = null;
  resetVisibleLimit();
  if (state.route !== "gallery") {
    window.location.hash = "";
    return;
  }
  if (state.query.trim()) {
    loadFullIndex({ renderAfter: false }).then(() => {
      if (state.route === "gallery" && state.query.trim()) refreshGalleryResults();
    });
    ensureSearchIndex().then(() => {
      if (state.route === "gallery" && state.query.trim()) refreshGalleryResults();
    });
  }
  refreshGalleryResults();
}

function runCoordSearch() {
  const raEl = root.querySelector('[data-field="ra"]');
  const decEl = root.querySelector('[data-field="dec"]');
  const raRaw = raEl ? raEl.value : state.coordRA;
  const decRaw = decEl ? decEl.value : state.coordDec;
  state.coordRA = raRaw;
  state.coordDec = decRaw;
  const ra = parseRA(raRaw);
  const dec = parseDec(decRaw);
  if (ra == null || dec == null) {
    state.coordError = "Couldn’t read those coordinates. Try decimal degrees (e.g. 187.7066, −0.0132) or sexagesimal (12 30 49, −00 00 47).";
    state.coordResults = null;
    render();
    return;
  }
  state.coordError = null;
  state.coordQueryRA = ra;
  state.coordQueryDec = dec;
  const compute = () => {
    const hits = state.entities
      .filter((e) => e.ra_deg != null && e.dec_deg != null)
      .map((e) => ({ entity: e, sep: angularSeparation(ra, dec, e.ra_deg, e.dec_deg) }))
      .sort((a, b) => a.sep - b.sep)
      .slice(0, 8);
    state.coordResults = hits;
    render();
  };
  if (!state.fullIndexLoaded) loadFullIndex({ renderAfter: false }).then(compute);
  compute();
}

function bindEvents() {
  const nameInputs = root.querySelectorAll('[data-field="heroName"]');
  nameInputs.forEach((el) => {
    el.addEventListener("input", (event) => {
      state.focusField = event.target.dataset.field || null;
      runNameSearch(event.target.value);
    });
  });
  const raEl = root.querySelector('[data-field="ra"]');
  const decEl = root.querySelector('[data-field="dec"]');
  raEl?.addEventListener("input", (e) => { state.coordRA = e.target.value; });
  decEl?.addEventListener("input", (e) => { state.coordDec = e.target.value; });
  const coordKey = (e) => { if (e.key === "Enter") { e.preventDefault(); state.focusField = e.target.dataset.field; runCoordSearch(); } };
  raEl?.addEventListener("keydown", coordKey);
  decEl?.addEventListener("keydown", coordKey);
  root.onclick = handleClick;
}

function jumpToSource(anchor, sourceNumber) {
  const number = Number(sourceNumber);
  if (state.slug && Number.isFinite(number)) {
    const current = state.sourceLimits.get(state.slug) || INITIAL_SOURCE_LIMIT;
    if (number > current) {
      state.sourceLimits.set(state.slug, number);
      render();
    }
  }
  const scroll = () => {
    const target = document.getElementById(anchor);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("source-target");
    window.setTimeout(() => target.classList.remove("source-target"), 1800);
  };
  requestAnimationFrame(() => requestAnimationFrame(scroll));
}

function handleClick(event) {
  const citationLink = event.target.closest("[data-cite-source]");
  if (citationLink) {
    event.preventDefault();
    jumpToSource(citationLink.dataset.citeSource, citationLink.dataset.sourceNumber);
    return;
  }

  const themeButton = event.target.closest("[data-theme-choice]");
  if (themeButton) {
    setTheme(themeButton.dataset.themeChoice);
    return;
  }

  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) {
    state.searchMode = modeButton.dataset.mode;
    state.coordError = null;
    state.focusField = state.searchMode === "coord" ? "ra" : "heroName";
    render();
    return;
  }

  const uatTag = event.target.closest("[data-uat]");
  if (uatTag) {
    const term = uatTag.dataset.uat;
    state.filter = "uat:" + term;
    state.query = "";
    state.coordResults = null;
    resetVisibleLimit();
    if (!state.fullIndexLoaded) loadFullIndex({ renderAfter: true });
    if (state.route === "entry") { goHome(); }
    else { render(); }
    requestAnimationFrame(() => {
      const bar = root.querySelector(".filterbar");
      if (bar) window.scrollTo({ top: bar.getBoundingClientRect().top + window.scrollY - 90, behavior: "smooth" });
    });
    return;
  }

  const filterButton = event.target.closest("[data-filter]");
  if (filterButton) {
    state.filter = filterButton.dataset.filter;
    state.filtersOpen = false;
    state.coordResults = null;
    resetVisibleLimit();
    if (!state.fullIndexLoaded) loadFullIndex({ renderAfter: true });
    render();
    return;
  }

  const sortButton = event.target.closest("[data-sort]");
  if (sortButton) {
    if (state.sortKey === sortButton.dataset.sort) {
      state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
    } else {
      state.sortKey = sortButton.dataset.sort;
      state.sortDir = "desc";
    }
    resetVisibleLimit();
    if (!state.fullIndexLoaded) loadFullIndex({ renderAfter: true });
    refreshGalleryResults();
    return;
  }

  const quoteButton = event.target.closest("[data-quote]");
  if (quoteButton) {
    const id = quoteButton.dataset.quote;
    if (state.expandedQuotes.has(id)) state.expandedQuotes.delete(id);
    else state.expandedQuotes.add(id);
    render();
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    const action = actionButton.dataset.action;
    if (action === "toggle-filters") {
      state.filtersOpen = !state.filtersOpen;
      refreshGalleryResults();
    } else if (action === "home") {
      event.preventDefault();
      goHome();
    } else if (action === "home-reset") {
      event.preventDefault();
      resetAtlasState();
      goHome();
    } else if (action === "clear-search") {
      state.query = "";
      state.focusField = "heroName";
      resetVisibleLimit();
      render();
    } else if (action === "coord-search") {
      runCoordSearch();
    } else if (action === "coord-clear") {
      state.coordResults = null;
      state.coordError = null;
      render();
    } else if (action === "aliases-more") {
      if (state.slug) state.expandedAliases.add(state.slug);
      render();
    } else if (action === "aliases-less") {
      if (state.slug) state.expandedAliases.delete(state.slug);
      render();
    } else if (action === "show-more") {
      if (!state.fullIndexLoaded) {
        loadFullIndex({ renderAfter: true });
        return;
      }
      state.visibleLimit += VISIBLE_STEP;
      render();
    } else if (action === "sources-more") {
      if (state.slug) {
        const current = state.sourceLimits.get(state.slug) || INITIAL_SOURCE_LIMIT;
        state.sourceLimits.set(state.slug, current + SOURCE_STEP);
      }
      render();
    } else if (action === "sources-all") {
      if (state.slug) state.sourceLimits.set(state.slug, Number.POSITIVE_INFINITY);
      render();
    }
    return;
  }

  const openItem = event.target.closest("[data-open]");
  if (openItem) {
    // Let modifier/middle clicks fall through to native "open in new tab".
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    openEntity(openItem.dataset.open);
  }
}

function initImages(scope) {
  if (state.imageObserver) state.imageObserver.disconnect();
  const activate = (img) => {
    if (img.dataset.src) {
      img.src = img.dataset.src;
      delete img.dataset.src;
    }
  };
  const images = [...scope.querySelectorAll("img[data-img-slug]")];
  if (!("IntersectionObserver" in window)) {
    images.forEach(activate);
    return;
  }
  state.imageObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        activate(entry.target);
      });
    },
    { rootMargin: "900px 0px" },
  );
  images.forEach((img) => state.imageObserver.observe(img));
}

function entityBySlug(slug) {
  const summary = state.entities.find((item) => item.slug === slug);
  if (!summary) return null;
  return state.loadedShards.get(summary.shard)?.[summary.entity_id] || summary;
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("gw-theme", theme);
  } catch {}
  render();
}

function applyHash() {
  const hash = window.location.hash || "";
  const match = hash.match(/^#\/g\/(.+)$/);
  if (match) {
    const slug = decodeURIComponent(match[1]);
    state.slug = slug;
    state.route = "entry";
    const summary = currentSummary();
    render();
    if (summary) {
      window.scrollTo({ top: 0, behavior: "instant" });
      loadEntity(summary)
        .then(() => {
          if (state.route === "entry" && state.slug === slug) render();
        })
        .catch((error) => {
          console.error(error);
          render();
        });
    } else if (!state.fullIndexLoaded) {
      loadFullIndex({ renderAfter: true }).then(() => {
        if (state.route === "entry" && state.slug === slug) applyHash();
      });
    }
  } else {
    state.route = "gallery";
    state.slug = null;
    render();
  }
}

function dossierHref(slug) {
  return `#/g/${encodeURIComponent(slug)}`;
}

function openEntity(slug) {
  window.location.hash = dossierHref(slug);
}

function goHome() {
  window.location.hash = "";
  if (!window.location.hash) applyHash();
}

function handleKeys(event) {
  const activeTag = document.activeElement?.tagName;
  if (event.key === "/" && state.route === "gallery" && activeTag !== "INPUT") {
    event.preventDefault();
    root.querySelector('[data-field="heroName"]')?.focus();
  } else if (event.key === "Escape") {
    if (state.route === "entry") goHome();
    else {
      state.query = "";
      render({ focusSearch: true });
    }
  }
}

async function init() {
  try {
    const saved = localStorage.getItem("gw-theme");
    if (saved === "light" || saved === "dark") state.theme = saved;
  } catch {}
  document.documentElement.dataset.theme = state.theme;

  const response = await fetch("data/initial.json");
  if (!response.ok) throw new Error("Could not load data/initial.json");
  const payload = await response.json();
  state.meta = payload.meta || {};
  state.entities = decodeEntities(payload);

  window.addEventListener("hashchange", applyHash);
  window.addEventListener("keydown", handleKeys);
  window.addEventListener("resize", () => {
    if (state.route === "entry") refreshQuoteClamps(root);
  });
  applyHash();
  scheduleFullIndexLoad();
}

init().catch((error) => {
  root.innerHTML = `
    <div class="loading-splash">
      <div class="loading-brand">
        <div class="glyph">Encyclopedia<em>Galactica</em></div>
        <div class="status">${escapeHTML(error.message)}</div>
      </div>
    </div>
  `;
});
