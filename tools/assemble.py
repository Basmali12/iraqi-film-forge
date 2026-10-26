#!/usr/bin/env python3
"""Merge finished clips into one MP4 while preserving Iraqi dialogue and audio."""
import argparse,json,shutil,subprocess,sys
from pathlib import Path

def probe(p):
 r=subprocess.run(["ffprobe","-v","error","-show_entries","format=duration:stream=codec_type,width,height","-of","json",str(p)],capture_output=True,text=True,check=True)
 d=json.loads(r.stdout)
 v=next((s for s in d["streams"] if s["codec_type"]=="video"),None)
 if v is None:raise ValueError("Video missing: "+str(p))
 return dict(duration=float(d["format"]["duration"]),w=v["width"],h=v["height"],audio=any(s["codec_type"]=="audio" for s in d["streams"]))

def main():
 a=argparse.ArgumentParser()
 a.add_argument("clips",type=Path,nargs="+")
 a.add_argument("--output",type=Path,default=Path("output/final_film.mp4"))
 a.add_argument("--fps",type=int,default=24)
 args=a.parse_args()
 if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):sys.exit("Install FFmpeg first")
 info=[]
 for clip in args.clips:
  if not clip.is_file():sys.exit("Missing "+str(clip))
  info.append(probe(clip))
 args.output.parent.mkdir(parents=True,exist_ok=True)
 w=info[0]["w"]//2*2;h=info[0]["h"]//2*2
 cmd=["ffmpeg","-hide_banner","-loglevel","error","-y"]
 for c in args.clips:cmd.extend(["-i",str(c)])
 filters=[];sources=[]
 for i,v in enumerate(info):
  duration=max(.1,v["duration"])
  filters.append(f"[{i}:v:0]fps={args.fps},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,trim=duration={duration:.4f},setpts=PTS-STARTPTS[v{i}]")
  if v["audio"]:
   filters.append(f"[{i}:a:0]aresample=48000,apad,atrim=duration={duration:.4f},asetpts=PTS-STARTPTS[a{i}]")
  else:
   filters.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={duration:.4f},asetpts=PTS-STARTPTS[a{i}]")
  sources.append(f"[v{i}][a{i}]")
 filters.append("".join(sources)+f"concat=n={len(info)}:v=1:a=1[v][a]")
 cmd+=["-filter_complex",";".join(filters),"-map","[v]","-map","[a]","-c:v","libx264","-preset","veryfast","-crf","21","-pix_fmt","yuv420p","-c:a","aac","-b:a","128k","-movflags","+faststart",str(args.output)]
 subprocess.run(cmd,check=True)
 print("Created:",args.output,"duration:",round(probe(args.output)["duration"],2),"audio:",probe(args.output)["audio"])

if __name__=="__main__":main()