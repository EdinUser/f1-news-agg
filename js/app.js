// F1 RSS Aggregator – app.js (ES module)

// ===== Configuration & Storage =====
const COOL_DOWN_MS = 30 * 60 * 1000; // 30 minutes
const WORKER_BASE_DEFAULT = 'https://red-wood-fe7e.fallenangelbg.workers.dev/?url=';
const MAX_ITEM_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const ENRICH_NON_GNEWS = true; // also enrich non-GNews items that lack images

const LS_KEYS = {
    FEEDS: 'f1Feeds',
    ARTICLES: 'f1Articles',      // map id -> article
    LAST_VISIT: 'f1LastVisit',
    LAST_FETCH: 'f1LastFetch',   // map feedUrl -> timestamp
    PROXY_BASE: 'f1ProxyBase'    // optional override (?url= style recommended)
};

// Curated to avoid the feeds that are erroring at the source.
const defaultFeeds = [
    { title: 'Formula 1 Official', url: 'https://news.google.com/rss/search?q=site:formula1.com/en/latest&hl=en-GB&gl=GB&ceid=GB:en' },
    { title: 'Autosport (F1)', url: 'https://www.autosport.com/rss/f1/news/' },
    { title: 'Motorsport.com (F1)', url: 'https://www.motorsport.com/rss/f1/news/' },
    { title: 'RaceFans', url: 'https://feeds.feedburner.com/f1fanatic' },
    { title: 'FIA Press Releases', url: 'https://www.fia.com/rss/press-release' },
    { title: 'BBC Sport (F1)', url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml' },
    { title: 'Sky News (F1)', url: 'https://news.google.com/rss/search?q=site:skysports.com/f1&hl=en-GB&gl=GB&ceid=GB:en' },
    { title: 'ESPN (F1)', url: 'https://news.google.com/rss/search?q=site:espn.com/f1&hl=en-GB&gl=GB&ceid=GB:en' },
    { title: 'Grand Prix 247 (mirror)', url: 'https://news.google.com/rss/search?q=site:grandprix247.com&hl=en-GB&gl=GB&ceid=GB:en' },
    // You can try these later if you like, but they often block proxies:
    // { title: 'PlanetF1', url: 'https://www.planetf1.com/feed/' },
    // { title: 'Grandprix.com', url: 'https://www.grandprix.com/rss.xml' },
];

function loadJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

// State
let feeds    = loadJSON(LS_KEYS.FEEDS, defaultFeeds);
let articles = loadJSON(LS_KEYS.ARTICLES, {});
let lastVisit = Number(localStorage.getItem(LS_KEYS.LAST_VISIT) || 0);
let lastFetch = loadJSON(LS_KEYS.LAST_FETCH, {});
let proxyBase = localStorage.getItem(LS_KEYS.PROXY_BASE) || WORKER_BASE_DEFAULT; // default to your Worker

pruneOldAndSanitize();

// ===== Proxy builder & RSS fetch =====
function buildProxyUrl(url) {
    const base = proxyBase || WORKER_BASE_DEFAULT;
    if (/\?url=$/.test(base)) return base + encodeURIComponent(url);
    if (base.endsWith('/raw?url=')) return base + encodeURIComponent(url);
    if (base.endsWith('/')) return base + url;
    return base + (base.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url);
}

async function fetchRSS(url) {
    const proxied = buildProxyUrl(url);
    let res;
    try {
        res = await fetch(proxied, { cache: 'no-store', redirect: 'follow' });
    } catch (e) {
        throw new Error(`Network error: ${e.message}`);
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} from source`);

    let text = await res.text();
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!/xml|rss|atom/.test(ct)) {
        const looksXml = text.startsWith('<?xml') || /<rss\b|<feed\b/i.test(text);
        if (!looksXml) throw new Error('Received non-XML (likely HTML error/anti-bot page)');
    }

    // Repair stray ampersands (avoid “undefined entity” XML errors)
    text = text.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9a-fA-F]+;)/g, '&amp;');

    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML parse error');

    const items = [...doc.querySelectorAll('item, entry')];
    if (!items.length) throw new Error('No items in feed');
    return items;
}

// ===== UI Elements =====
const grid = document.getElementById('articlesGrid');
const emptyState = document.getElementById('emptyState');
const newCountBadge = document.getElementById('newCount');
const cooldownBadge = document.getElementById('cooldownBadge');
const refreshBtn = document.getElementById('refreshBtn');
const markVisitedBtn = document.getElementById('markVisitedBtn');
const feedFilters = document.getElementById('feedFilters');
const searchInput = document.getElementById('searchInput');

const proxyBaseInput = document.getElementById('proxyBaseInput');
const feedsList = document.getElementById('feedsList');
const newFeedTitle = document.getElementById('newFeedTitle');
const newFeedUrl = document.getElementById('newFeedUrl');
const addFeedBtn = document.getElementById('addFeedBtn');
const saveFeedsBtn = document.getElementById('saveFeedsBtn');

const refreshSpinner = document.getElementById('refreshSpinner');

// ===== Helpers =====
const isCooldownActive = () => {
    const last = Math.max(...Object.values(lastFetch), 0);
    const remain = COOL_DOWN_MS - (Date.now() - last);
    return Math.max(remain, 0);
};

function updateCooldownUI() {
    const remain = isCooldownActive();
    const mm = String(Math.floor(remain / 60000)).padStart(2, '0');
    const ss = String(Math.floor((remain % 60000) / 1000)).padStart(2, '0');
    cooldownBadge.textContent = `${mm}:${ss}`;
    refreshBtn.disabled = remain > 0;
    cooldownBadge.className = `badge ${remain > 0 ? 'bg-secondary' : 'bg-success'}`;
}

setInterval(updateCooldownUI, 1000);
updateCooldownUI();

function makeId(feedUrl, link, guid) {
    return btoa(unescape(encodeURIComponent(`${feedUrl}|${guid || link}`))).replace(/=+$/, '');
}

function sanitize(str) { return (str || '').replace(/\s+/g, ' ').trim(); }

function resolveUrl(maybeUrl, base) {
    try { return new URL(maybeUrl, base).href; } catch { return maybeUrl; }
}

// ---------- Description & Google News helpers ----------
function toPlainText(maybeHtml) {
    if (!maybeHtml) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = maybeHtml;
    return sanitize(tmp.textContent || tmp.innerText || '');
}

function isGoogleNewsFeed(feedUrl) {
    try { return new URL(feedUrl).host.endsWith('news.google.com'); }
    catch { return false; }
}

function cleanGoogleNewsTitle(title) {
    // Remove trailing " - sitename"
    return (title || '').replace(/\s+-\s+[^-]+$/, '').trim();
}

function extractOriginalFromGoogleDescription(descHtml) {
    // Try to find a direct origin link in the description:
    // 1) <a href="...url=ORIGIN...">
    // 2) first <a> whose host is NOT news.google.com
    const tmp = document.createElement('div');
    tmp.innerHTML = descHtml || '';

    let best = null;
    const anchors = tmp.querySelectorAll('a[href]');
    for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        try {
            const u = new URL(href, 'https://news.google.com');
            const urlParam = u.searchParams.get('url');
            if (urlParam) return { link: urlParam, text: sanitize(tmp.textContent || tmp.innerText || '') };
            if (!u.host.endsWith('news.google.com')) {
                best = u.href;
                break;
            }
        } catch {}
    }
    return { link: best, text: sanitize(tmp.textContent || tmp.innerText || '') };
}

// Pull thumbnail
function getImageFromItem(item, baseForRel) {
    const enc = item.querySelector('enclosure[url]');
    if (enc) return resolveUrl(enc.getAttribute('url'), baseForRel);

    const media = item.querySelector('media\\:content, media\\:thumbnail, content');
    if (media && media.getAttribute('url')) return resolveUrl(media.getAttribute('url'), baseForRel);

    const desc = item.querySelector('description, content\\:encoded, summary');
    if (desc) {
        const tmp = document.createElement('div');
        tmp.innerHTML = desc.textContent;
        const img = tmp.querySelector('img');
        if (img?.getAttribute('src')) return resolveUrl(img.getAttribute('src'), baseForRel);
    }
    return null;
}

// Identify "generic" Google thumbs we want to replace
function isGoogleGenericThumb(imgUrl) {
    if (!imgUrl || typeof imgUrl !== 'string') return false;
    try {
        const u = new URL(imgUrl, 'https://news.google.com'); // tolerate schemeless
        const host = u.host.toLowerCase();
        const path = u.pathname.toLowerCase();

        // Any google cache/CDN host → treat as generic
        if (host.includes('googleusercontent.com')) return true;    // lh3.googleusercontent.com etc.
        if (host.includes('gstatic.com')) return true;              // encrypted-tbn*.gstatic.com etc.
        if (host.includes('news.google.com')) return true;          // direct news assets/cached thumbs

        // Common Google branding/static paths
        if (path.includes('/news/static/')) return true;
        if (path.includes('/img/branding')) return true;
        if (path.includes('google_news')) return true;
        return false;
    } catch {
        // As a last resort, a substring test (handles weird relative values)
        return /googleusercontent\.com|gstatic\.com|news\.google\.com|google_news|\/img\/branding/i.test(imgUrl);
    }
}

// Prune >1 week and sanitize stored Google thumbs to null
function pruneOldAndSanitize() {
    const now = Date.now();
    let changed = false;
    for (const [id, a] of Object.entries(articles)) {
        const t = Date.parse(a.pubDate || 0) || 0;
        if (!t || (now - t) > MAX_ITEM_AGE_MS) { delete articles[id]; changed = true; continue; }
        if (isGoogleNewsFeed(a.feedUrl) && a.image && isGoogleGenericThumb(a.image)) {
            a.image = null; changed = true;      // force lazy enrichment
        }
    }
    if (changed) saveJSON(LS_KEYS.ARTICLES, articles);
}

// ===== Core fetch per feed (with Google-thumbs cleanup & 1-week filter) =====
async function updateFromFeed(feed) {
    const now = Date.now();
    const last = lastFetch[feed.url] || 0;
    if (now - last < COOL_DOWN_MS) return { added: 0, error: null };

    try {
        const nodes = await fetchRSS(feed.url);
        const gnews = isGoogleNewsFeed(feed.url);

        let added = 0;
        for (const item of nodes) {
            let title = sanitize(item.querySelector('title')?.textContent);
            const rawLinkEl = item.querySelector('link');
            const rawLink = rawLinkEl?.getAttribute?.('href') || rawLinkEl?.textContent || '';
            const guid = item.querySelector('guid')?.textContent || item.querySelector('id')?.textContent || '';

            const pubDate =
                item.querySelector('pubDate')?.textContent ||
                item.querySelector('updated')?.textContent ||
                item.querySelector('published')?.textContent ||
                new Date().toISOString();

            const pubMs = Date.parse(pubDate) || now;
            if ((now - pubMs) > MAX_ITEM_AGE_MS) continue; // too old

            const descriptionNode = item.querySelector('description, summary, content\\:encoded');
            let descriptionHtml = descriptionNode?.textContent || '';
            let description = toPlainText(descriptionHtml);

            let link = resolveUrl(rawLink, feed.url);
            if (gnews) {
                const g = extractOriginalFromGoogleDescription(descriptionHtml);
                if (g.link) link = resolveUrl(g.link, feed.url);
                title = cleanGoogleNewsTitle(title);
                description = g.text;
            }

            let image = getImageFromItem(item, link || feed.url);
            if (gnews && image && isGoogleGenericThumb(image)) image = null;

            const id = makeId(feed.url, link, guid);
            if (!articles[id]) {
                articles[id] = {
                    id, title, link, guid, pubDate, description, image,
                    feedTitle: feed.title, feedUrl: feed.url, seen: false
                };
                added++;
            }
        }

        lastFetch[feed.url] = now;
        saveJSON(LS_KEYS.LAST_FETCH, lastFetch);
        saveJSON(LS_KEYS.ARTICLES, articles);
        return { added, error: null };
    } catch (e) {
        return { added: 0, error: `${feed.title}: ${e.message}` };
    }
}

// in refreshAll()
async function refreshAll() {
    if (isCooldownActive() > 0) return;
    refreshBtn.classList.add('disabled');
    refreshSpinner?.classList.remove('d-none');   // SHOW spinner
    try {
        const results = await Promise.allSettled(feeds.map(updateFromFeed));
        const totalAdded = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? (r.value.added ?? r.value) : 0), 0);
        const errors = results
            .filter(r => r.status === 'fulfilled' && r.value.error)
            .map(r => r.value.error);

        pruneOldAndSanitize();
        render();

        toast(`Fetched. ${totalAdded} new article${totalAdded !== 1 ? 's' : ''}.`);
        if (errors.length) toast(errors.join('<br>'), true);
    } catch (e) {
        toast('Fetch error: ' + e.message, true);
    } finally {
        refreshSpinner?.classList.add('d-none');    // HIDE spinner
        refreshBtn.classList.remove('disabled');
        updateCooldownUI();
    }
}

function markSeenNow() {
    const now = Date.now();
    for (const a of Object.values(articles)) a.seen = true;
    localStorage.setItem(LS_KEYS.LAST_VISIT, String(now));
    lastVisit = now;
    saveJSON(LS_KEYS.ARTICLES, articles);
    render();
}

// ===== Filters & render =====
function makeFilterBtn(label, value, active = false) {
    const btn = document.createElement('button');
    btn.className = `btn btn-sm ${active ? 'btn-primary' : 'btn-outline-light'}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
        activeFilter = value;
        [...feedFilters.children].forEach(c => c.className = 'btn btn-sm btn-outline-light');
        btn.className = 'btn btn-sm btn-primary';
        renderArticles();
    });
    return btn;
}

