// ============================================================
// lowKey-Stream — Frontend Application
// ============================================================

const state = {
    tunnelUrl: null,
    videos: [],
    filteredVideos: [],     // videos shown in player sidebar (prev/next)
    folderTree: { _files: [], _subfolders: {} },
    drillPath: [],
    currentVideo: null,
    serverOnline: false,
    pendingSeek: null,
    progressInterval: null,
    view: 'browse',         // 'browse' | 'player'
    metaCache: new Map(),   // path → metadata object (null = in-flight)
    browseSections: [],     // [{ title, videos, drillPath }]  — for file cards
    browseFolderCards: [],  // [{ name, node, drillPath, firstFilePath }] — for folder cards
    watchProgress: new Map(), // path → { position, updated_at, completed }
    lastSavedPosition: 0,
};

// LRU cache helpers (Map preserves insertion order → easy LRU via keys().next())
const CACHE_MAX_SIZE = 500;

function cacheGet(path) {
    return state.metaCache.get(path);
}

function cacheSet(path, value) {
    if (state.metaCache.size >= CACHE_MAX_SIZE) {
        state.metaCache.delete(state.metaCache.keys().next().value);
    }
    state.metaCache.set(path, value);
}

function cacheHas(path) {
    return state.metaCache.has(path);
}

// Card DOM index maps for O(1) metadata update
const cardIndex       = new Map(); // video.path        → .poster-card element
const folderCardIndex = new Map(); // firstFilePath     → folder .poster-card element

// ── DOM references ─────────────────────────────────────────

const videoPlayer        = document.getElementById('videoPlayer');
const videoContainer     = document.getElementById('videoContainer');
const videoOverlay       = document.getElementById('videoOverlay');
const videoItems         = document.getElementById('videoItems');
const searchInput        = document.getElementById('searchInput');
const statusDot          = document.getElementById('statusDot');
const statusText         = document.getElementById('statusText');
const videoCount         = document.getElementById('videoCount');
const nowPlayingTitle    = document.getElementById('nowPlayingTitle');
const nowPlayingMeta     = document.getElementById('nowPlayingMeta');
const formatWarning      = document.getElementById('formatWarning');
const formatWarningText  = document.getElementById('formatWarningText');
const audioTrackSelector = document.getElementById('audioTrackSelector');
const resumeBanner       = document.getElementById('resumeBanner');
const resumeText         = document.getElementById('resumeText');
const movieInfo          = document.getElementById('movieInfo');
const browseView         = document.getElementById('browseView');
const playerView         = document.getElementById('playerView');
const browseSectionsEl   = document.getElementById('browseSections');
const browseSearchInput  = document.getElementById('browseSearchInput');
const volumeSlider       = document.getElementById('volumeSlider');
const volumeDisplay      = document.getElementById('volumeDisplay');
const muteBtn            = document.getElementById('muteBtn');
const shortcutsModal     = document.getElementById('shortcutsModal');

// ISO 639 language code → display name
const LANG_NAMES = {
    eng: 'English', rum: 'Romanian', ron: 'Romanian',
    spa: 'Spanish', fre: 'French',   fra: 'French',
    ger: 'German',  deu: 'German',   ita: 'Italian',
    por: 'Portuguese', dut: 'Dutch', nld: 'Dutch',
    pol: 'Polish',  hun: 'Hungarian', jpn: 'Japanese',
    kor: 'Korean',  chi: 'Chinese',  zho: 'Chinese',
    rus: 'Russian', ara: 'Arabic',   tur: 'Turkish',
    swe: 'Swedish', dan: 'Danish',   nor: 'Norwegian',
    fin: 'Finnish', cze: 'Czech',    ces: 'Czech',
    und: 'Unknown',
};

