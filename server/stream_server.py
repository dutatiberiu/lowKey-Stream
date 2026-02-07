#!/usr/bin/env python3
"""
lowKey-Stream Server v1.1
Serves local video files through a Cloudflare Tunnel and updates GitHub Pages config.
Auto-converts MKV/AVI to MP4 (AAC audio) in background for browser compatibility.

Zero external dependencies - uses only Python standard library.
Requires: cloudflared, ffmpeg (both auto-detected)

Usage:
    python stream_server.py
"""

import http.server
import json
import os
import sys
import re
import signal
import base64
import time
import shutil
import threading
import subprocess
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from datetime import datetime, timezone

# ============================================================
# Utility: Find executables
# ============================================================

def find_executable(name):
    """Find an executable by name, checking PATH and common Windows install locations."""
    path = shutil.which(name)
    if path:
        return path

    # Check WinGet packages
    winget_dir = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages")
    if os.path.isdir(winget_dir):
        for d in os.listdir(winget_dir):
            if name.lower() in d.lower() or name.capitalize() in d:
                candidate_dir = os.path.join(winget_dir, d)
                for root, dirs, files in os.walk(candidate_dir):
                    if f"{name}.exe" in files:
                        return os.path.join(root, f"{name}.exe")

    # Common install locations
    for candidate in [
        rf"C:\Program Files (x86)\{name}\{name}.exe",
        rf"C:\Program Files\{name}\{name}.exe",
        rf"C:\Program Files (x86)\cloudflared\{name}.exe",
    ]:
        if os.path.isfile(candidate):
            return candidate

    return None


# ============================================================
# Configuration
# ============================================================

def load_config():
    """Load config from server/config.json"""
    config_path = Path(__file__).parent / "config.json"
    if not config_path.exists():
        print("[ERROR] config.json not found!")
        print(f"        Expected at: {config_path}")
        print("        Copy config.example.json to config.json and fill in your values.")
        sys.exit(1)

    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    required_keys = ["video_folder", "server_port", "github_token", "github_repo"]
    for key in required_keys:
        if key not in config or not config[key]:
            print(f"[ERROR] Missing required config key: {key}")
            sys.exit(1)

    config.setdefault("github_config_path", "docs/config.json")
    config.setdefault("supported_extensions", [".mp4", ".mkv", ".avi", ".mov", ".webm"])
    config.setdefault("browser_playable", [".mp4", ".webm"])
    config.setdefault("health_check_interval", 60)

    video_folder = Path(config["video_folder"])
    if not video_folder.exists():
        print(f"[ERROR] Video folder does not exist: {video_folder}")
        sys.exit(1)

    return config


# ============================================================
# Auto Converter - converts MKV/AVI to MP4 in background
# ============================================================