function renderFilters() {
    feedFilters.innerHTML = '';
    const allBtn = makeFilterBtn('All', null, true);
    feedFilters.appendChild(allBtn);
    feeds.forEach(f => feedFilters.appendChild(makeFilterBtn(f.title, f.title)));
}

let activeFilter = null;

function renderArticles() {
    const q = searchInput.value.toLowerCase().trim();
    const items = Object.values(articles)
        .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
        .filter(a => !activeFilter || a.feedTitle === activeFilter)
        .filter(a => !q || a.title.toLowerCase().includes(q) || a.feedTitle.toLowerCase().includes(q));

    grid.innerHTML = '';
    if (!items.length) {
        emptyState.classList.remove('d-none');
        newCountBadge.textContent = '0 new';
        return;
    }
    emptyState.classList.add('d-none');

    let newCount = 0;
    const needObserve = [];

    for (const a of items) {
        const isNew = !a.seen && new Date(a.pubDate).getTime() > (lastVisit || 0);
        if (isNew) newCount++;
        const col = document.createElement('div');
        col.className = 'col-12 col-md-6 col-lg-4';
        col.innerHTML = articleCardHTML(a, isNew);
        grid.appendChild(col);

        // Decide whether we need to lazy-enrich this card
        const isG = isGoogleNewsFeed(a.feedUrl);
        let effectiveImage = a.image || null;
        if (isG && effectiveImage && isGoogleGenericThumb(effectiveImage)) {
            effectiveImage = null; // force placeholder + lazy
        }
        if ((isG || ENRICH_NON_GNEWS) && !effectiveImage) {
            needObserve.push(a.id);
        }
    }
    newCountBadge.textContent = `${newCount} new`;

    // setup observer and register placeholders
    setupCardObserver();
    for (const id of needObserve) observeCardForLazy(id);
}