// ============================================================
// Utilities
// ============================================================

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function formatDuration(seconds) {
    if (!seconds || seconds < 1) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatTime(seconds) {
    const h  = Math.floor(seconds / 3600);
    const m  = Math.floor((seconds % 3600) / 60);
    const s  = Math.floor(seconds % 60);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Focus trap for keyboard accessibility in modal-like elements
let _focusTrapCleanup = null;

function trapFocus(el) {
    releaseFocus();
    const focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    function handler(e) {
        if (e.key !== 'Tab') return;
        if (e.shiftKey) {
            if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
            if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
        }
    }
    el.addEventListener('keydown', handler);
    first?.focus();
    _focusTrapCleanup = () => el.removeEventListener('keydown', handler);
}

function releaseFocus() {
    if (_focusTrapCleanup) { _focusTrapCleanup(); _focusTrapCleanup = null; }
}

// ============================================================
// Initialization
// ============================================================

async function init() {
    updateStatus('connecting');
    try {
        const response = await fetch('config.json');
        const config = await response.json();
        state.tunnelUrl = config.tunnel_url;

        if (!state.tunnelUrl) {
            updateStatus('offline', 'Tunnel URL not configured in config.json.');
            renderOfflineState('Tunnel URL not configured in config.json.');
            return;
        }

        const online = await checkServerHealth();
        if (online) {
            loadAllProgress();
            await refreshVideoList();
        } else {
            renderOfflineState();
        }
    } catch (error) {
        console.error('Failed to load config:', error);
        updateStatus('offline', 'Could not load config. Is the site deployed?');
        renderOfflineState('Could not load config.json.');
    }

    restoreVolume();
    restoreSubtitleSize();
}

// ============================================================
// Server communication
// ============================================================

async function checkServerHealth() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(state.tunnelUrl + '/api/health', { signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
            state.serverOnline = true;
            updateStatus('online');
            return true;
        }
    } catch {
        state.serverOnline = false;
        updateStatus('offline', 'Server not responding. Is it running?');
        if (state.view === 'browse') renderOfflineState();
    }
    return false;
}

async function refreshVideoList() {
    if (!state.tunnelUrl) return;
    try {
        const response = await fetch(state.tunnelUrl + '/api/videos');
        const data = await response.json();
        state.videos = data.videos;
        state.folderTree = buildFolderTree(state.videos);

        if (state.view === 'browse') {
            renderBrowse();
        } else {
            renderDrill();
        }
    } catch (error) {
        console.error('Failed to refresh video list:', error);
        if (state.view === 'browse') renderOfflineState();
    }
}

function loadAllProgress() {
    // Read from localStorage — progress is per-browser so "Continue Watching"
    // is private to each device and not shared with other users on the same tunnel.
    state.watchProgress.clear();
    try {
        const raw = localStorage.getItem('lowkey_watch_progress');
        if (!raw) return;
        const data = JSON.parse(raw);
        for (const [path, entry] of Object.entries(data)) {
            state.watchProgress.set(path, entry);
        }
    } catch { /* non-critical */ }
}

function renderOfflineState(reason) {
    const url = state.tunnelUrl || '(not configured)';
    const msg = reason || 'Server not responding. Make sure it is running.';
    browseSectionsEl.innerHTML = `
        <div class="offline-state">
            <svg class="offline-icon" width="48" height="48" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <line x1="1" y1="1" x2="23" y2="23"/>
                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
                <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                <circle cx="12" cy="20" r="1" fill="currentColor"/>
            </svg>
            <h2 class="offline-title">Server Offline</h2>
            <p class="offline-msg">${escHtml(msg)}</p>
            <p class="offline-url">${escHtml(url)}</p>
            <button class="offline-retry-btn" onclick="init()">Retry</button>
        </div>`;
}

// ============================================================
// Folder tree helpers
// ============================================================

function buildFolderTree(videos) {
    const tree = { _files: [], _subfolders: {} };
    for (const v of videos) {
        const parts = v.path.split('/');
        let node = tree;
        for (let i = 0; i < parts.length - 1; i++) {
            const seg = parts[i];
            if (!node._subfolders[seg]) {
                node._subfolders[seg] = { _files: [], _subfolders: {} };
            }
            node = node._subfolders[seg];
        }
        node._files.push(v);
    }
    return tree;
}

function getNodeAtPath(path) {
    let node = state.folderTree;
    for (const seg of path) {
        node = node._subfolders[seg] || { _files: [], _subfolders: {} };
    }
    return node;
}

function countVideos(node) {
    let count = node._files.length;
    for (const sub of Object.values(node._subfolders)) count += countVideos(sub);
    return count;
}

function getAllFiles(node) {
    let files = [...node._files];
    for (const sub of Object.values(node._subfolders)) {
        files = files.concat(getAllFiles(sub));
    }
    return files;
}

function getFolderIcon(name) {
    const n = name.toLowerCase();
    let emoji = '📁';
    let label = 'folder';
    if (n.includes('film') || n.includes('movie'))    { emoji = '🎬'; label = 'movies'; }
    else if (n.includes('doc'))                        { emoji = '🎥'; label = 'documentaries'; }
    else if (/^s\d+$/i.test(n))                        { emoji = '🗂';  label = 'season'; }
    else if (n.includes('serial') || n.includes('series')) { emoji = '📺'; label = 'series'; }
    return `<span aria-hidden="true">${emoji}</span><span class="sr-only">${label}</span>`;
}

// ============================================================
// View management
// ============================================================

function showBrowseView() {
    state.view = 'browse';
    browseView.classList.remove('hidden');
    playerView.classList.add('hidden');
    if (state.videos.length) renderBrowse();
}

function showPlayerView() {
    state.view = 'player';
    browseView.classList.add('hidden');
    playerView.classList.remove('hidden');
}

// ============================================================
// Browse view — render
// ============================================================

function renderBrowse() {
    renderBrowseSections();
}

// Priority order: movies → series → documentaries → rest (alphabetical)
const SECTION_PRIORITY = [
    /film|movie/i,
    /serial|series|show/i,
    /doc/i,
];

function sectionPriority(name) {
    const idx = SECTION_PRIORITY.findIndex(re => re.test(name));
    return idx === -1 ? SECTION_PRIORITY.length : idx;
}

function sortSectionNames(names) {
    return [...names].sort((a, b) => {
        const diff = sectionPriority(a) - sectionPriority(b);
        return diff !== 0 ? diff : a.localeCompare(b);
    });
}

function renderBrowseSections() {
    state.browseSections = [];
    state.browseFolderCards = [];
    const root = state.folderTree;
    const fragments = [];

    // "Continue Watching" — videos with progress > 30s and < 95% complete
    if (state.watchProgress.size > 0) {
        const continueVideos = state.videos.filter(v => {
            const p = state.watchProgress.get(v.path);
            if (!p || p.completed) return false;
            const maxPos = v.duration_seconds ? v.duration_seconds * 0.95 : Infinity;
            return p.position > 30 && p.position < maxPos;
        }).sort((a, b) => {
            const pa = state.watchProgress.get(a.path)?.updated_at || '';
            const pb = state.watchProgress.get(b.path)?.updated_at || '';
            return pb.localeCompare(pa);
        });
        if (continueVideos.length > 0) {
            const idx = state.browseSections.length;
            state.browseSections.push({ title: 'Continue Watching', videos: continueVideos, drillPath: [] });
            fragments.push(buildFileSectionHtml('Continue Watching', continueVideos, idx));
        }
    }

    // Root-level files → "Library" (always shown as poster cards)
    if (root._files.length > 0) {
        const idx = state.browseSections.length;
        state.browseSections.push({ title: 'Library', videos: root._files, drillPath: [] });
        fragments.push(buildFileSectionHtml('Library', root._files, idx));
    }

    // Each top-level subfolder → sorted by category priority, then alphabetically
    const names = sortSectionNames(Object.keys(root._subfolders));
    for (const name of names) {
        const node = root._subfolders[name];
        const hasSubs = Object.keys(node._subfolders).length > 0;

        if (hasSubs) {
            // e.g. "Seriale" → each child is a series → show folder cards
            fragments.push(buildFolderSectionHtml(name, node, [name]));
        } else {
            // e.g. "Filme" → direct files → show poster cards
            const files = node._files;
            if (files.length === 0) continue;
            const idx = state.browseSections.length;
            state.browseSections.push({ title: name, videos: files, drillPath: [name] });
            fragments.push(buildFileSectionHtml(name, files, idx));
        }
    }

    if (fragments.length === 0) {
        browseSectionsEl.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.2" aria-hidden="true">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <p>No videos found</p>
            </div>`;
        return;
    }

    browseSectionsEl.innerHTML = fragments.join('');

    // Build O(1) card index maps after DOM is set
    cardIndex.clear();
    folderCardIndex.clear();
    for (const card of browseSectionsEl.querySelectorAll('.poster-card')) {
        if (card.dataset.path) {
            cardIndex.set(card.dataset.path, card);
        }
        if (card.dataset.folderIdx !== undefined) {
            const fc = state.browseFolderCards[Number(card.dataset.folderIdx)];
            if (fc) folderCardIndex.set(fc.firstFilePath, card);
        }
    }

    loadAllMeta();
}

// Section where each card = a file (movies, loose episodes)
function buildFileSectionHtml(title, videos, sectionIdx) {
    const cards = videos.map((v, i) => buildPosterCardHtml(v, sectionIdx, i)).join('');
    return `
        <div class="browse-section">
            <div class="browse-section-header">
                <span class="browse-section-title">${escHtml(title)}</span>
                <span class="browse-section-count">${videos.length}</span>
            </div>
            <div class="browse-cards">${cards}</div>
        </div>`;
}

// Section where each card = a subfolder (TV series, collections)
function buildFolderSectionHtml(title, node, sectionDrillPath) {
    const subNames = Object.keys(node._subfolders).sort();
    if (subNames.length === 0) return '';

    const cards = subNames.map(name => {
        const sub    = node._subfolders[name];
        const files  = getAllFiles(sub);
        if (files.length === 0) return '';

        const firstFile = files[0];
        const encodedPath = firstFile.path.split('/').map(encodeURIComponent).join('/');
        const thumbUrl    = `${state.tunnelUrl}/thumb/${encodedPath}`;
        const meta        = cacheGet(firstFile.path);
        const imgSrc      = meta?.poster_file
            ? `${state.tunnelUrl}/poster/${encodeURIComponent(meta.poster_file)}`
            : thumbUrl;

        const subCount    = Object.keys(sub._subfolders).length;
        const detailText  = subCount > 0
            ? `${subCount} sezon${subCount !== 1 ? 'e' : ''}`
            : `${files.length} episod${files.length !== 1 ? 'e' : ''}`;

        const drillPath   = [...sectionDrillPath, name];
        const fcIdx       = state.browseFolderCards.length;
        state.browseFolderCards.push({
            name,
            node: sub,
            drillPath,
            firstFilePath: firstFile.path,
        });

        return `
            <div class="poster-card loading" data-folder-idx="${fcIdx}"
                 data-action="select-folder"
                 tabindex="0"
                 role="button"
                 aria-label="${escAttr(name)}, ${escAttr(detailText)}">
                <div class="poster-card-media">
                    <img class="poster-card-img"
                         src="${imgSrc}"
                         loading="lazy"
                         onerror="this.onerror=null;this.closest('.poster-card').classList.add('no-thumb')"
                         alt="">
                </div>
                <div class="poster-card-play" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </div>
                <div class="poster-card-overlay">
                    <div class="poster-card-title">${escHtml(name)}</div>
                    <div class="poster-card-details"><span>${detailText}</span></div>
                </div>
            </div>`;
    }).join('');

    return `
        <div class="browse-section">
            <div class="browse-section-header">
                <span class="browse-section-title">${escHtml(title)}</span>
                <span class="browse-section-count">${subNames.length}</span>
            </div>
            <div class="browse-cards">${cards}</div>
        </div>`;
}

// Open player view with sidebar drilled into the selected folder
function selectFolderFromBrowse(fcIdx) {
    const folder = state.browseFolderCards[fcIdx];
    if (!folder) return;

    state.drillPath     = [...folder.drillPath];
    state.filteredVideos = getAllFiles(folder.node);

    showPlayerView();
    renderDrill();

    // Reveal the "select a video" overlay (no auto-play for folder cards)
    videoOverlay.classList.remove('hidden');
}

function buildPosterCardHtml(video, sectionIdx, vidIdx) {
    const encodedPath = video.path.split('/').map(encodeURIComponent).join('/');
    const thumbUrl = `${state.tunnelUrl}/thumb/${encodedPath}`;
    const meta = cacheGet(video.path);

    const imgSrc = meta?.poster_file
        ? `${state.tunnelUrl}/poster/${encodeURIComponent(meta.poster_file)}`
        : thumbUrl;

    const displayTitle = meta?.title || video.name;
    const rating   = meta?.rating   ? `<span class="card-rating">★ ${meta.rating.toFixed(1)}</span>` : '';
    const year     = meta?.year     ? `<span>${meta.year}</span>` : '';
    const duration = video.duration_seconds ? `<span>${formatDuration(video.duration_seconds)}</span>` : '';
    const dotted   = [rating, year, duration].filter(Boolean)
                        .join('<span class="card-detail-dot">·</span>');

    const progressEntry = state.watchProgress.get(video.path);
    const progressPct = (progressEntry && video.duration_seconds && !progressEntry.completed)
        ? Math.round((progressEntry.position / video.duration_seconds) * 100)
        : 0;
    const progressBar = progressPct > 1
        ? `<div class="poster-card-progress" style="width:${progressPct}%"></div>`
        : '';
    const watchedBadge = progressEntry?.completed
        ? `<div class="watched-badge" aria-label="Watched">
               <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                   <polyline points="20 6 9 17 4 12"/>
               </svg>
           </div>`
        : '';
    const qualityBadge = video.quality
        ? `<span class="quality-badge">${escHtml(video.quality)}</span>`
        : '';

    return `
        <div class="poster-card loading"
             data-path="${escAttr(video.path)}"
             data-action="select-video"
             data-section-idx="${sectionIdx}"
             data-vid-idx="${vidIdx}"
             tabindex="0"
             role="button"
             aria-label="${escAttr(displayTitle)}${meta?.year ? ', ' + meta.year : ''}">
            <div class="poster-card-media">
                <img class="poster-card-img"
                     src="${imgSrc}"
                     loading="lazy"
                     onerror="this.onerror=null;this.closest('.poster-card').classList.add('no-thumb')"
                     alt="">
                ${qualityBadge}
                ${watchedBadge}
            </div>
            <div class="poster-card-play" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
                    <polygon points="6 3 20 12 6 21 6 3"/>
                </svg>
            </div>
            <div class="poster-card-overlay">
                <div class="poster-card-title">${escHtml(displayTitle)}</div>
                ${dotted ? `<div class="poster-card-details">${dotted}</div>` : ''}
            </div>
            ${progressBar}
        </div>`;
}

// ── Select from browse ─────────────────────────────────────

async function selectFromBrowse(sectionIdx, vidIdx) {
    const section = state.browseSections[sectionIdx];
    if (!section) return;

    state.drillPath = [...(section.drillPath || [])];
    state.filteredVideos = section.videos;

    showPlayerView();
    await playVideo(vidIdx);
}

// ── Metadata lazy-loading ──────────────────────────────────

async function loadAllMeta() {
    const toLoad = state.videos.filter(v => !cacheHas(v.path));
    const BATCH = 8;
    for (let i = 0; i < toLoad.length; i += BATCH) {
        await Promise.all(toLoad.slice(i, i + BATCH).map(loadMeta));
    }
    // Mark any cards that got no metadata as loaded (remove shimmer)
    for (const card of browseSectionsEl.querySelectorAll('.poster-card.loading')) {
        card.classList.remove('loading');
        card.classList.add('loaded');
    }
}

async function loadMeta(video) {
    if (cacheHas(video.path)) return;
    cacheSet(video.path, null); // mark in-flight

    try {
        const encoded = video.path.split('/').map(encodeURIComponent).join('/');
        const resp = await fetch(`${state.tunnelUrl}/api/metadata/${encoded}`);
        const meta = await resp.json();
        if (meta?.title) {
            cacheSet(video.path, meta);
            updateCardWithMeta(video.path, meta);
        }
    } catch { /* no poster, stay as thumbnail */ }
}

function updateCardWithMeta(videoPath, meta) {
    // Poster card — O(1) lookup
    const card = cardIndex.get(videoPath);
    if (card) {
        if (meta.poster_file) {
            const img = card.querySelector('.poster-card-img');
            if (img) img.src = `${state.tunnelUrl}/poster/${encodeURIComponent(meta.poster_file)}`;
        }
        if (meta.title) {
            const t = card.querySelector('.poster-card-title');
            if (t) t.textContent = meta.title;
        }
        const overlay = card.querySelector('.poster-card-overlay');
        if (overlay && meta.poster_file) {
            const rating = meta.rating ? `<span class="card-rating">★ ${meta.rating.toFixed(1)}</span>` : '';
            const year   = meta.year   ? `<span>${meta.year}</span>` : '';
            const dotted = [rating, year].filter(Boolean).join('<span class="card-detail-dot">·</span>');
            if (dotted) {
                let det = overlay.querySelector('.poster-card-details');
                if (!det) { det = document.createElement('div'); det.className = 'poster-card-details'; overlay.appendChild(det); }
                det.innerHTML = dotted;
            }
        }
        card.classList.remove('loading');
        card.classList.add('loaded');
    }

    // Folder card whose representative thumbnail is this file — O(1) lookup
    const fcard = folderCardIndex.get(videoPath);
    if (fcard && meta.poster_file) {
        const img = fcard.querySelector('.poster-card-img');
        if (img) img.src = `${state.tunnelUrl}/poster/${encodeURIComponent(meta.poster_file)}`;
        fcard.classList.remove('loading');
        fcard.classList.add('loaded');
    }
}

// ============================================================
// Player sidebar — drill navigation
// ============================================================

function drillInto(name) {
    state.drillPath.push(name);
    renderDrill();
    videoItems.scrollTop = 0;
}

function drillBack() {
    state.drillPath.pop();
    renderDrill();
    videoItems.scrollTop = 0;
}

function renderDrill() {
    const query = searchInput.value.toLowerCase().trim();

    if (query) {
        const filtered = state.videos.filter(v =>
            v.name.toLowerCase().includes(query) ||
            v.path.toLowerCase().includes(query) ||
            v.filename.toLowerCase().includes(query)
        );
        state.filteredVideos = filtered;
        renderFlatList(filtered);
        videoCount.textContent = `${filtered.length} rezultat${filtered.length !== 1 ? 'e' : ''}`;
        return;
    }

    const node = getNodeAtPath(state.drillPath);
    const subfolderNames = Object.keys(node._subfolders).sort();
    const files = node._files;
    state.filteredVideos = files;

    if (state.drillPath.length === 0) {
        const total = countVideos(state.folderTree);
        videoCount.textContent = `${total} videoclip${total !== 1 ? 'uri' : ''}`;
    } else {
        videoCount.textContent = state.drillPath.join(' › ');
    }

    let html = '';

    if (state.drillPath.length > 0) {
        const backLabel = state.drillPath.length > 1
            ? state.drillPath[state.drillPath.length - 2]
            : 'Colecție';
        html += `
            <div class="drill-back-btn" data-action="drill-back">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                    <polyline points="15 18 9 12 15 6"/>
                </svg>
                ${escHtml(backLabel)}
            </div>
            <div class="drill-title">${escHtml(state.drillPath[state.drillPath.length - 1])}</div>`;
    }

    if (subfolderNames.length === 0 && files.length === 0) {
        html += `
            <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.25" aria-hidden="true">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <p>Folder gol</p>
            </div>`;
        videoItems.innerHTML = html;
        return;
    }

    subfolderNames.forEach(name => {
        const sub = node._subfolders[name];
        const total = countVideos(sub);
        const icon = getFolderIcon(name);
        html += `
            <div class="folder-item" data-action="drill-into" data-folder-name="${escAttr(name)}">
                <div class="folder-icon">${icon}</div>
                <div class="folder-info">
                    <div class="folder-name">${escHtml(name)}</div>
                    <div class="folder-meta">${total} videoclip${total !== 1 ? 'uri' : ''}</div>
                </div>
                <svg class="folder-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
            </div>`;
    });

    files.forEach((video, index) => {
        html += renderVideoItem(video, index);
    });

    videoItems.innerHTML = html;
}

function renderFlatList(videos) {
    const query = searchInput.value.trim();
    if (videos.length === 0) {
        videoItems.innerHTML = query
            ? `<div class="empty-search">Nothing found for "<em>${escHtml(query)}</em>"</div>`
            : `<div class="empty-state">
                   <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.25" aria-hidden="true">
                       <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                   </svg>
                   <p>No videos found</p>
               </div>`;
        return;
    }
    videoItems.innerHTML = videos.map((v, i) => renderVideoItem(v, i)).join('');
}

function renderVideoItem(video, index) {
    const isActive    = state.currentVideo && state.currentVideo.path === video.path;
    const playable    = video.playable ? '' : 'not-playable';
    const warnBadge   = video.playable ? '' : '<span class="badge-warning" title="May not play">!</span>';
    const extBadge    = video.extension.replace('.', '').toUpperCase();
    const subsBadge   = video.subtitles?.length
        ? `<span class="meta-subs" title="${video.subtitles.map(s => s.label).join(', ')}">CC${video.subtitles.length > 1 ? ' ' + video.subtitles.length : ''}</span>`
        : '';
    const durBadge    = video.duration_seconds
        ? `<span class="meta-duration">${formatDuration(video.duration_seconds)}</span>`
        : '';
    const encodedPath = video.path.split('/').map(encodeURIComponent).join('/');
    const thumbHtml   = `<img class="video-thumb" src="${state.tunnelUrl}/thumb/${encodedPath}" loading="lazy" onerror="this.onerror=null;this.closest('.video-item-icon').classList.add('no-thumb')" alt="">`;

    return `
        <div class="video-item ${isActive ? 'active' : ''} ${playable}"
             data-action="play-video" data-index="${index}">
            <div class="video-item-icon">
                ${thumbHtml}
                <svg class="video-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                ${warnBadge}
            </div>
            <div class="video-item-info">
                <div class="video-item-name" title="${escAttr(video.filename)}">${escHtml(video.name)}</div>
                <div class="video-item-meta">
                    <span class="meta-size">${video.size_display}</span>
                    <span class="meta-ext">${extBadge}</span>
                    ${durBadge}
                    ${subsBadge}
                </div>
            </div>
        </div>`;
}

// ============================================================
// Video playback
// ============================================================

async function playVideo(index) {
    const video = state.filteredVideos[index];
    if (!video) return;

    if (!video.playable) showFormatWarning(video.extension);
    else hideFormatWarning();

    clearInterval(state.progressInterval);
    state.progressInterval = null;
    hideResumeBanner();
    if (movieInfo) movieInfo.style.display = 'none';

    state.currentVideo = video;

    const encodedPath = video.path.split('/').map(encodeURIComponent).join('/');
    const videoUrl = `${state.tunnelUrl}/video/${encodedPath}`;

    if (audioTrackSelector) audioTrackSelector.style.display = 'none';
    const subtitleControls = document.getElementById('subtitleControls');
    if (subtitleControls) subtitleControls.style.display = 'none';
    videoPlayer.querySelectorAll('track').forEach(t => t.remove());
    videoPlayer.src = videoUrl;

    if (video.subtitles?.length) {
        if (subtitleControls) subtitleControls.style.display = 'flex';
        video.subtitles.forEach((sub, i) => {
            const track = document.createElement('track');
            track.kind    = 'subtitles';
            track.src     = `${state.tunnelUrl}/subs/${sub.path}`;
            track.srclang = sub.lang || 'en';
            track.label   = sub.label || sub.lang || 'Subtitles';
            if (i === 0) track.default = true;
            videoPlayer.appendChild(track);
        });
        videoPlayer.addEventListener('loadedmetadata', function applySubs() {
            const enabled = localStorage.getItem('lowkey_subtitle_enabled') === 'true';
            if (!enabled) {
                for (let i = 0; i < videoPlayer.textTracks.length; i++) {
                    videoPlayer.textTracks[i].mode = 'disabled';
                }
            }
            videoPlayer.removeEventListener('loadedmetadata', applySubs);
        });
    }

    videoPlayer.load();

    const savedPos  = await loadProgress(video.path);
    const duration  = video.duration_seconds;
    const maxFrac   = duration ? duration * 0.95 : Infinity;
    if (savedPos && savedPos > 30 && savedPos < maxFrac) {
        showResumeBanner(savedPos);
    } else {
        videoPlayer.play().catch(console.error);
    }

    // Guard against stale async resolution (user switched video during await)
    if (state.currentVideo?.path === video.path) {
        clearInterval(state.progressInterval);
        state.progressInterval = setInterval(() => saveProgress(video.path), 10000);
    }

    videoOverlay.classList.add('hidden');
    nowPlayingTitle.textContent = video.name;
    nowPlayingMeta.innerHTML = `
        <span class="meta-size">${video.size_display}</span>
        <span class="meta-ext">${video.extension.replace('.', '').toUpperCase()}</span>`;

    renderDrill();

    setTimeout(() => {
        document.querySelector('.video-item.active')
            ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);

    loadMovieMetadata(video);
}

function playNext() {
    if (!state.currentVideo) return;
    const i = state.filteredVideos.findIndex(v => v.path === state.currentVideo.path);
    if (i < state.filteredVideos.length - 1) playVideo(i + 1);
}

function playPrevious() {
    if (!state.currentVideo) return;
    const i = state.filteredVideos.findIndex(v => v.path === state.currentVideo.path);
    if (i > 0) playVideo(i - 1);
}

// ============================================================
// Progress
// ============================================================

async function saveProgress(videoPath) {
    if (!state.tunnelUrl || !videoPath) return;
    const position = videoPlayer.currentTime;
    if (position < 5) return;
    const delta = Math.abs(position - state.lastSavedPosition);
    if (delta < 8 && videoPlayer.paused) return;
    state.lastSavedPosition = position;
    const duration = videoPlayer.duration || 0;
    try {
        await fetch(`${state.tunnelUrl}/api/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: videoPath, position, duration }),
        });
        // Mirror to localStorage — this is the source of truth for "Continue Watching"
        const entry = {
            position,
            updated_at: new Date().toISOString(),
            completed: duration > 0 && (position / duration) > 0.95,
        };
        state.watchProgress.set(videoPath, entry);
        try {
            const raw = localStorage.getItem('lowkey_watch_progress');
            const stored = raw ? JSON.parse(raw) : {};
            stored[videoPath] = entry;
            localStorage.setItem('lowkey_watch_progress', JSON.stringify(stored));
        } catch { /* localStorage full or unavailable */ }
    } catch { /* ignore */ }
}

