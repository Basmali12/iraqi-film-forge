#!/usr/bin/env python3
"""Stitch completed HeyGen clips with audio, optional short synchronized dissolve.

This utility runs FFmpeg locally (no GPU and no additional video API costs).
It cannot guarantee continuity of acting, voices or camera motion between AI shots.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def probe(path: Path) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration:stream=codec_type,width,height",
        "-of", "json", str(path)
    ], check=True, capture_output=True, text=True)
    doc = json.loads(result.stdout)
    video = next((s for s in doc["streams"] if s["codec_type"] == "video"), None)
    if video is None:
        raise ValueError(f"Video stream is missing: {path}")
    return {
        "duration": float(doc["format"]["duration"]),
        "w": int(video["width"]),
        "h": int(video["height"]),
        "audio": any(s["codec_type"] == "audio" for s in doc["streams"]),
    }


def render(clips: list[Path], output: Path, fps: int = 24,
           transition: str = "cut", fade_ms: int = 200) -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("Install FFmpeg and FFprobe")
    if not clips or any(not p.is_file() for p in clips):
        raise ValueError("Pass existing video files in timeline order")
    if transition not in ("cut", "smooth"):
        raise ValueError("Transition must be cut or smooth")
    if not 80 <= fade_ms <= 500:
        raise ValueError("fade-ms must be between 80 and 500")

    info = [probe(p) for p in clips]
    w = info[0]["w"] // 2 * 2
    h = info[0]["h"] // 2 * 2
    fade = fade_ms / 1000
    if transition == "smooth" and min(p["duration"] for p in info) <= fade * 2:
        raise ValueError("Clip is too short for selected dissolve")

    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    for clip in clips:
        cmd.extend(["-i", str(clip)])

    filters = []
    for i, meta in enumerate(info):
        base = (f"[{i}:v:0]fps={fps},"
                f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p")
        # FFmpeg xfade requires a constant frame rate. In FFmpeg 7.x, setpts
        # after fps may reset xfade's negotiated frame-rate; omit it in soft mode.
        if transition == "cut":
            base += f",trim=duration={meta['duration']:.4f},setpts=PTS-STARTPTS"
        filters.append(base + f"[v{i}]")
        if meta["audio"]:
            filters.append(
                f"[{i}:a:0]aresample=48000,apad,"
                f"atrim=duration={meta['duration']:.4f},asetpts=PTS-STARTPTS[a{i}]"
            )
        else:
            filters.append(
                f"anullsrc=r=48000:cl=stereo,"
                f"atrim=duration={meta['duration']:.4f},asetpts=PTS-STARTPTS[a{i}]"
            )

    if transition == "smooth" and len(info) > 1:
        previous_video, previous_audio = "v0", "a0"
        running_duration = info[0]["duration"]
        for i in range(1, len(info)):
            v, a = f"vfade{i}", f"afade{i}"
            offset = max(.1, running_duration - fade)
            filters.append(
                f"[{previous_video}][v{i}]"
                f"xfade=transition=fade:duration={fade:.3f}:"
                f"offset={offset:.4f}[{v}]"
            )
            filters.append(
                f"[{previous_audio}][a{i}]"
                f"acrossfade=d={fade:.3f}:c1=tri:c2=tri[{a}]"
            )
            previous_video, previous_audio = v, a
            running_duration += info[i]["duration"] - fade
        video_map, audio_map = f"[{previous_video}]", f"[{previous_audio}]"
    else:
        sequence = "".join(f"[v{i}][a{i}]" for i in range(len(info)))
        filters.append(sequence + f"concat=n={len(info)}:v=1:a=1[outv][outa]")
        video_map, audio_map = "[outv]", "[outa]"

    cmd.extend([
        "-filter_complex", ";".join(filters),
        "-map", video_map, "-map", audio_map,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", str(output)
    ])
    subprocess.run(cmd, check=True)
    merged = probe(output)
    expected = sum(v["duration"] for v in info) - (
        fade * (len(info) - 1) if transition == "smooth" else 0
    )
    if abs(merged["duration"] - expected) > max(2.0, 0.1 * len(info)):
        raise RuntimeError("Merged duration failed validation")
    if not merged["audio"]:
        raise RuntimeError("Merged video has no audio track")
    print(
        f"Created: {output} | {merged['duration']:.2f}s | "
        f"audio preserved | {transition} | {len(clips)} clips"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("clips", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, default=Path("output/final_film.mp4"))
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--transition", choices=("cut", "smooth"), default="cut")
    parser.add_argument("--fade-ms", type=int, default=200)
    args = parser.parse_args()
    try:
        render(args.clips, args.output, args.fps, args.transition, args.fade_ms)
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))


if __name__ == "__main__":
    main()
