#!/usr/bin/env python3
"""
Batch convert MKV/AVI videos to MP4 (browser-compatible).
- Video: copy (no re-encoding, instant)
- Audio: re-encode to AAC (browser-compatible)
- Subtitles: removed (not supported in MP4 container from MKV)

After conversion, original MKV files are kept (rename to .mkv.bak).
Delete them manually after verifying the MP4s work.

Usage:
    python convert_videos.py
"""

import subprocess
import sys
import os
import json
import shutil
from pathlib import Path


def find_ffmpeg():
    """Find ffmpeg executable."""
    path = shutil.which("ffmpeg")
    if path:
        return path
    # Search common install locations and WinGet packages
    winget_dir = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages")
    winget_candidates = []
    if os.path.isdir(winget_dir):
        for d in os.listdir(winget_dir):
            if "FFmpeg" in d:
                candidate = os.path.join(winget_dir, d)
                for root, dirs, files in os.walk(candidate):
                    if "ffmpeg.exe" in files:
                        winget_candidates.append(os.path.join(root, "ffmpeg.exe"))

    for candidate in winget_candidates + [
        r"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
        r"C:\ffmpeg\bin\ffmpeg.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe"),
    ]:
        if os.path.isfile(candidate):
            return candidate
    return None


def load_config():
    config_path = Path(__file__).parent / "config.json"
    if not config_path.exists():
        print("[ERROR] config.json not found!")
        sys.exit(1)
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_audio_codec(ffmpeg_path, video_path):
    """Get audio codec of a video file using ffprobe."""
    ffprobe_path = str(Path(ffmpeg_path).parent / "ffprobe")
    if not shutil.which(ffprobe_path):
        ffprobe_path = shutil.which("ffprobe") or ffprobe_path

    try:
        result = subprocess.run(
            [ffprobe_path, "-v", "quiet", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0",
             str(video_path)],
            capture_output=True, text=True, timeout=30
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def convert_file(ffmpeg_path, input_path, output_path):
    """Convert video: copy video stream, re-encode audio to AAC."""
    cmd = [
        ffmpeg_path,
        "-i", str(input_path),
        "-c:v", "copy",          # Copy video (no re-encode)
        "-c:a", "aac",           # Re-encode audio to AAC
        "-b:a", "192k",          # Audio bitrate
        "-movflags", "+faststart",  # Optimize for streaming
        "-y",                    # Overwrite output
        str(output_path)
    ]

    print(f"    Converting... ", end="", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode == 0:
        print("OK")
        return True
    else:
        print("FAILED")
        # Show last few lines of error
        errors = result.stderr.strip().split("\n")[-3:]
        for line in errors:
            print(f"    {line}")
        return False


def main():
    print("=" * 60)
    print("  lowKey-Stream Video Converter")
    print("=" * 60)
    print()

    config = load_config()
    video_folder = Path(config["video_folder"])

    ffmpeg_path = find_ffmpeg()
    if not ffmpeg_path:
        print("[ERROR] ffmpeg not found!")
        print("        Install with: winget install Gyan.FFmpeg")
        sys.exit(1)

    print(f"[OK] ffmpeg found: {ffmpeg_path}")
    print(f"[OK] Video folder: {video_folder}")
    print()

    # Find all non-MP4/WebM files
    extensions_to_convert = {".mkv", ".avi", ".mov"}
    files_to_convert = []

    for file_path in sorted(video_folder.rglob("*")):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() in extensions_to_convert:
            # Check if MP4 version already exists
            mp4_path = file_path.with_suffix(".mp4")
            if mp4_path.exists():
                continue
            files_to_convert.append(file_path)

    if not files_to_convert:
        print("No files need conversion! All videos are already MP4/WebM or have been converted.")
        return

    print(f"Found {len(files_to_convert)} files to convert:")
    total_size = 0
    for f in files_to_convert:
        size = f.stat().st_size
        total_size += size
        size_str = f"{size / 1024**3:.2f} GB" if size > 1024**3 else f"{size / 1024**2:.0f} MB"
        print(f"  - {f.relative_to(video_folder)} ({size_str})")

    print(f"\nTotal: {total_size / 1024**3:.1f} GB")
    print(f"Note: Video is copied (fast), only audio is re-encoded to AAC.")
    print()

    response = input("Start conversion? (y/n): ").strip().lower()
    if response != "y":
        print("Cancelled.")
        return

    print()
    converted = 0
    failed = 0

    for i, file_path in enumerate(files_to_convert, 1):
        rel = file_path.relative_to(video_folder)
        print(f"[{i}/{len(files_to_convert)}] {rel}")

        mp4_path = file_path.with_suffix(".mp4")

        if convert_file(ffmpeg_path, file_path, mp4_path):
            # Rename original to .bak
            bak_path = file_path.with_suffix(file_path.suffix + ".bak")
            file_path.rename(bak_path)
            print(f"    Original renamed to {bak_path.name}")
            converted += 1
        else:
            failed += 1
            # Clean up failed output
            if mp4_path.exists():
                mp4_path.unlink()

        print()

    print("=" * 60)
    print(f"  Done! Converted: {converted}, Failed: {failed}")
    print(f"  Original files renamed to .bak (delete manually when verified)")
    print("=" * 60)


if __name__ == "__main__":
    main()