async function loadProgress(videoPath) {
    if (!state.tunnelUrl || !videoPath) return null;
    try {
        const resp = await fetch(`${state.tunnelUrl}/api/progress/${videoPath.split('/').map(encodeURIComponent).join('/')}`);
        const data = await resp.json();
        return data.position || null;
    } catch {
        return null;
    }
}

function showResumeBanner(position) {
    state.pendingSeek = position;
    resumeText.textContent = `Continuă din ${formatTime(position)}?`;
    resumeBanner.classList.add('visible');
    trapFocus(resumeBanner);
}

function hideResumeBanner() {
    resumeBanner.classList.remove('visible');
    state.pendingSeek = null;
    releaseFocus();
}

function resumePlayback() {
    const seek = state.pendingSeek;
    hideResumeBanner();
    if (seek !== null) videoPlayer.currentTime = seek;
    videoPlayer.play().catch(() => {});
}

function startFromBeginning() {
    hideResumeBanner();
    videoPlayer.currentTime = 0;
    videoPlayer.play().catch(() => {});
}

// ============================================================
// TMDB metadata (player section)
// ============================================================

async function loadMovieMetadata(video) {
    if (!movieInfo || !state.tunnelUrl) return;
    movieInfo.style.display = 'none';

    const cached = cacheGet(video.path);
    if (cached) { renderMovieInfo(cached); return; }

    try {
        const encoded = video.path.split('/').map(encodeURIComponent).join('/');
        const resp = await fetch(`${state.tunnelUrl}/api/metadata/${encoded}`);
        const meta = await resp.json();
        if (meta?.title) {
            cacheSet(video.path, meta);
            renderMovieInfo(meta);
        }
    } catch { /* no metadata */ }
}