function articleCardHTML(a, isNew) {
    const isG = isGoogleNewsFeed(a.feedUrl);
    let effectiveImage = a.image || null;
    // Extra guard right before rendering:
    if (!effectiveImage || (isG && isGoogleGenericThumb(effectiveImage))) {
        effectiveImage = null;
    }

    const imgHTML = effectiveImage
        ? `<img src="${effectiveImage}" class="card-img-top" alt="" onerror="this.remove()">`
        : `<div class="image-holder w-100 ratio ratio-16x9 bg-secondary-subtle" data-id="${a.id}" style="min-height: 140px;"></div>`;

    const date = new Date(a.pubDate);
    return `
  <div class="card h-100 ${isNew ? 'article-new' : ''}">
    ${imgHTML}
    <div class="card-body d-flex flex-column">
      <div class="d-flex align-items-center mb-2">
        <span class="badge bg-info-subtle text-info-emphasis badge-feed me-2">${a.feedTitle}</span>
        <small class="muted ms-auto" title="${date.toISOString()}"><i class="bi bi-clock"></i> ${date.toLocaleString()}</small>
      </div>
      <h6 class="card-title"><a class="link-light" href="${a.link}" target="_blank" rel="noopener noreferrer">${a.title}</a></h6>
      <p class="card-text truncated mt-2 muted truncate-3">${(a.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
      <div class="mt-auto d-flex gap-2">
        <a class="btn btn-sm btn-outline-light" href="${a.link}" target="_blank" rel="noopener noreferrer"><i class="bi bi-box-arrow-up-right"></i> Open</a>
        <button class="btn btn-sm btn-outline-success" data-id="${a.id}" onclick="markOneSeen('${a.id}')"><i class="bi bi-check2"></i> Seen</button>
      </div>
    </div>
  </div>`;
}