class AutoConverter:
    """Automatically converts non-browser-playable videos to MP4 in background."""

    CONVERTIBLE = {".mkv", ".avi", ".mov"}

    def __init__(self, video_folder, ffmpeg_path, on_conversion_done=None):
        self.video_folder = Path(video_folder)
        self.ffmpeg_path = ffmpeg_path
        self.on_conversion_done = on_conversion_done  # callback after each conversion
        self.converting_now = None  # path of file currently being converted
        self._stop_event = threading.Event()
        self._thread = None

    def start(self):
        """Start background conversion thread."""
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        """Signal the converter to stop."""
        self._stop_event.set()

    def _run(self):
        """Main conversion loop - runs forever, checking for new files to convert."""
        while not self._stop_event.is_set():
            files_to_convert = self._find_unconverted()
            if not files_to_convert:
                # Nothing to convert, wait and check again
                self._stop_event.wait(timeout=30)
                continue

            for file_path in files_to_convert:
                if self._stop_event.is_set():
                    break
                self._convert_one(file_path)

            # After a batch, wait before rechecking
            self._stop_event.wait(timeout=30)

    def _find_unconverted(self):
        """Find MKV/AVI files that don't have a corresponding MP4."""
        to_convert = []
        for file_path in sorted(self.video_folder.rglob("*")):
            if not file_path.is_file():
                continue
            if file_path.suffix.lower() not in self.CONVERTIBLE:
                continue
            # Skip .bak files
            if ".bak" in file_path.suffixes:
                continue
            mp4_path = file_path.with_suffix(".mp4")
            if not mp4_path.exists():
                to_convert.append(file_path)
        return to_convert

    def _convert_one(self, input_path):
        """Convert a single file to MP4 (video copy + audio AAC)."""
        rel = input_path.relative_to(self.video_folder)
        output_path = input_path.with_suffix(".mp4")
        temp_path = input_path.with_suffix(".mp4.tmp")

        self.converting_now = str(rel)
        print(f"[CONVERT] Starting: {rel}")

        cmd = [
            self.ffmpeg_path,
            "-i", str(input_path),
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-movflags", "+faststart",
            "-y",
            str(temp_path),
        ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True,
                timeout=3600,  # 1 hour max per file
            )

            if result.returncode == 0 and temp_path.exists():
                # Rename temp to final
                temp_path.rename(output_path)
                print(f"[CONVERT] Done: {rel} -> {output_path.name}")

                # Callback to trigger rescan + GitHub update
                if self.on_conversion_done:
                    self.on_conversion_done()
            else:
                print(f"[CONVERT] Failed: {rel}")
                errors = result.stderr.strip().split("\n")[-2:]
                for line in errors:
                    print(f"          {line}")
                # Clean up temp file
                if temp_path.exists():
                    temp_path.unlink()

        except subprocess.TimeoutExpired:
            print(f"[CONVERT] Timeout: {rel} (took >1 hour)")
            if temp_path.exists():
                temp_path.unlink()
        except Exception as e:
            print(f"[CONVERT] Error: {rel} - {e}")
            if temp_path.exists():
                temp_path.unlink()
        finally:
            self.converting_now = None


# ============================================================
# Video Scanner
# ============================================================

class VideoScanner:
    """Recursively scans a folder for video files."""

    def __init__(self, video_folder, supported_extensions, browser_playable):
        self.video_folder = Path(video_folder)
        self.supported_extensions = [ext.lower() for ext in supported_extensions]
        self.browser_playable = [ext.lower() for ext in browser_playable]

    def scan(self):
        """Scan video folder and return list of video dicts.

        If an MKV has a corresponding MP4, only the MP4 is listed.
        """
        videos = []
        seen_stems = set()  # track (folder, stem) to avoid duplicates

        # First pass: collect all files
        all_files = []
        for file_path in sorted(self.video_folder.rglob("*")):
            if not file_path.is_file():
                continue
            ext = file_path.suffix.lower()
            if ext not in self.supported_extensions:
                continue
            # Skip temp files from conversion
            if file_path.name.endswith(".mp4.tmp"):
                continue
            all_files.append(file_path)

        # Second pass: prefer MP4 over MKV/AVI when both exist
        mp4_stems = set()
        for f in all_files:
            if f.suffix.lower() == ".mp4":
                mp4_stems.add((f.parent, f.stem))

        for file_path in all_files:
            ext = file_path.suffix.lower()
            key = (file_path.parent, file_path.stem)

            # Skip MKV/AVI if MP4 version exists
            if ext in {".mkv", ".avi", ".mov"} and key in mp4_stems:
                continue

            rel_path = file_path.relative_to(self.video_folder)
            parts = rel_path.parts
            folder = parts[0] if len(parts) > 1 else ""
            size = file_path.stat().st_size

            videos.append({
                "name": file_path.stem,
                "filename": file_path.name,
                "path": str(rel_path).replace("\\", "/"),
                "size": size,
                "size_display": self._format_size(size),
                "extension": ext,
                "playable": ext in self.browser_playable,
                "folder": folder,
            })

        return videos

    @staticmethod
    def _format_size(size_bytes):
        if size_bytes < 1024:
            return f"{size_bytes} B"
        elif size_bytes < 1024 ** 2:
            return f"{size_bytes / 1024:.1f} KB"
        elif size_bytes < 1024 ** 3:
            return f"{size_bytes / 1024 ** 2:.1f} MB"
        else:
            return f"{size_bytes / 1024 ** 3:.2f} GB"