function renderMovieInfo(meta) {
    const posterHtml = meta.poster_file
        ? `<img class="movie-poster" src="${state.tunnelUrl}/poster/${encodeURIComponent(meta.poster_file)}" alt="${escAttr(meta.title)}" onerror="this.style.display='none'">`
        : '';
    const ratingHtml = meta.rating ? `<span class="movie-rating">★ ${meta.rating.toFixed(1)}</span>` : '';
    const yearHtml   = meta.year   ? `<span class="movie-year">${meta.year}</span>` : '';
    const descHtml   = meta.description ? `<p class="movie-description">${escHtml(meta.description)}</p>` : '';

    movieInfo.innerHTML = `
        ${posterHtml}
        <div class="movie-details">
            <div class="movie-title-row">
                <span class="movie-title">${escHtml(meta.title)}</span>
                ${ratingHtml}
            </div>
            <div class="movie-meta-row">${yearHtml}</div>
            ${descHtml}
        </div>`;
    movieInfo.style.display = 'flex';
}

// ============================================================
// Audio track selector
// ============================================================

function renderAudioTrackSelector() {
    if (!audioTrackSelector) return;
    const tracks = videoPlayer.audioTracks;
    if (!tracks || tracks.length <= 1) {
        audioTrackSelector.style.display = 'none';
        return;
    }
    audioTrackSelector.style.display = 'flex';
    audioTrackSelector.innerHTML = '';
    for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        const langCode = track.language || '';
        const label = LANG_NAMES[langCode] || track.label || langCode.toUpperCase() || `Track ${i + 1}`;
        const btn = document.createElement('button');
        btn.className = 'audio-btn' + (track.enabled ? ' active' : '');
        btn.textContent = label;
        btn.title = `Audio: ${label}`;
        btn.dataset.index = i;
        btn.addEventListener('click', () => switchAudioTrack(i));
        audioTrackSelector.appendChild(btn);
    }
}

