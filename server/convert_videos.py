#!/usr/bin/env python3
"""
Batch video processor for lowKey-Stream.
1. Converts MKV/AVI to MP4 (video copy + AAC audio, fast)
2. Compresses high-bitrate MP4s for smooth streaming (re-encodes to 5 Mbps)

After processing, originals are renamed to .bak.

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


MAX_BITRATE = 8_000_000    # 8 Mbps - compress if above this
TARGET_BITRATE = "5M"       # 5 Mbps - good 1080p quality


def find_ffprobe(ffmpeg_path):
    """Find ffprobe next to ffmpeg or on PATH."""
    ffprobe_beside = Path(ffmpeg_path).parent / "ffprobe.exe"
    if ffprobe_beside.exists():
        return str(ffprobe_beside)
    path = shutil.which("ffprobe")
    if path:
        return path
    return None


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


def get_video_bitrate(ffprobe_path, video_path):
    """Get overall bitrate in bits/sec using ffprobe."""
    if not ffprobe_path:
        return 0
    try:
        result = subprocess.run(
            [ffprobe_path, "-v", "quiet",
             "-show_entries", "format=bit_rate",
             "-of", "csv=p=0", str(video_path)],
            capture_output=True, text=True, timeout=30,
        )
        val = result.stdout.strip()
        return int(val) if val and val.isdigit() else 0
    except Exception:
        return 0


def compress_file(ffmpeg_path, input_path, output_path):
    """Re-encode video to target bitrate for streaming."""
    cmd = [
        ffmpeg_path,
        "-i", str(input_path),
        "-c:v", "libx264",
        "-b:v", TARGET_BITRATE,
        "-preset", "medium",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-y",
        str(output_path),
    ]

    print(f"    Compressing (this may take a while)... ", end="", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode == 0:
        print("OK")
        return True
    else:
        print("FAILED")
        errors = result.stderr.strip().split("\n")[-3:]
        for line in errors:
            print(f"    {line}")
        return False


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

    ffprobe_path = find_ffprobe(ffmpeg_path)

    print(f"[OK] ffmpeg found: {ffmpeg_path}")
    if ffprobe_path:
        print(f"[OK] ffprobe found: {ffprobe_path}")
    else:
        print("[WARN] ffprobe not found - compression detection disabled")
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

    converted = 0
    failed = 0

    if not files_to_convert:
        print("No files need conversion! All videos are already MP4/WebM.")
    else:
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
            print("Skipped.")
        else:
            print()
            for i, file_path in enumerate(files_to_convert, 1):
                rel = file_path.relative_to(video_folder)
                print(f"[{i}/{len(files_to_convert)}] {rel}")

                mp4_path = file_path.with_suffix(".mp4")

                if convert_file(ffmpeg_path, file_path, mp4_path):
                    bak_path = file_path.with_suffix(file_path.suffix + ".bak")
                    file_path.rename(bak_path)
                    print(f"    Original renamed to {bak_path.name}")
                    converted += 1
                else:
                    failed += 1
                    if mp4_path.exists():
                        mp4_path.unlink()

        print()

    print("=" * 60)
    print(f"  Conversion done! Converted: {converted}, Failed: {failed}")
    if converted > 0:
        print(f"  Original files renamed to .bak (delete manually when verified)")
    print("=" * 60)
    print()

    # ── Phase 2: Compress high-bitrate MP4s ──────────────────
    if not ffprobe_path:
        print("Skipping compression check (ffprobe not found).")
        return

    print(">> Scanning MP4 files for high bitrate...")
    files_to_compress = []

    for file_path in sorted(video_folder.rglob("*.mp4")):
        if not file_path.is_file():
            continue
        if file_path.name.endswith(".mp4.tmp"):
            continue
        if ".bak" in file_path.suffixes:
            continue
        bitrate = get_video_bitrate(ffprobe_path, file_path)
        rel = file_path.relative_to(video_folder)
        if bitrate == 0:
            print(f"  [?] {rel} - could not detect bitrate")
        elif bitrate > MAX_BITRATE:
            print(f"  [!] {rel} - {bitrate / 1_000_000:.1f} Mbps (needs compression)")
            files_to_compress.append((file_path, bitrate))
        else:
            print(f"  [OK] {rel} - {bitrate / 1_000_000:.1f} Mbps")

    if not files_to_compress:
        print("\nAll MP4 files are already optimized for streaming!")
        input("\nPress Enter to exit...")
        return

    print(f"\nFound {len(files_to_compress)} files with high bitrate (>{MAX_BITRATE // 1_000_000} Mbps):")
    for f, br in files_to_compress:
        size = f.stat().st_size
        size_str = f"{size / 1024**3:.2f} GB" if size > 1024**3 else f"{size / 1024**2:.0f} MB"
        print(f"  - {f.relative_to(video_folder)} ({size_str}, {br / 1_000_000:.1f} Mbps)")

    print(f"\nWill compress to {TARGET_BITRATE}bps (good 1080p quality).")
    print("Note: This re-encodes video and can take a long time per file.")
    print()

    response = input("Start compression? (y/n): ").strip().lower()
    if response != "y":
        print("Cancelled.")
        return

    print()
    compressed = 0
    comp_failed = 0

    for i, (file_path, bitrate) in enumerate(files_to_compress, 1):
        rel = file_path.relative_to(video_folder)
        size_before = file_path.stat().st_size
        print(f"[{i}/{len(files_to_compress)}] {rel} ({bitrate / 1_000_000:.1f} Mbps)")

        temp_path = file_path.with_name(file_path.stem + ".compressed.mp4.tmp")

        if compress_file(ffmpeg_path, file_path, temp_path):
            size_after = temp_path.stat().st_size
            saved = (1 - size_after / size_before) * 100
            print(f"    Size: {size_before / 1024**3:.2f} GB -> {size_after / 1024**3:.2f} GB ({saved:.0f}% smaller)")
            # Rename original to .bak, move compressed to original name
            bak_path = file_path.with_suffix(".mp4.bak")
            file_path.rename(bak_path)
            temp_path.rename(file_path)
            print(f"    Original saved as {bak_path.name}")
            compressed += 1
        else:
            comp_failed += 1
            if temp_path.exists():
                temp_path.unlink()

        print()

    print("=" * 60)
    print(f"  Compression done! Compressed: {compressed}, Failed: {comp_failed}")
    if compressed > 0:
        print(f"  Originals renamed to .mp4.bak (delete manually when verified)")
    print("=" * 60)

    input("\nPress Enter to exit...")


if __name__ == "__main__":
    main()