// ===== Lazy image enrichment =====

// Concurrency-limited queue
const LAZY_MAX_CONCURRENCY = 2;
const LAZY_FETCH_TIMEOUT_MS = 8000; // conservative
let lazyInFlight = 0;
const lazyQueue = [];
const lazyAttempted = new Set();   // id set: avoid repeats per session

function timeoutPromise(ms) {
    return new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms));
}

function extractImageFromHTML(html) {
    // Meta tags
    const patterns = [
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
        /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["'][^>]*>/i,
        /<meta[^>]+property=["']og:image:url["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m && m[1]) return m[1];
    }

    // JSON-LD "image"
    try {
        const ldMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const block of ldMatches) {
            const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
            const obj = JSON.parse(json);
            const candidates = Array.isArray(obj) ? obj : [obj];
            for (const o of candidates) {
                const image = o?.image;
                if (typeof image === 'string') return image;
                if (Array.isArray(image) && image.length) return image[0];
                if (image && typeof image === 'object' && image.url) return image.url;
            }
        }
    } catch (_) {}

    // First <img src>
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
    if (imgMatch && imgMatch[1]) return imgMatch[1];

    return null;
}

async function fetchOGImageViaProxy(articleUrl) {
    const proxied = buildProxyUrl(articleUrl);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), LAZY_FETCH_TIMEOUT_MS);
    try {
        const resp = await Promise.race([
            fetch(proxied, { cache: 'no-store', redirect: 'follow', signal: controller.signal }),
            timeoutPromise(LAZY_FETCH_TIMEOUT_MS)
        ]);
        if (!resp || !resp.ok) throw new Error(`HTTP ${resp?.status || 'ERR'}`);
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (!/html|text\/plain/.test(ct)) throw new Error('Non-HTML');
        const html = await resp.text();
        return extractImageFromHTML(html);
    } finally {
        clearTimeout(t);
    }
}