function switchAudioTrack(selectedIndex) {
    const tracks = videoPlayer.audioTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) tracks[i].enabled = (i === selectedIndex);
    audioTrackSelector.querySelectorAll('.audio-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === selectedIndex);
    });
}

// ============================================================
// Format warning
// ============================================================

function showFormatWarning(extension) {
    formatWarningText.textContent = `${extension.toUpperCase()} format may not play in your browser.`;
    formatWarning.classList.add('visible');
}

function hideFormatWarning() {
    formatWarning.classList.remove('visible');
}

// ============================================================
// Volume control
// ============================================================

function restoreVolume() {
    const saved = parseFloat(localStorage.getItem('lowkey_volume'));
    if (!isNaN(saved)) {
        videoPlayer.volume = saved;
        if (volumeSlider) volumeSlider.value = saved;
    }
    syncVolumeUI();
}

function syncVolumeUI() {
    if (!volumeSlider || !volumeDisplay || !muteBtn) return;
    const vol = videoPlayer.muted ? 0 : videoPlayer.volume;
    volumeSlider.value = videoPlayer.muted ? 0 : videoPlayer.volume;
    volumeDisplay.textContent = `${Math.round(vol * 100)}%`;
    muteBtn.classList.toggle('muted', videoPlayer.muted || videoPlayer.volume === 0);
}

