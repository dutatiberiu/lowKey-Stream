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
    metaCache: {},          // path → metadata object (null = requested, no result)
    browseSections: [],     // [{ title, videos, drillPath }]  — for file cards
    browseFolderCards: [],  // [{ name, node, drillPath, firstFilePath }] — for folder cards
};

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
// Initialization
// ============================================================

async function init() {
    try {
        const response = await fetch('config.json');
        const config = await response.json();
        state.tunnelUrl = config.tunnel_url;

        if (!state.tunnelUrl) {
            updateStatus('offline', 'Tunnel URL not configured in config.json.');
            return;
        }

        const online = await checkServerHealth();
        if (online) {
            await refreshVideoList();
        }
    } catch (error) {
        console.error('Failed to load config:', error);
        updateStatus('offline', 'Could not load config. Is the site deployed?');
    }
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
    }
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
    if (n.includes('film') || n.includes('movie')) return '🎬';
    if (n.includes('doc')) return '🎥';
    if (/^s\d+$/i.test(n)) return '🗂';
    if (n.includes('serial') || n.includes('series')) return '📺';
    return '📁';
}

// ============================================================
// View management
// ============================================================

function showBrowseView() {
    state.view = 'browse';
    browseView.classList.remove('hidden');
    playerView.classList.add('hidden');
    // Refresh browse in case new videos arrived
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
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <p>No videos found</p>
            </div>`;
        return;
    }

    browseSectionsEl.innerHTML = fragments.join('');
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
        const meta        = state.metaCache[firstFile.path];
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
            <div class="poster-card" data-folder-idx="${fcIdx}"
                 onclick="selectFolderFromBrowse(${fcIdx})">
                <div class="poster-card-media">
                    <img class="poster-card-img"
                         src="${imgSrc}"
                         loading="lazy"
                         onerror="this.src='${thumbUrl}'; this.onerror=null"
                         alt="">
                </div>
                <div class="poster-card-play">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2.5">
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

function renderBrowseSearch(query) {
    const filtered = state.videos.filter(v =>
        v.name.toLowerCase().includes(query) ||
        v.filename.toLowerCase().includes(query)
    );

    state.browseSections = [{ title: 'Results', videos: filtered, drillPath: [] }];

    if (filtered.length === 0) {
        browseSectionsEl.innerHTML = `
            <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.2">
                    <circle cx="11" cy="11" r="8"/>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <p>No results for "${escHtml(query)}"</p>
            </div>`;
        return;
    }

    const cards = filtered.map((v, i) => buildPosterCardHtml(v, 0, i)).join('');
    browseSectionsEl.innerHTML = `
        <div class="browse-section">
            <div class="browse-section-header">
                <span class="browse-section-title">Results</span>
                <span class="browse-section-count">${filtered.length}</span>
            </div>
            <div class="browse-search-results">${cards}</div>
        </div>`;
    loadAllMeta();
}

function buildPosterCardHtml(video, sectionIdx, vidIdx) {
    const encodedPath = video.path.split('/').map(encodeURIComponent).join('/');
    const thumbUrl = `${state.tunnelUrl}/thumb/${encodedPath}`;
    const meta = state.metaCache[video.path];

    const imgSrc = meta?.poster_file
        ? `${state.tunnelUrl}/poster/${encodeURIComponent(meta.poster_file)}`
        : thumbUrl;

    const displayTitle = meta?.title || video.name;
    const rating   = meta?.rating   ? `<span class="card-rating">★ ${meta.rating.toFixed(1)}</span>` : '';
    const year     = meta?.year     ? `<span>${meta.year}</span>` : '';
    const duration = video.duration_seconds ? `<span>${formatDuration(video.duration_seconds)}</span>` : '';
    const dotted   = [rating, year, duration].filter(Boolean)
                        .join('<span class="card-detail-dot">·</span>');

    return `
        <div class="poster-card"
             data-path="${escAttr(video.path)}"
             onclick="selectFromBrowse(${sectionIdx}, ${vidIdx})">
            <div class="poster-card-media">
                <img class="poster-card-img"
                     src="${imgSrc}"
                     loading="lazy"
                     onerror="this.src='${thumbUrl}'; this.onerror=null"
                     alt="">
            </div>
            <div class="poster-card-play">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <polygon points="6 3 20 12 6 21 6 3"/>
                </svg>
            </div>
            <div class="poster-card-overlay">
                <div class="poster-card-title">${escHtml(displayTitle)}</div>
                ${dotted ? `<div class="poster-card-details">${dotted}</div>` : ''}
            </div>
        </div>`;
}

// ── Select from browse ─────────────────────────────────────

async function selectFromBrowse(sectionIdx, vidIdx) {
    const section = state.browseSections[sectionIdx];
    if (!section) return;

    // Set drill path so the player sidebar navigates to the right folder
    state.drillPath = [...(section.drillPath || [])];

    // filteredVideos = section's flat list (enables prev/next across the row)
    state.filteredVideos = section.videos;

    showPlayerView();
    await playVideo(vidIdx);
}

// ── Metadata lazy-loading ──────────────────────────────────

async function loadAllMeta() {
    const toLoad = state.videos.filter(v => state.metaCache[v.path] === undefined);
    const BATCH = 8;
    for (let i = 0; i < toLoad.length; i += BATCH) {
        await Promise.all(toLoad.slice(i, i + BATCH).map(loadMeta));
    }
}

async function loadMeta(video) {
    if (state.metaCache[video.path] !== undefined) return;
    state.metaCache[video.path] = null; // mark in-flight

    try {
        const encoded = video.path.split('/').map(encodeURIComponent).join('/');
        const resp = await fetch(`${state.tunnelUrl}/api/metadata/${encoded}`);
        const meta = await resp.json();
        if (meta?.title) {
            state.metaCache[video.path] = meta;
            updateCardWithMeta(video.path, meta);
        }
    } catch { /* no poster, stay as thumbnail */ }
}

function updateCardWithMeta(videoPath, meta) {
    for (const card of document.querySelectorAll('.poster-card')) {

        // ── Poster card (data-path matches) ───────────────────
        if (card.dataset.path === videoPath) {
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
            // don't break — same file may also be a folder card's first file
        }

        // ── Folder card whose representative thumbnail is this file ──
        if (card.dataset.folderIdx !== undefined && meta.poster_file) {
            const fc = state.browseFolderCards[Number(card.dataset.folderIdx)];
            if (fc && fc.firstFilePath === videoPath) {
                const img = card.querySelector('.poster-card-img');
                if (img) img.src = `${state.tunnelUrl}/poster/${encodeURIComponent(meta.poster_file)}`;
            }
        }
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
            <div class="drill-back-btn" onclick="drillBack()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="15 18 9 12 15 6"/>
                </svg>
                ${escHtml(backLabel)}
            </div>
            <div class="drill-title">${escHtml(state.drillPath[state.drillPath.length - 1])}</div>`;
    }

    if (subfolderNames.length === 0 && files.length === 0) {
        html += `
            <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.25">
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
        const safe = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        html += `
            <div class="folder-item" onclick="drillInto('${safe}')">
                <div class="folder-icon">${icon}</div>
                <div class="folder-info">
                    <div class="folder-name">${escHtml(name)}</div>
                    <div class="folder-meta">${total} videoclip${total !== 1 ? 'uri' : ''}</div>
                </div>
                <svg class="folder-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
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
    if (videos.length === 0) {
        videoItems.innerHTML = `
            <div class="empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.25">
                    <circle cx="11" cy="11" r="8"/>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
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
    const thumbHtml   = `<img class="video-thumb" src="${state.tunnelUrl}/thumb/${encodedPath}" loading="lazy" onerror="this.style.display='none'" alt="">`;

    return `
        <div class="video-item ${isActive ? 'active' : ''} ${playable}"
             onclick="playVideo(${index})" data-index="${index}">
            <div class="video-item-icon">
                ${thumbHtml}
                <svg class="video-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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

    if (state.progressInterval) {
        clearInterval(state.progressInterval);
        state.progressInterval = null;
    }
    hideResumeBanner();
    if (movieInfo) movieInfo.style.display = 'none';

    state.currentVideo = video;

    const encodedPath = video.path.split('/').map(encodeURIComponent).join('/');
    const videoUrl = `${state.tunnelUrl}/video/${encodedPath}`;

    if (audioTrackSelector) audioTrackSelector.style.display = 'none';
    videoPlayer.querySelectorAll('track').forEach(t => t.remove());
    videoPlayer.src = videoUrl;

    if (video.subtitles?.length) {
        video.subtitles.forEach((sub, i) => {
            const track = document.createElement('track');
            track.kind    = 'subtitles';
            track.src     = `${state.tunnelUrl}/subs/${sub.path}`;
            track.srclang = sub.lang || 'en';
            track.label   = sub.label || sub.lang || 'Subtitles';
            if (i === 0) track.default = true;
            videoPlayer.appendChild(track);
        });
        videoPlayer.addEventListener('loadedmetadata', function disableSubs() {
            for (let i = 0; i < videoPlayer.textTracks.length; i++) {
                videoPlayer.textTracks[i].mode = 'disabled';
            }
            videoPlayer.removeEventListener('loadedmetadata', disableSubs);
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

    state.progressInterval = setInterval(() => saveProgress(video.path), 10000);

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
    try {
        await fetch(`${state.tunnelUrl}/api/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: videoPath, position }),
        });
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
}

function hideResumeBanner() {
    resumeBanner.classList.remove('visible');
    state.pendingSeek = null;
}

function resumePlayback() {
    hideResumeBanner();
    if (state.pendingSeek !== null) {
        videoPlayer.currentTime = state.pendingSeek;
        state.pendingSeek = null;
    }
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

    // Use cache if already loaded
    const cached = state.metaCache[video.path];
    if (cached) { renderMovieInfo(cached); return; }

    try {
        const encoded = video.path.split('/').map(encodeURIComponent).join('/');
        const resp = await fetch(`${state.tunnelUrl}/api/metadata/${encoded}`);
        const meta = await resp.json();
        if (meta?.title) {
            state.metaCache[video.path] = meta;
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
// Status
// ============================================================

function updateStatus(status, message) {
    statusDot.className = 'status-dot ' + status;
    statusText.textContent = status === 'online' ? 'Connected' : (message || 'Server offline');
}

// ============================================================
// Utility
// ============================================================

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

// ============================================================
// Keyboard shortcuts
// ============================================================

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
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
            break;
        case 'ArrowDown':
            e.preventDefault();
            videoPlayer.volume = Math.max(0, videoPlayer.volume - 0.1);
            break;
        case 'KeyM':
            videoPlayer.muted = !videoPlayer.muted;
            break;
        case 'Escape':
            showBrowseView();
            break;
    }
});

// ============================================================
// Video events
// ============================================================

videoPlayer.addEventListener('ended', () => {
    if (state.progressInterval) { clearInterval(state.progressInterval); state.progressInterval = null; }
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

// ============================================================
// Event listeners
// ============================================================

searchInput.addEventListener('input', () => renderDrill());

// Periodic health check + refresh (every 2 minutes)
setInterval(async () => {
    if (!state.tunnelUrl) return;
    const online = await checkServerHealth();
    if (online) await refreshVideoList();
}, 120000);

// ── Start ──────────────────────────────────────────────────
init();
