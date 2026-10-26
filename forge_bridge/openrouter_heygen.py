"""Forge Film integration for OpenRouter HeyGen Video.
Uses upstream Forge BasePipeline; output jobs are saved to avoid duplicate charges.
"""
import asyncio
import base64
import json
import os
from pathlib import Path
import httpx
from forge.generation.base import BasePipeline

API="https://openrouter.ai/api/v1"
MODEL="heygen/heygen-video-1"

class OpenRouterHeyGenPipeline(BasePipeline):
    def __init__(self,duration=15,resolution="480p",aspect_ratio="9:16"):
        if duration not in (5,8,10,15) or resolution not in ("480p","768p") or aspect_ratio not in ("9:16","16:9","1:1"):
            raise ValueError("Unsupported HeyGen output options")
        self.duration=duration
        self.resolution=resolution
        self.aspect_ratio=aspect_ratio
        self.key=os.environ.get("OPENROUTER_API_KEY","")
        if not self.key.startswith("sk-or-v1-"):
            raise RuntimeError("Set OPENROUTER_API_KEY environment variable. Never commit API keys.")
        self.headers={"Authorization":"Bearer "+self.key,"Content-Type":"application/json"}

    async def generate(self,scene,assets,output_dir,prev_frame=None):
        folder=Path(output_dir)/"scenes"
        folder.mkdir(parents=True,exist_ok=True)
        out=folder/(scene.id+".mp4")
        if out.is_file() and out.stat().st_size>1000:return str(out)
        jobfile=folder/(scene.id+".job.json")
        async with httpx.AsyncClient(timeout=65,follow_redirects=False) as client:
            if jobfile.exists():
                job=json.loads(jobfile.read_text(encoding="utf8"))["id"]
            else:
                data={"model":MODEL,"prompt":scene.description,"duration":self.duration,
                      "resolution":self.resolution,"aspect_ratio":self.aspect_ratio}
                if prev_frame and Path(prev_frame).is_file():
                    encoded=base64.b64encode(Path(prev_frame).read_bytes()).decode("ascii")
                    data["frame_images"]=[{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+encoded},"frame_type":"first_frame"}]
                elif scene.dependencies:
                    raise RuntimeError("Missing previous frame: refusing discontinuous output for "+scene.id)
                r=await client.post(API+"/videos",headers=self.headers,json=data)
                r.raise_for_status()
                job=r.json().get("id")
                if not job:raise RuntimeError("No job ID; inspect billing before retry")
                jobfile.write_text(json.dumps({"id":job,"model":MODEL}),encoding="utf8")
                print("Submitted",scene.id,job)
            for _ in range(150):
                r=await client.get(API+"/videos/"+job,headers=self.headers)
                r.raise_for_status()
                j=r.json()
                if j.get("status")=="completed":
                    result=await client.get(API+"/videos/"+job+"/content?index=0",headers=self.headers,timeout=180)
                    result.raise_for_status()
                    if len(result.content)<1000:raise RuntimeError("Video empty; inspect existing job before retry")
                    out.write_bytes(result.content)
                    print("Completed",scene.id,"cost",j.get("usage",{}).get("cost","unknown"))
                    return str(out)
                if j.get("status") in ("failed","cancelled","expired"):
                    raise RuntimeError(str(j.get("error") or j["status"]))
                await asyncio.sleep(6)
        raise TimeoutError("Job may still be running: "+job+"; continue with same output directory.")