if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
        videoPlayer.volume = parseFloat(volumeSlider.value);
        videoPlayer.muted = false;
        localStorage.setItem('lowkey_volume', volumeSlider.value);
        syncVolumeUI();
    });
}

if (muteBtn) {
    muteBtn.addEventListener('click', () => {
        videoPlayer.muted = !videoPlayer.muted;
        syncVolumeUI();
    });
}

videoPlayer.addEventListener('volumechange', syncVolumeUI);

// ============================================================
// Subtitle size control
// ============================================================

function _applySubtitleSize(px) {
    let tag = document.getElementById('sub-size-style');
    if (!tag) {
        tag = document.createElement('style');
        tag.id = 'sub-size-style';
        document.head.appendChild(tag);
    }
    tag.textContent = `::cue { font-size: ${px}px !important; }`;
}

function restoreSubtitleSize() {
    const saved = parseInt(localStorage.getItem('lowkey_sub_px') || '0', 10);
    if (saved > 0) _applySubtitleSize(saved);
}

function setSubtitleSize(delta) {
    const tag = document.getElementById('sub-size-style');
    const current = tag
        ? parseInt(tag.textContent.match(/(\d+)px/)?.[1] || '16', 10)
        : 16;
    const next = Math.min(40, Math.max(10, current + delta));
    _applySubtitleSize(next);
    localStorage.setItem('lowkey_sub_px', String(next));
    // Update button title to show current size
    const label = document.querySelector('.subtitle-controls-label');
    if (label) label.textContent = `Subs ${next}px`;
}

