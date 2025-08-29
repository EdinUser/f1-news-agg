// F1 RSS Aggregator – app.js (ES module)

// ===== Configuration & Storage =====
const COOL_DOWN_MS = 30 * 60 * 1000; // 30 minutes
const WORKER_BASE_DEFAULT = 'https://red-wood-fe7e.fallenangelbg.workers.dev/?url=';

const LS_KEYS = {
    FEEDS: 'f1Feeds',
    ARTICLES: 'f1Articles',      // map id -> article
    LAST_VISIT: 'f1LastVisit',
    LAST_FETCH: 'f1LastFetch',   // map feedUrl -> timestamp
    PROXY_BASE: 'f1ProxyBase'    // optional override (?url= style recommended)
};

// Curated to avoid the feeds that are erroring at the source.
const defaultFeeds = [
    { title: 'Autosport (F1)', url: 'https://www.autosport.com/rss/f1/news/' },
    { title: 'Motorsport.com (F1)', url: 'https://www.motorsport.com/rss/f1/news/' },
    { title: 'RaceFans', url: 'https://feeds.feedburner.com/f1fanatic' },
    { title: 'FIA Press Releases', url: 'https://www.fia.com/rss/press-release' },
    { title: 'BBC Sport (F1)', url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml' },
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

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} from source`);
    }

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

// ===== Core fetch per feed =====
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

            // Base description (plain text)
            const descriptionNode = item.querySelector('description, summary, content\\:encoded');
            let descriptionHtml = descriptionNode?.textContent || '';
            let description = toPlainText(descriptionHtml);

            // Prefer origin link for Google News if we can infer it from description
            let link = resolveUrl(rawLink, feed.url);
            if (gnews) {
                const g = extractOriginalFromGoogleDescription(descriptionHtml);
                if (g.link) link = resolveUrl(g.link, feed.url);
                title = cleanGoogleNewsTitle(title);
                description = g.text; // already plain text
            }

            const guid =
                item.querySelector('guid')?.textContent ||
                item.querySelector('id')?.textContent || // Atom
                '';

            const pubDate =
                item.querySelector('pubDate')?.textContent ||
                item.querySelector('updated')?.textContent ||
                item.querySelector('published')?.textContent ||
                new Date().toISOString();

            const image = getImageFromItem(item, link || feed.url);

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
    for (const a of items) {
        const isNew = !a.seen && new Date(a.pubDate).getTime() > (lastVisit || 0);
        if (isNew) newCount++;
        const col = document.createElement('div');
        col.className = 'col-12 col-md-6 col-lg-4';
        col.innerHTML = articleCardHTML(a, isNew);
        grid.appendChild(col);
    }
    newCountBadge.textContent = `${newCount} new`;
}

function articleCardHTML(a, isNew) {
    const img = a.image ? `<img src="${a.image}" class="card-img-top" alt="" onerror="this.remove()">` : '';
    const date = new Date(a.pubDate);
    return `
  <div class="card h-100 ${isNew ? 'article-new' : ''}">
    ${img}
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
