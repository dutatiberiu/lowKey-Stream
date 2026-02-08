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