// ============================================================
// Keyboard shortcuts modal
// ============================================================

const SHORTCUTS_LIST = [
    ['Space',        'Play / Pause'],
    ['F',            'Toggle fullscreen'],
    ['M',            'Toggle mute'],
    ['↑ / ↓',        'Volume +/− 10%'],
    ['→ / ←',        'Seek +/− 10 seconds'],
    ['Shift + →',    'Next video'],
    ['Shift + ←',    'Previous video'],
    ['Esc',          'Back to browse'],
    ['H / ?',        'Toggle this help'],
];

function toggleShortcutsModal() {
    if (!shortcutsModal) return;
    const visible = shortcutsModal.classList.toggle('visible');
    if (visible) {
        const rows = SHORTCUTS_LIST.map(([key, desc]) =>
            `<tr><td class="shortcut-key">${escHtml(key)}</td><td class="shortcut-desc">${escHtml(desc)}</td></tr>`
        ).join('');
        shortcutsModal.querySelector('.shortcuts-table-body').innerHTML = rows;
        shortcutsModal.querySelector('.shortcuts-close')?.focus();
    }
}

// ============================================================
// Global browse search
// ============================================================

function renderBrowseSearchResults(query) {
    const q = query.trim().toLowerCase();
    if (!q) { renderBrowse(); return; }

    const results = state.videos.filter(v => {
        const meta = cacheGet(v.path);
        const title = (meta?.title || '').toLowerCase();
        return v.name.toLowerCase().includes(q) || title.includes(q) || v.path.toLowerCase().includes(q);
    });

    if (results.length === 0) {
        browseSectionsEl.innerHTML = `
            <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="1" opacity="0.2" aria-hidden="true">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <p>No results for "${escHtml(query)}"</p>
            </div>`;
        return;
    }

    const idx = 0;
    state.browseSections = [{ title: 'Search Results', videos: results, drillPath: [] }];
    state.browseFolderCards = [];
    const cards = results.map((v, i) => buildPosterCardHtml(v, idx, i)).join('');
    browseSectionsEl.innerHTML = `
        <div class="browse-section">
            <div class="browse-section-header">
                <span class="browse-section-title">Results for "${escHtml(query)}"</span>
                <span class="browse-section-count">${results.length}</span>
            </div>
            <div class="browse-cards browse-search-grid">${cards}</div>
        </div>`;

    cardIndex.clear();
    folderCardIndex.clear();
    for (const card of browseSectionsEl.querySelectorAll('.poster-card[data-path]')) {
        cardIndex.set(card.dataset.path, card);
    }
}

