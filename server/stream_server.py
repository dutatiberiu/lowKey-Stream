#!/usr/bin/env python3
"""
lowKey-Stream Server v2.0
Serves local video files via Cloudflare Named Tunnel (stream.oiotp.dev).
Auto-converts MKV/AVI to MP4, optimizes faststart, and compresses high-bitrate videos in background.

Zero external dependencies - uses only Python standard library.
Requires: cloudflared (named tunnel configured), ffmpeg (auto-detected)

Usage:
    python stream_server.py
"""

import http.server
import json
import os
import sys
import re
import signal
import time
import shutil
import threading
import subprocess
import urllib.parse
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

    required_keys = ["video_folder", "server_port"]
    for key in required_keys:
        if key not in config or not config[key]:
            print(f"[ERROR] Missing required config key: {key}")
            sys.exit(1)

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
    """Automatically converts, optimizes, and compresses videos in background."""

    CONVERTIBLE = {".mkv", ".avi", ".mov"}
    MAX_BITRATE = 8_000_000    # 8 Mbps - compress if above this
    TARGET_BITRATE = "5M"       # 5 Mbps - target for compression

    def __init__(self, video_folder, ffmpeg_path, on_conversion_done=None):
        self.video_folder = Path(video_folder)
        self.ffmpeg_path = ffmpeg_path
        self.ffprobe_path = self._find_ffprobe()
        self.on_conversion_done = on_conversion_done  # callback after each conversion
        self.converting_now = None  # path of file currently being converted
        self._stop_event = threading.Event()
        self._thread = None

    def _find_ffprobe(self):
        """Find ffprobe next to ffmpeg or on PATH."""
        ffprobe_exe = Path(self.ffmpeg_path).parent / "ffprobe.exe"
        if ffprobe_exe.exists():
            return str(ffprobe_exe)
        path = shutil.which("ffprobe")
        if path:
            return path
        return None

    def _get_video_bitrate(self, mp4_path):
        """Get overall bitrate in bits/sec using ffprobe."""
        if not self.ffprobe_path:
            return 0
        try:
            result = subprocess.run(
                [self.ffprobe_path, "-v", "quiet",
                 "-show_entries", "format=bit_rate",
                 "-of", "csv=p=0", str(mp4_path)],
                capture_output=True, text=True, timeout=30,
            )
            val = result.stdout.strip()
            return int(val) if val and val.isdigit() else 0
        except Exception:
            return 0

    def start(self):
        """Start background conversion thread."""
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        """Signal the converter to stop."""
        self._stop_event.set()

    def _run(self):
        """Main loop - converts, fixes faststart, and compresses videos."""
        while not self._stop_event.is_set():
            files_to_convert = self._find_unconverted()
            files_to_fix = self._find_needs_faststart()
            files_to_compress = self._find_needs_compression()

            if not files_to_convert and not files_to_fix and not files_to_compress:
                self._stop_event.wait(timeout=30)
                continue

            for file_path in files_to_convert:
                if self._stop_event.is_set():
                    break
                self._convert_one(file_path)

            for file_path in files_to_fix:
                if self._stop_event.is_set():
                    break
                self._fix_faststart(file_path)

            for file_path in files_to_compress:
                if self._stop_event.is_set():
                    break
                self._compress_video(file_path)

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

    def _find_needs_faststart(self):
        """Find MP4 files that need moov atom moved to start for instant playback."""
        needs_fix = []
        for file_path in sorted(self.video_folder.rglob("*.mp4")):
            if not file_path.is_file():
                continue
            if file_path.name.endswith(".mp4.tmp"):
                continue
            if self._needs_faststart(file_path):
                needs_fix.append(file_path)
        return needs_fix

    def _needs_faststart(self, mp4_path):
        """Check if MP4 has mdat before moov (needs faststart optimization)."""
        try:
            with open(mp4_path, "rb") as f:
                while True:
                    header = f.read(8)
                    if len(header) < 8:
                        break
                    size = int.from_bytes(header[:4], "big")
                    atom_type = header[4:8]
                    if atom_type == b"moov":
                        return False  # Already optimized
                    if atom_type == b"mdat":
                        return True  # Needs faststart
                    if size == 1:  # 64-bit extended size
                        ext = f.read(8)
                        if len(ext) < 8:
                            break
                        size = int.from_bytes(ext, "big")
                        f.seek(size - 16, 1)
                    elif size < 8:
                        break
                    else:
                        f.seek(size - 8, 1)
        except Exception:
            return False
        return False

    def _fix_faststart(self, mp4_path):
        """Run ffmpeg to move moov atom to start of file (no re-encode)."""
        rel = mp4_path.relative_to(self.video_folder)
        temp_path = mp4_path.with_name("_faststart_temp.mp4")

        self.converting_now = f"faststart: {rel}"
        print(f"[FASTSTART] Fixing: {rel}")

        cmd = [
            self.ffmpeg_path,
            "-i", str(mp4_path),
            "-c", "copy",
            "-movflags", "+faststart",
            "-y",
            str(temp_path),
        ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=3600,
            )
            if result.returncode == 0 and temp_path.exists():
                mp4_path.unlink()
                temp_path.rename(mp4_path)
                print(f"[FASTSTART] Done: {rel}")
                if self.on_conversion_done:
                    self.on_conversion_done()
            else:
                print(f"[FASTSTART] Failed: {rel}")
                if temp_path.exists():
                    temp_path.unlink()
        except subprocess.TimeoutExpired:
            print(f"[FASTSTART] Timeout: {rel}")
            if temp_path.exists():
                temp_path.unlink()
        except Exception as e:
            print(f"[FASTSTART] Error: {rel} - {e}")
            if temp_path.exists():
                temp_path.unlink()
        finally:
            self.converting_now = None

    def _find_needs_compression(self):
        """Find MP4 files with bitrate above MAX_BITRATE."""
        needs_compress = []
        for file_path in sorted(self.video_folder.rglob("*.mp4")):
            if not file_path.is_file():
                continue
            if file_path.name.endswith(".mp4.tmp"):
                continue
            bitrate = self._get_video_bitrate(file_path)
            if bitrate > self.MAX_BITRATE:
                needs_compress.append(file_path)
        return needs_compress

    def _compress_video(self, mp4_path):
        """Re-encode video to target bitrate for smooth streaming."""
        rel = mp4_path.relative_to(self.video_folder)
        temp_path = mp4_path.with_name("_compress_temp.mp4")
        size_before = mp4_path.stat().st_size
        bitrate = self._get_video_bitrate(mp4_path)

        self.converting_now = f"compress: {rel}"
        print(f"[COMPRESS] Starting: {rel} ({bitrate / 1_000_000:.1f} Mbps -> {self.TARGET_BITRATE}bps)")

        cmd = [
            self.ffmpeg_path,
            "-i", str(mp4_path),
            "-c:v", "libx264",
            "-b:v", self.TARGET_BITRATE,
            "-preset", "medium",
            "-c:a", "aac",
            "-b:a", "192k",
            "-movflags", "+faststart",
            "-y",
            str(temp_path),
        ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True,
                timeout=14400,  # 4 hours max per file
            )
            if result.returncode == 0 and temp_path.exists():
                size_after = temp_path.stat().st_size
                saved = (1 - size_after / size_before) * 100
                mp4_path.unlink()
                temp_path.rename(mp4_path)
                print(f"[COMPRESS] Done: {rel} ({size_before / 1024**3:.2f} GB -> {size_after / 1024**3:.2f} GB, {saved:.0f}% smaller)")
                if self.on_conversion_done:
                    self.on_conversion_done()
            else:
                print(f"[COMPRESS] Failed: {rel}")
                errors = result.stderr.strip().split("\n")[-2:]
                for line in errors:
                    print(f"           {line}")
                if temp_path.exists():
                    temp_path.unlink()
        except subprocess.TimeoutExpired:
            print(f"[COMPRESS] Timeout: {rel} (took >4 hours)")
            if temp_path.exists():
                temp_path.unlink()
        except Exception as e:
            print(f"[COMPRESS] Error: {rel} - {e}")
            if temp_path.exists():
                temp_path.unlink()
        finally:
            self.converting_now = None

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

                # Callback to trigger rescan
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
        BLOCK_SIZE = 1024 * 1024  # 1MB blocks for faster streaming
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
# Named Tunnel Manager
# ============================================================

