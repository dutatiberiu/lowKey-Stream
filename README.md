# lowkey-Stream

Stream local video files from your home PC to anywhere through Cloudflare Tunnel + GitHub Pages.

Live ---> https://dutatiberiu.github.io/lowKey-Stream/

## How it works

```
[Home PC]                          [GitHub Pages]
D:\Filme → Python Server (HTTP) ←→ Frontend (HTML/JS)
              ↓
         Cloudflare Tunnel
         (random .trycloudflare.com URL)
              ↓
         GitHub API → updates config.json with tunnel URL
```

1. Python script serves video files locally with Range request support
2. Cloudflare Tunnel exposes the local server to the internet (free, no account needed)
3. Script auto-updates GitHub Pages config with the tunnel URL
4. Frontend fetches config, displays video list, streams through tunnel.

## Quick Start

```bash
# 1. Install cloudflared
winget install Cloudflare.cloudflared

# 2. (Optional) Install ffmpeg for auto-conversion of MKV/AVI to MP4
winget install Gyan.FFmpeg

# 3. Configure
cd server
copy config.example.json config.json
# Edit config.json with your GitHub token and video folder path

# 4. Run
python stream_server.py
```

## Features

- Zero external Python dependencies (stdlib only)
- Zero frontend dependencies (vanilla JS)
- HTTP Range request support (video seeking works)
- Auto-converts MKV/AVI to MP4 in background (requires ffmpeg)
- Auto-restart tunnel on failure
- Auto-rescan video folder for changes
- Folder-based navigation
- Search filtering
- Keyboard shortcuts
- Responsive glassmorphism UI

## Config

Edit `server/config.json`:

| Key | Description |
|-----|-------------|
| `video_folder` | Path to your video folder (e.g. `D:\Filme`) |
| `server_port` | HTTP server port (default: 8080) |
| `github_token` | GitHub Personal Access Token with `repo` scope |
| `github_repo` | Your GitHub repo (e.g. `user/lowKey-Stream`) |

## Video Conversion

The server auto-detects ffmpeg and converts MKV/AVI/MOV files to MP4 in the background (video copied, audio re-encoded to AAC). Originals are renamed to `.bak`.

For bulk conversion without running the server:
```bash
python server/convert_videos.py
```