// ============================================================
// Status
// ============================================================

function updateStatus(status, message) {
    statusDot.className = 'status-dot ' + status;
    if (status === 'online') {
        statusText.textContent = 'Connected';
    } else if (status === 'connecting') {
        statusText.textContent = 'Connecting...';
    } else {
        statusText.textContent = message || 'Server offline';
    }
}

// ============================================================
// Keyboard shortcuts
// ============================================================

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;

    // Shortcuts modal toggle — works in both views
    if (e.code === 'KeyH' || (e.code === 'Slash' && e.shiftKey)) {
        e.preventDefault();
        toggleShortcutsModal();
        return;
    }

    if (state.view === 'browse') return;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            videoPlayer.paused ? videoPlayer.play() : videoPlayer.pause();
            break;
        case 'KeyF':
            e.preventDefault();
            document.fullscreenElement
                ? document.exitFullscreen()
                : videoContainer.requestFullscreen();
            break;
        case 'ArrowRight':
            e.shiftKey ? playNext() : (videoPlayer.currentTime += 10);
            break;
        case 'ArrowLeft':
            e.shiftKey ? playPrevious() : (videoPlayer.currentTime -= 10);
            break;
        case 'ArrowUp':
            e.preventDefault();
            videoPlayer.volume = Math.min(1, videoPlayer.volume + 0.1);
            syncVolumeUI();
            break;
        case 'ArrowDown':
            e.preventDefault();
            videoPlayer.volume = Math.max(0, videoPlayer.volume - 0.1);
            syncVolumeUI();
            break;
        case 'KeyM':
            videoPlayer.muted = !videoPlayer.muted;
            break;
        case 'Escape':
            if (shortcutsModal?.classList.contains('visible')) {
                toggleShortcutsModal();
            } else {
                showBrowseView();
            }
            break;
    }
});

// ============================================================
// Video events
// ============================================================

videoPlayer.addEventListener('ended', () => {
    clearInterval(state.progressInterval);
    state.progressInterval = null;
    playNext();
});

videoPlayer.addEventListener('pause', () => {
    if (state.currentVideo) saveProgress(state.currentVideo.path);
});

videoPlayer.addEventListener('error', () => {
    if (videoPlayer.error) {
        console.error('Video error:', videoPlayer.error.message);
        if (state.currentVideo && !state.currentVideo.playable) {
            showFormatWarning(state.currentVideo.extension);
        }
    }
});

videoOverlay.addEventListener('click', () => {
    if (state.filteredVideos.length > 0) playVideo(0);
});

// Save subtitle preference whenever the user toggles a subtitle track
videoPlayer.textTracks.addEventListener('change', () => {
    const anyEnabled = Array.from(videoPlayer.textTracks).some(t => t.mode === 'showing');
    localStorage.setItem('lowkey_subtitle_enabled', String(anyEnabled));
});

// ============================================================
// Delegated event listeners (replaces inline onclick attributes)
// ============================================================

// Browse sections → poster cards and folder cards (click + keyboard)
function handleBrowseAction(target) {
    if (!target) return;
    switch (target.dataset.action) {
        case 'select-folder': selectFolderFromBrowse(Number(target.dataset.folderIdx)); break;
        case 'select-video':  selectFromBrowse(Number(target.dataset.sectionIdx), Number(target.dataset.vidIdx)); break;
    }
}

browseSectionsEl.addEventListener('click', e => {
    handleBrowseAction(e.target.closest('[data-action]'));
});

browseSectionsEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
        const target = e.target.closest('[data-action]');
        if (target) { e.preventDefault(); handleBrowseAction(target); }
    }
});

// Video items sidebar → video playback and folder drill
videoItems.addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    switch (target.dataset.action) {
        case 'play-video':  playVideo(Number(target.dataset.index)); break;
        case 'drill-back':  drillBack(); break;
        case 'drill-into':  drillInto(target.dataset.folderName); break;
    }
});

// ============================================================
// Persistent event listeners
// ============================================================

searchInput.addEventListener('input', debounce(() => renderDrill(), 200));

if (browseSearchInput) {
    browseSearchInput.addEventListener('input', debounce(() => {
        renderBrowseSearchResults(browseSearchInput.value);
    }, 200));
}

// Periodic health check + refresh (every 2 minutes)
setInterval(async () => {
    if (!state.tunnelUrl) return;
    const online = await checkServerHealth();
    if (online) await refreshVideoList();
}, 120000);

// ── Start ──────────────────────────────────────────────────
init();
