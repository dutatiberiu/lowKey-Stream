// ============================================================
// lowKey-Stream - Frontend Application
// ============================================================

const state = {
    tunnelUrl: null,
    videos: [],
    filteredVideos: [],
    folders: [],
    currentFolder: 'all',
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
const folderTabs = document.getElementById('folderTabs');
const videoCount = document.getElementById('videoCount');
const nowPlayingTitle = document.getElementById('nowPlayingTitle');
const nowPlayingMeta = document.getElementById('nowPlayingMeta');
const formatWarning = document.getElementById('formatWarning');
const formatWarningText = document.getElementById('formatWarningText');

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

        // Check if server is online, then fetch video list from server
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
        state.filteredVideos = [...state.videos];
        extractFolders();
        renderFolderTabs();
        renderVideoList();
    } catch (error) {
        console.error('Failed to refresh video list:', error);
    }
}

// ============================================================
// Folder Extraction & Tabs
// ============================================================

function extractFolders() {
    const folderSet = new Set();
    state.videos.forEach(video => {
        if (video.folder && video.folder !== '') {
            folderSet.add(video.folder);
        }
    });
    state.folders = Array.from(folderSet).sort();
}

function renderFolderTabs() {
    if (state.folders.length === 0) {
        folderTabs.style.display = 'none';
        return;
    }

    folderTabs.style.display = 'flex';
    let html = '<div class="tab active" data-folder="all" onclick="filterByFolder(\'all\')">All</div>';
    state.folders.forEach(folder => {
        const escapedFolder = folder.replace(/'/g, "\\'");
        html += `<div class="tab" data-folder="${folder}" onclick="filterByFolder('${escapedFolder}')">${folder}</div>`;
    });
    folderTabs.innerHTML = html;
}

function filterByFolder(folder) {
    state.currentFolder = folder;
    document.querySelectorAll('.folder-tabs .tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.folder === folder);
    });
    applyFilters();
}

// ============================================================
// Search & Filter
// ============================================================

function applyFilters() {
    let filtered = state.videos;

    // Folder filter
    if (state.currentFolder !== 'all') {
        filtered = filtered.filter(v => v.folder === state.currentFolder);
    }

    // Search filter
    const query = searchInput.value.toLowerCase().trim();
    if (query) {
        filtered = filtered.filter(v =>
            v.name.toLowerCase().includes(query) ||
            v.folder.toLowerCase().includes(query) ||
            v.filename.toLowerCase().includes(query)
        );
    }

    state.filteredVideos = filtered;
    renderVideoList();
}

// ============================================================
// Video List Rendering
// ============================================================

function renderVideoList() {
    videoCount.textContent = `${state.filteredVideos.length} video${state.filteredVideos.length !== 1 ? 's' : ''}`;

    if (state.filteredVideos.length === 0) {
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

    videoItems.innerHTML = state.filteredVideos.map((video, index) => {
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
                        <span class="meta-folder">${video.folder || 'Root'}</span>
                        <span class="meta-size">${video.size_display}</span>
                        <span class="meta-ext">${extBadge}</span>
                        ${subsBadge}
                    </div>
                </div>
            </div>`;
    }).join('');
}

// ============================================================
// Video Playback
// ============================================================

function playVideo(index) {
    const video = state.filteredVideos[index];
    if (!video) return;

    // Format warning
    if (!video.playable) {
        showFormatWarning(video.extension);
    } else {
        hideFormatWarning();
    }

    state.currentVideo = video;

    // Build video URL
    const encodedPath = video.path.split('/').map(encodeURIComponent).join('/');
    const videoUrl = `${state.tunnelUrl}/video/${encodedPath}`;

    // Remove existing subtitle tracks
    videoPlayer.querySelectorAll('track').forEach(t => t.remove());

    videoPlayer.src = videoUrl;

    // Add subtitle tracks if available (must be added BEFORE load)
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

        // Ensure all subtitle tracks start disabled (user chooses via CC button)
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

    // Update UI
    videoOverlay.classList.add('hidden');
    nowPlayingTitle.textContent = video.name;
    nowPlayingMeta.innerHTML = `
        <span class="meta-folder">${video.folder || 'Root'}</span>
        <span class="meta-size">${video.size_display}</span>
        <span class="meta-ext">${video.extension.replace('.', '').toUpperCase()}</span>`;

    renderVideoList();

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
    // Don't capture when typing in search
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

// Click overlay to dismiss
videoOverlay.addEventListener('click', () => {
    if (state.filteredVideos.length > 0) {
        playVideo(0);
    }
});

// ============================================================
// Event Listeners & Start
// ============================================================

searchInput.addEventListener('input', () => applyFilters());

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
