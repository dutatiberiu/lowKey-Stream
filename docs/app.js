// ============================================================
// lowKey-Stream - Frontend Application
// ============================================================

const state = {
    tunnelUrl: null,
    videos: [],
    filteredVideos: [],
    folderTree: { _files: [], _subfolders: {} },
    drillPath: [],
    currentVideo: null,
    serverOnline: false
};

// DOM Elements
const videoPlayer = document.getElementById('videoPlayer');
const videoContainer = document.getElementById('videoContainer');
const videoOverlay = document.getElementById('videoOverlay');
const videoItems = document.getElementById('videoItems');
const searchInput = document.getElementById('searchInput');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const videoCount = document.getElementById('videoCount');
const nowPlayingTitle = document.getElementById('nowPlayingTitle');
const nowPlayingMeta = document.getElementById('nowPlayingMeta');
const formatWarning = document.getElementById('formatWarning');
const formatWarningText = document.getElementById('formatWarningText');
const audioTrackSelector = document.getElementById('audioTrackSelector');

// ISO 639 language code -> display name
const LANG_NAMES = {
    eng: 'English', rum: 'Romanian', ron: 'Romanian',
    spa: 'Spanish', fre: 'French',  fra: 'French',
    ger: 'German',  deu: 'German',  ita: 'Italian',
    por: 'Portuguese', dut: 'Dutch', nld: 'Dutch',
    pol: 'Polish',  hun: 'Hungarian', jpn: 'Japanese',
    kor: 'Korean',  chi: 'Chinese', zho: 'Chinese',
    rus: 'Russian', ara: 'Arabic',  tur: 'Turkish',
    swe: 'Swedish', dan: 'Danish',  nor: 'Norwegian',
    fin: 'Finnish', cze: 'Czech',   ces: 'Czech',
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
// Server Communication
// ============================================================

async function checkServerHealth() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(state.tunnelUrl + '/api/health', {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
            state.serverOnline = true;
            updateStatus('online');
            return true;
        }
    } catch (error) {
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
        renderDrill();
    } catch (error) {
        console.error('Failed to refresh video list:', error);
    }
}

// ============================================================
// Folder Tree
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
    for (const sub of Object.values(node._subfolders)) {
        count += countVideos(sub);
    }
    return count;
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
// Drill Navigation
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

// ============================================================
// Render — Folder Drill
// ============================================================

function renderDrill() {
    const query = searchInput.value.toLowerCase().trim();

    // Search mode: show flat filtered results
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

    // filteredVideos = files at current node (for playNext/playPrevious)
    state.filteredVideos = files;

    // Update count/breadcrumb
    if (state.drillPath.length === 0) {
        const total = countVideos(state.folderTree);
        videoCount.textContent = `${total} videoclip${total !== 1 ? 'uri' : ''}`;
    } else {
        videoCount.textContent = state.drillPath.join(' › ');
    }

    let html = '';

    // Back button
    if (state.drillPath.length > 0) {
        const backLabel = state.drillPath.length > 1
            ? state.drillPath[state.drillPath.length - 2]
            : 'Colecție';
        html += `
            <div class="drill-back-btn" onclick="drillBack()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                ${backLabel}
            </div>
            <div class="drill-title">${state.drillPath[state.drillPath.length - 1]}</div>`;
    }

    // Empty state
    if (subfolderNames.length === 0 && files.length === 0) {
        html += `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <p>Folder gol</p>
            </div>`;
        videoItems.innerHTML = html;
        return;
    }

    // Subfolders
    subfolderNames.forEach(name => {
        const sub = node._subfolders[name];
        const total = countVideos(sub);
        const icon = getFolderIcon(name);
        const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        html += `
            <div class="folder-item" onclick="drillInto('${safeName}')">
                <div class="folder-icon">${icon}</div>
                <div class="folder-info">
                    <div class="folder-name">${name}</div>
                    <div class="folder-meta">${total} videoclip${total !== 1 ? 'uri' : ''}</div>
                </div>
                <svg class="folder-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </div>`;
    });

    // Files
    files.forEach((video, index) => {
        html += renderVideoItem(video, index);
    });

    videoItems.innerHTML = html;
}