class TunnelManager:
    """Manages cloudflared named tunnel lifecycle."""

    def __init__(self, tunnel_name):
        self.tunnel_name = tunnel_name
        self.process = None

    def start(self):
        cloudflared_path = find_executable("cloudflared")
        if not cloudflared_path:
            print("[ERROR] 'cloudflared' not found!")
            print("        Install it with: winget install Cloudflare.cloudflared")
            sys.exit(1)

        try:
            self.process = subprocess.Popen(
                [cloudflared_path, "tunnel", "run", self.tunnel_name],
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

        threading.Thread(target=read_output, args=(self.process.stderr,), daemon=True).start()
        threading.Thread(target=read_output, args=(self.process.stdout,), daemon=True).start()

        # Give it a moment to connect
        time.sleep(3)

        if self.process.poll() is not None:
            raise RuntimeError("Tunnel process exited immediately. Check cloudflared config.")

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
# Main Orchestrator
# ============================================================

def main():
    print("=" * 60)
    print("  lowKey-Stream Server v2.0")
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
        print("     Auto-conversion: MKV/AVI -> MP4 (AAC audio)")
        print("     Auto-faststart: MP4 moov atom optimization")
        print("     Auto-compress:  High-bitrate MP4s -> 5 Mbps for streaming")
    else:
        print("[WARN] ffmpeg not found - auto-conversion and faststart disabled")
        print("       Install with: winget install Gyan.FFmpeg")
    print()

    # Scanner
    scanner = VideoScanner(
        config["video_folder"],
        config["supported_extensions"],
        config["browser_playable"],
    )

    def rescan_and_update():
        """Called after each video conversion completes."""
        videos = scanner.scan()
        StreamRequestHandler.video_list = videos
        playable = sum(1 for v in videos if v["playable"])
        print(f"[RESCAN] {len(videos)} videos ({playable} playable)")

    # Initial scan
    print(f">> Scanning {config['video_folder']} for video files...")
    videos = scanner.scan()
    playable_count = sum(1 for v in videos if v["playable"])
    unconverted = sum(1 for v in videos if not v["playable"])
    print(f"[OK] Found {len(videos)} videos ({playable_count} playable, {unconverted} to convert)")
    print()

    # Start auto-converter (handles both MKV/AVI conversion and MP4 faststart fix)
    converter = None
    if ffmpeg_path:
        converter = AutoConverter(config["video_folder"], ffmpeg_path, on_conversion_done=rescan_and_update)
        needs_faststart = len(converter._find_needs_faststart())
        needs_compress = len(converter._find_needs_compression())
        if unconverted > 0 or needs_faststart > 0 or needs_compress > 0:
            tasks = []
            if unconverted > 0:
                tasks.append(f"{unconverted} to convert")
            if needs_faststart > 0:
                tasks.append(f"{needs_faststart} to faststart")
            if needs_compress > 0:
                tasks.append(f"{needs_compress} to compress")
            print(f">> Starting auto-converter ({', '.join(tasks)})...")
            converter.start()
            print("[OK] Auto-converter running in background")
            print()
        else:
            converter = None

    # Start HTTP server
    print(f">> Starting HTTP server on port {config['server_port']}...")
    StreamRequestHandler.video_list = videos
    StreamRequestHandler.video_folder = config["video_folder"]
    server = http.server.ThreadingHTTPServer(("0.0.0.0", config["server_port"]), StreamRequestHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"[OK] Server running at http://localhost:{config['server_port']}")
    print()

    # Start named tunnel
    tunnel_name = config.get("tunnel_name", "lowkey-stream")
    print(f">> Starting Cloudflare tunnel '{tunnel_name}'...")
    tunnel = TunnelManager(tunnel_name)
    try:
        tunnel.start()
    except RuntimeError as e:
        print(f"[ERROR] {e}")
        server.shutdown()
        sys.exit(1)
    print(f"[OK] Tunnel started: https://stream.oiotp.dev")
    print()

    # Ready!
    print("=" * 60)
    print(f"  Server is LIVE!")
    print(f"  Local:  http://localhost:{config['server_port']}")
    print(f"  Tunnel: https://stream.oiotp.dev")
    if converter:
        print(f"  Auto-processing videos in background...")
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

    # Main loop - periodic rescan for new files
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
                tunnel.start()
                print(f"[{timestamp}] Tunnel restarted")
            except Exception as e:
                print(f"[{timestamp}] Failed to restart tunnel: {e}")

        converting = ""
        if converter and converter.converting_now:
            converting = f", Converting: {converter.converting_now}"
        tunnel_status = "Tunnel OK" if tunnel.is_alive() else "Tunnel DOWN"
        print(f"[HEALTH] {timestamp} - {tunnel_status}, Server OK{converting}")

        # Rescan for new files
        new_videos = scanner.scan()
        if len(new_videos) != len(videos) or any(
            n["path"] != o["path"] for n, o in zip(new_videos, videos)
        ):
            videos = new_videos
            StreamRequestHandler.video_list = videos
            print(f"[{timestamp}] Video list changed ({len(videos)} videos)")

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