async function processLazyJob(id) {
    if (lazyAttempted.has(id)) return;
    lazyAttempted.add(id);

    const a = articles[id];
    if (!a) return;

    const isG = isGoogleNewsFeed(a.feedUrl);
    // If an image exists AND it's not a Google generic thumb, skip.
    if (a.image && !(isG && isGoogleGenericThumb(a.image))) return;
    if (!isG && !ENRICH_NON_GNEWS) return;
    if (!a.link) return;

    try {
        const img = await fetchOGImageViaProxy(a.link);
        if (img) {
            a.image = resolveUrl(img, a.link);
            saveJSON(LS_KEYS.ARTICLES, articles);
            // Update the DOM card if it's currently rendered
            const holder = document.querySelector(`.image-holder[data-id="${id}"]`);
            if (holder) {
                const imgEl = document.createElement('img');
                imgEl.className = 'card-img-top';
                imgEl.alt = '';
                imgEl.src = a.image;
                imgEl.onerror = () => imgEl.remove();
                holder.replaceWith(imgEl);
            }
        }
    } catch (_) {
        // Silently ignore to keep UI smooth
    }
}

function pumpLazyQueue() {
    while (lazyInFlight < LAZY_MAX_CONCURRENCY && lazyQueue.length) {
        const id = lazyQueue.shift();
        lazyInFlight++;
        processLazyJob(id).finally(() => {
            lazyInFlight--;
            pumpLazyQueue();
        });
    }
}

