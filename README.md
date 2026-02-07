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
4. Frontend fetches config, displays video list, streams through tunnel

## Quick Start

```bash
# 1. Install cloudflared
winget install Cloudflare.cloudflared

# 2. Configure
cd server
copy config.example.json config.json
# Edit config.json with your GitHub token and video folder path

# 3. Run
python stream_server.py

# 4. Open in browser
# https://dutatiberiu.github.io/lowKey-Stream/
```

See [setup.md](setup.md) for detailed instructions.

## Features

- Zero external Python dependencies (stdlib only)
- Zero frontend dependencies (vanilla JS)
- HTTP Range request support (video seeking works)
- Auto-restart tunnel on failure
- Auto-rescan video folder for changes
- Folder-based navigation
- Search filtering
- Keyboard shortcuts
- Responsive glassmorphism UI
- Format warnings for non-browser-playable files (MKV/AVI)

## Supported Formats

| Format | Browser Playback |
|--------|-----------------|
| .mp4   | Yes |
| .webm  | Yes |
| .mkv   | Limited (depends on codecs) |
| .avi   | No |
| .mov   | Limited |

Convert non-playable formats: `ffmpeg -i input.mkv -codec copy output.mp4`