# ============================================================
# HTTP Request Handler with CORS + Range Support
# ============================================================

class StreamRequestHandler(http.server.BaseHTTPRequestHandler):
    """HTTP handler with CORS headers and Range request support for video streaming."""

    video_list = []
    video_folder = ""

    def log_message(self, format, *args):
        method = args[0] if args else ""
        if "/api/health" not in str(method) and "OPTIONS" not in str(method):
            print(f"[HTTP] {self.address_string()} - {format % args}")

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self._route_request(head_only=True)

    def do_GET(self):
        self._route_request(head_only=False)

    def _route_request(self, head_only=False):
        path = urllib.parse.unquote(self.path)

        if path == "/api/videos":
            self._handle_api_videos(head_only)
        elif path == "/api/health":
            self._handle_api_health(head_only)
        elif path.startswith("/video/"):
            relative_path = path[7:]
            self._handle_video_stream(relative_path, head_only)
        else:
            self.send_error(404, "Not Found")

    def _handle_api_videos(self, head_only=False):
        data = {
            "videos": self.video_list,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "server_status": "online",
        }
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _handle_api_health(self, head_only=False):
        data = {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}
        body = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _handle_video_stream(self, relative_path, head_only=False):
        video_folder = Path(self.video_folder).resolve()
        full_path = (video_folder / relative_path).resolve()

        if not str(full_path).startswith(str(video_folder)):
            self.send_error(403, "Forbidden")
            return

        if not full_path.exists() or not full_path.is_file():
            self.send_error(404, "File not found")
            return

        file_size = full_path.stat().st_size
        content_type = {
            ".mp4": "video/mp4",
            ".webm": "video/webm",
            ".mkv": "video/x-matroska",
            ".avi": "video/x-msvideo",
            ".mov": "video/quicktime",
        }.get(full_path.suffix.lower(), "application/octet-stream")

        range_header = self.headers.get("Range")

        if range_header:
            range_match = re.match(r"bytes=(\d+)-(\d*)", range_header)
            if not range_match:
                self.send_error(416, "Range Not Satisfiable")
                return

            start = int(range_match.group(1))
            end = int(range_match.group(2)) if range_match.group(2) else file_size - 1
            end = min(end, file_size - 1)

            if start > end or start >= file_size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self._send_cors_headers()
                self.end_headers()
                return

            chunk_size = end - start + 1
            self.send_response(206)
            self._send_cors_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(chunk_size))
            self.end_headers()
            if not head_only:
                self._stream_file(full_path, start, chunk_size)
        else:
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(file_size))
            self.end_headers()
            if not head_only:
                self._stream_file(full_path, 0, file_size)

    def _stream_file(self, file_path, start, length):
        BLOCK_SIZE = 65536
        try:
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    read_size = min(BLOCK_SIZE, remaining)
                    data = f.read(read_size)
                    if not data:
                        break
                    self.wfile.write(data)
                    remaining -= len(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


# ============================================================
# Cloudflare Tunnel Manager
# ============================================================

class TunnelManager:
    """Manages cloudflared tunnel lifecycle."""

    def __init__(self, local_port):
        self.local_port = local_port
        self.process = None
        self.tunnel_url = None

    def start(self):
        self.tunnel_url = None
        url_found = threading.Event()

        cloudflared_path = find_executable("cloudflared")
        if not cloudflared_path:
            print("[ERROR] 'cloudflared' not found!")
            print("        Install it with: winget install Cloudflare.cloudflared")
            sys.exit(1)

        try:
            self.process = subprocess.Popen(
                [cloudflared_path, "tunnel", "--url", f"http://localhost:{self.local_port}"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
        except FileNotFoundError:
            print("[ERROR] Could not start cloudflared!")
            sys.exit(1)

        def read_output(stream):
            for line in stream:
                stripped = line.strip()
                if stripped:
                    print(f"[TUNNEL] {stripped}")
                match = re.search(r"(https://[a-zA-Z0-9-]+\.trycloudflare\.com)", line)
                if match:
                    self.tunnel_url = match.group(1)
                    url_found.set()

        threading.Thread(target=read_output, args=(self.process.stderr,), daemon=True).start()
        threading.Thread(target=read_output, args=(self.process.stdout,), daemon=True).start()

        if not url_found.wait(timeout=30):
            self.stop()
            raise RuntimeError("Tunnel failed to start within 30 seconds")

        return self.tunnel_url

    def stop(self):
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None

    def is_alive(self):
        return self.process is not None and self.process.poll() is None


# ============================================================
# GitHub Updater
# ============================================================

class GitHubUpdater:
    """Updates config.json on GitHub Pages via REST API."""

    def __init__(self, token, repo, config_path):
        self.token = token
        self.repo = repo
        self.config_path = config_path
        self.api_base = "https://api.github.com"

    def update_config(self, tunnel_url, video_list):
        content = {
            "tunnel_url": tunnel_url,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "server_status": "online",
            "videos": video_list,
        }
        sha = self._get_file_sha()
        content_json = json.dumps(content, indent=2, ensure_ascii=False)
        content_b64 = base64.b64encode(content_json.encode("utf-8")).decode("utf-8")
        body = {
            "message": f"Update tunnel URL - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            "content": content_b64,
        }
        if sha:
            body["sha"] = sha

        url = f"{self.api_base}/repos/{self.repo}/contents/{self.config_path}"
        result = self._github_request("PUT", url, body)
        if result is None:
            raise RuntimeError("Failed to update GitHub config")
        return result

    def _get_file_sha(self):
        url = f"{self.api_base}/repos/{self.repo}/contents/{self.config_path}"
        result = self._github_request("GET", url)
        if result and "sha" in result:
            return result["sha"]
        return None

    def _github_request(self, method, url, data=None):
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "lowKey-Stream/1.0",
        }
        if data:
            headers["Content-Type"] = "application/json"

        body = json.dumps(data).encode("utf-8") if data else None
        req = urllib.request.Request(url, data=body, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            elif e.code == 401:
                print("[ERROR] GitHub authentication failed. Check your token.")
                sys.exit(1)
            else:
                error_body = e.read().decode("utf-8")
                print(f"[ERROR] GitHub API {e.code}: {error_body}")
                return None
        except urllib.error.URLError as e:
            print(f"[ERROR] GitHub API network error: {e.reason}")
            return None


# ============================================================
# Main Orchestrator
# ============================================================

def main():
    print("=" * 60)
    print("  lowKey-Stream Server v1.1")
    print("=" * 60)
    print()

    # Load config
    print(">> Loading config...")
    config = load_config()
    print(f"[OK] Config loaded (port: {config['server_port']})")
    print()

    # Check ffmpeg
    ffmpeg_path = find_executable("ffmpeg")
    if ffmpeg_path:
        print(f"[OK] ffmpeg found: {ffmpeg_path}")
        print("     Auto-conversion enabled: MKV/AVI -> MP4 (AAC audio)")
    else:
        print("[WARN] ffmpeg not found - auto-conversion disabled")
        print("       Install with: winget install Gyan.FFmpeg")
    print()

    # Scanner
    scanner = VideoScanner(
        config["video_folder"],
        config["supported_extensions"],
        config["browser_playable"],
    )

    # Shared state for rescan callback
    tunnel_url_ref = [None]
    github_ref = [None]

    def rescan_and_update():
        """Called after each video conversion completes."""
        videos = scanner.scan()
        StreamRequestHandler.video_list = videos
        playable = sum(1 for v in videos if v["playable"])
        print(f"[RESCAN] {len(videos)} videos ({playable} playable)")
        if tunnel_url_ref[0] and github_ref[0]:
            try:
                github_ref[0].update_config(tunnel_url_ref[0], videos)
                print("[RESCAN] GitHub config updated")
            except Exception as e:
                print(f"[RESCAN] GitHub update failed: {e}")

    # Initial scan
    print(f">> Scanning {config['video_folder']} for video files...")
    videos = scanner.scan()
    playable_count = sum(1 for v in videos if v["playable"])
    unconverted = sum(1 for v in videos if not v["playable"])
    print(f"[OK] Found {len(videos)} videos ({playable_count} playable, {unconverted} to convert)")
    print()

    # Start auto-converter
    converter = None
    if ffmpeg_path and unconverted > 0:
        print(f">> Starting auto-converter ({unconverted} files queued)...")
        converter = AutoConverter(config["video_folder"], ffmpeg_path, on_conversion_done=rescan_and_update)
        converter.start()
        print("[OK] Auto-converter running in background")
        print()

    # Start HTTP server
    print(f">> Starting HTTP server on port {config['server_port']}...")
    StreamRequestHandler.video_list = videos
    StreamRequestHandler.video_folder = config["video_folder"]
    server = http.server.HTTPServer(("0.0.0.0", config["server_port"]), StreamRequestHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"[OK] Server running at http://localhost:{config['server_port']}")
    print()

    # Start tunnel
    print(">> Starting Cloudflare tunnel...")
    tunnel = TunnelManager(config["server_port"])
    try:
        tunnel_url = tunnel.start()
    except RuntimeError as e:
        print(f"[ERROR] {e}")
        server.shutdown()
        sys.exit(1)
    tunnel_url_ref[0] = tunnel_url
    print(f"[OK] Tunnel active: {tunnel_url}")
    print()

    # Update GitHub
    print(">> Updating GitHub config.json...")
    github = GitHubUpdater(config["github_token"], config["github_repo"], config["github_config_path"])
    github_ref[0] = github
    try:
        github.update_config(tunnel_url, videos)
        print("[OK] GitHub Pages config updated successfully")
    except Exception as e:
        print(f"[WARN] Failed to update GitHub: {e}")
    print()

    # Ready!
    print("=" * 60)
    print(f"  Server is LIVE!")
    print(f"  Local:  http://localhost:{config['server_port']}")
    print(f"  Tunnel: {tunnel_url}")
    if converter:
        print(f"  Auto-converting {unconverted} videos in background...")
    print(f"  Press Ctrl+C to stop.")
    print("=" * 60)
    print()

    # Shutdown handler
    shutdown_event = threading.Event()

    def shutdown_handler(signum, frame):
        print("\n>> Shutting down...")
        shutdown_event.set()

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, shutdown_handler)

    # Main loop
    check_interval = config.get("health_check_interval", 60)
    while not shutdown_event.is_set():
        shutdown_event.wait(timeout=check_interval)
        if shutdown_event.is_set():
            break

        timestamp = datetime.now().strftime("%H:%M:%S")

        # Check tunnel
        if not tunnel.is_alive():
            print(f"[{timestamp}] Tunnel died! Restarting...")
            try:
                tunnel_url = tunnel.start()
                tunnel_url_ref[0] = tunnel_url
                print(f"[{timestamp}] Tunnel restarted: {tunnel_url}")
                github.update_config(tunnel_url, StreamRequestHandler.video_list)
            except Exception as e:
                print(f"[{timestamp}] Failed to restart tunnel: {e}")
        else:
            converting = ""
            if converter and converter.converting_now:
                converting = f", Converting: {converter.converting_now}"
            print(f"[HEALTH] {timestamp} - Tunnel OK, Server OK{converting}")

        # Rescan for new files (converter callback also rescans, but this catches manual additions)
        new_videos = scanner.scan()
        if len(new_videos) != len(videos) or any(
            n["path"] != o["path"] for n, o in zip(new_videos, videos)
        ):
            videos = new_videos
            StreamRequestHandler.video_list = videos
            print(f"[{timestamp}] Video list changed ({len(videos)} videos), updating GitHub...")
            try:
                github.update_config(tunnel_url, videos)
            except Exception as e:
                print(f"[{timestamp}] Failed to update GitHub: {e}")

    # Cleanup
    if converter:
        print(">> Stopping auto-converter...")
        converter.stop()
    print(">> Stopping tunnel...")
    tunnel.stop()
    print(">> Stopping server...")
    server.shutdown()
    print("[OK] Goodbye!")


if __name__ == "__main__":
    main()