// IntersectionObserver to enqueue visible cards without images
let cardObserver = null;
function setupCardObserver() {
    if (cardObserver) cardObserver.disconnect();
    cardObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                const el = e.target;
                const id = el.getAttribute('data-id');
                if (id && !lazyAttempted.has(id)) {
                    lazyQueue.push(id);
                    pumpLazyQueue();
                }
                cardObserver.unobserve(el);
            }
        }
    }, { root: null, rootMargin: '200px', threshold: 0.01 }); // start a bit before visible
}

function observeCardForLazy(id) {
    const ph = document.querySelector(`.image-holder[data-id="${id}"]`);
    if (ph) cardObserver.observe(ph);
}

// Expose for inline handler
window.markOneSeen = (id) => {
    if (articles[id]) {
        articles[id].seen = true;
        saveJSON(LS_KEYS.ARTICLES, articles);
        renderArticles();
    }
};

function render() { renderFilters(); renderArticles(); }

// ===== Feeds Modal Logic =====
function renderFeedsEditor() {
    if (proxyBaseInput) proxyBaseInput.value = proxyBase || '';
    feedsList.innerHTML = '';
    feeds.forEach((f, idx) => {
        const row = document.createElement('div');
        row.className = 'list-group-item bg-dark text-light border-secondary d-flex align-items-center gap-2';
        row.innerHTML = `
      <input class="form-control bg-dark text-light border-secondary flex-grow-1 me-2 feed-title" value="${f.title}">
      <input class="form-control bg-dark text-light border-secondary flex-grow-1 me-2 feed-url" value="${f.url}">
      <button class="btn btn-outline-danger btn-sm"><i class="bi bi-trash"></i></button>`;
        row.querySelector('button').addEventListener('click', () => { feeds.splice(idx, 1); renderFeedsEditor(); });
        feedsList.appendChild(row);
    });
}

addFeedBtn?.addEventListener('click', () => {
    if (!newFeedTitle.value || !newFeedUrl.value) return;
    feeds.push({ title: newFeedTitle.value.trim(), url: newFeedUrl.value.trim() });
    newFeedTitle.value = '';
    newFeedUrl.value = '';
    renderFeedsEditor();
});

saveFeedsBtn?.addEventListener('click', () => {
    const titles = feedsList.querySelectorAll('.feed-title');
    const urls = feedsList.querySelectorAll('.feed-url');
    feeds = Array.from(titles).map((t, i) => ({ title: t.value.trim(), url: urls[i].value.trim() }))
        .filter(f => f.title && f.url);
    proxyBase = proxyBaseInput.value.trim() || WORKER_BASE_DEFAULT;
    saveJSON(LS_KEYS.FEEDS, feeds);
    localStorage.setItem(LS_KEYS.PROXY_BASE, proxyBase);
    render();
});

// ===== Toasts =====
function toast(msg, danger = false) {
    const el = document.createElement('div');
    el.className = `position-fixed bottom-0 end-0 p-3`;
    el.style.zIndex = 1080;
    el.innerHTML = `
    <div class="toast text-bg-${danger ? 'danger' : 'dark'} show" role="alert" aria-live="assertive" aria-atomic="true">
      <div class="toast-body d-flex align-items-center gap-2">
        <i class="bi ${danger ? 'bi-bug-fill' : 'bi-info-circle'}"></i>
        <div>${msg}</div>
        <button type="button" class="btn-close btn-close-white ms-auto" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
    </div>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
}

// ===== Events =====
refreshBtn?.addEventListener('click', refreshAll);
markVisitedBtn?.addEventListener('click', markSeenNow);
searchInput?.addEventListener('input', renderArticles);
document.getElementById('feedsModal')?.addEventListener('show.bs.modal', renderFeedsEditor);

// Initial render
render();