function renderFlatList(videos) {
    if (videos.length === 0) {
        videoItems.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
                    <circle cx="11" cy="11" r="8"/>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <p>No videos found</p>
            </div>`;
        return;
    }

    videoItems.innerHTML = videos.map((video, index) => renderVideoItem(video, index)).join('');
}

function renderVideoItem(video, index) {
    const isActive = state.currentVideo && state.currentVideo.path === video.path;
    const playableClass = video.playable ? '' : 'not-playable';
    const warningBadge = video.playable ? '' : '<span class="badge-warning" title="May not play in browser">!</span>';
    const extBadge = video.extension.replace('.', '').toUpperCase();
    const subsBadge = video.subtitles && video.subtitles.length > 0
        ? `<span class="meta-subs" title="${video.subtitles.map(s => s.label).join(', ')}">CC ${video.subtitles.length > 1 ? video.subtitles.length : ''}</span>`
        : '';

    return `
        <div class="video-item ${isActive ? 'active' : ''} ${playableClass}"
             onclick="playVideo(${index})" data-index="${index}">
            <div class="video-item-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                ${warningBadge}
            </div>
            <div class="video-item-info">
                <div class="video-item-name" title="${video.filename}">${video.name}</div>
                <div class="video-item-meta">
                    <span class="meta-size">${video.size_display}</span>
                    <span class="meta-ext">${extBadge}</span>
                    ${subsBadge}
                </div>
            </div>
        </div>`;
}

// ============================================================
// Video Playback
// ============================================================

function playVideo(index) {
    const video = state.filteredVideos[index];
    if (!video) return;

    if (!video.playable) {
        showFormatWarning(video.extension);
    } else {
        hideFormatWarning();
    }

    state.currentVideo = video;

    const encodedPath = video.path.split('/').map(encodeURIComponent).join('/');
    const videoUrl = `${state.tunnelUrl}/video/${encodedPath}`;

    // Audio selector hidden on new video
    if (audioTrackSelector) audioTrackSelector.style.display = 'none';

    // Remove existing subtitle tracks
    videoPlayer.querySelectorAll('track').forEach(t => t.remove());

    videoPlayer.src = videoUrl;

    // Add subtitle tracks (must be added BEFORE load)
    if (video.subtitles && video.subtitles.length > 0) {
        video.subtitles.forEach((sub, i) => {
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.src = `${state.tunnelUrl}/subs/${sub.path}`;
            track.srclang = sub.lang || 'en';
            track.label = sub.label || sub.lang || 'Subtitles';
            if (i === 0) track.default = true;
            videoPlayer.appendChild(track);
        });

        // All subtitle tracks start disabled (user chooses via CC button)
        videoPlayer.addEventListener('loadedmetadata', function disableSubs() {
            for (let i = 0; i < videoPlayer.textTracks.length; i++) {
                videoPlayer.textTracks[i].mode = 'disabled';
            }
            videoPlayer.removeEventListener('loadedmetadata', disableSubs);
        });
    }

    videoPlayer.load();
    videoPlayer.play().catch(err => {
        console.error('Playback error:', err);
    });

    videoOverlay.classList.add('hidden');
    nowPlayingTitle.textContent = video.name;
    nowPlayingMeta.innerHTML = `
        <span class="meta-size">${video.size_display}</span>
        <span class="meta-ext">${video.extension.replace('.', '').toUpperCase()}</span>`;

    // Re-render to highlight active item
    renderDrill();

    // Scroll active item into view
    setTimeout(() => {
        const activeItem = document.querySelector('.video-item.active');
        if (activeItem) {
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, 100);
}

function playNext() {
    if (!state.currentVideo) return;
    const currentIndex = state.filteredVideos.findIndex(v => v.path === state.currentVideo.path);
    if (currentIndex < state.filteredVideos.length - 1) {
        playVideo(currentIndex + 1);
    }
}

function playPrevious() {
    if (!state.currentVideo) return;
    const currentIndex = state.filteredVideos.findIndex(v => v.path === state.currentVideo.path);
    if (currentIndex > 0) {
        playVideo(currentIndex - 1);
    }
}

// ============================================================
// Audio Track Selector
// ============================================================

function renderAudioTrackSelector() {
    if (!audioTrackSelector) return;
    audioTrackSelector.innerHTML = '';

    const tracks = videoPlayer.audioTracks;
    if (!tracks || tracks.length <= 1) {
        audioTrackSelector.style.display = 'none';
        return;
    }

    audioTrackSelector.style.display = 'flex';

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
    for (let i = 0; i < tracks.length; i++) {
        tracks[i].enabled = (i === selectedIndex);
    }
    audioTrackSelector.querySelectorAll('.audio-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === selectedIndex);
    });
}

// ============================================================
// Format Warning
// ============================================================

function showFormatWarning(extension) {
    formatWarningText.textContent = `${extension.toUpperCase()} format may not play in your browser. Convert with: ffmpeg -i input${extension} -codec copy output.mp4`;
    formatWarning.classList.add('visible');
}

function hideFormatWarning() {
    formatWarning.classList.remove('visible');
}

// ============================================================
// Status Indicator
// ============================================================

function updateStatus(status, message) {
    statusDot.className = 'status-dot ' + status;
    if (status === 'online') {
        statusText.textContent = 'Connected';
    } else {
        statusText.textContent = message || 'Server offline';
    }
}

// ============================================================
// Keyboard Shortcuts
// ============================================================

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            if (videoPlayer.paused) videoPlayer.play();
            else videoPlayer.pause();
            break;
        case 'KeyF':
            e.preventDefault();
            if (!document.fullscreenElement) {
                videoContainer.requestFullscreen();
            } else {
                document.exitFullscreen();
            }
            break;
        case 'ArrowRight':
            if (e.shiftKey) {
                playNext();
            } else {
                videoPlayer.currentTime += 10;
            }
            break;
        case 'ArrowLeft':
            if (e.shiftKey) {
                playPrevious();
            } else {
                videoPlayer.currentTime -= 10;
            }
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
    }
});

// ============================================================
// Video Events
// ============================================================

videoPlayer.addEventListener('ended', () => {
    playNext();
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
    if (state.filteredVideos.length > 0) {
        playVideo(0);
    }
});

// ============================================================
// Event Listeners & Start
// ============================================================

searchInput.addEventListener('input', () => renderDrill());

// Periodic health check + video list refresh (every 2 minutes)
setInterval(async () => {
    if (state.tunnelUrl) {
        const online = await checkServerHealth();
        if (online) {
            await refreshVideoList();
        }
    }
}, 120000);

// Start
init();
