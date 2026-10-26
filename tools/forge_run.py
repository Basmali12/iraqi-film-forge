#!/usr/bin/env python3
"""Run storyboard scenes sequentially through Forge Film and OpenRouter HeyGen.
No paid jobs are submitted unless --confirm-paid and --max-budget-usd provided.
"""
import argparse,asyncio,json,subprocess,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
VENDOR=ROOT/"vendor"/"forge-film"
if not (VENDOR/"forge"/"scheduler"/"scheduler.py").exists():
 sys.exit("Vendor Forge Film first: bash scripts/vendor_forge.sh")
sys.path.insert(0,str(VENDOR))
sys.path.insert(0,str(ROOT))
from forge.compiler.schema import Scene,ProductionPlan
from forge.scheduler.scheduler import ForgeScheduler
from forge_bridge.openrouter_heygen import OpenRouterHeyGenPipeline

def load_storyboard(file):
 data=json.loads(file.read_text(encoding="utf8"))
 shots=data.get("scenes",[])
 if not isinstance(shots,list) or not 1<=len(shots)<=100:raise ValueError("Need 1-100 scenes")
 scenes=[];dag={}
 for i,shot in enumerate(shots):
  prompt=shot.get("prompt","")
  if not isinstance(prompt,str) or not 5<=len(prompt)<=7000:raise ValueError("Bad prompt at scene "+str(i+1))
  name="S"+str(i+1).zfill(3)
  dep=["S"+str(i).zfill(3)] if i else []
  scenes.append(Scene(id=name,description=prompt,complexity=3,scene_type="dialogue",dependencies=dep,estimated_duration_sec=float(shot.get("duration",15))))
  dag[name]=["S"+str(i+2).zfill(3)] if i<len(shots)-1 else []
 return ProductionPlan(title=data.get("name","Iraqi Film"),scenes=scenes,assets=[],dag=dag)

async def run(args):
 plan=load_storyboard(args.storyboard)
 duration=int(plan.scenes[0].estimated_duration_sec)
 if duration not in (5,8,10,15):raise ValueError("Supported duration: 5,8,10,15 seconds")
 if any(int(s.estimated_duration_sec)!=duration for s in plan.scenes):raise ValueError("All chained scenes must have the same duration")
 estimate=len(plan.scenes)*duration*{"480p":.01,"768p":.018}[args.resolution]
 print("Storyboard:",len(plan.scenes),"scenes,",len(plan.scenes)*duration,"seconds, estimated cost $"+str(round(estimate,2)))
 if not args.confirm_paid:
  print("DRY RUN: no money spent. To generate use --confirm-paid --max-budget-usd N")
  return
 if args.max_budget_usd is None or estimate>args.max_budget_usd:raise ValueError("Explicit budget approval required")
 pipeline=OpenRouterHeyGenPipeline(duration=duration,resolution=args.resolution,aspect_ratio=args.aspect_ratio)
 async def generate(scene,assets,prev_frame=None):return await pipeline.generate(scene,assets,str(args.output),prev_frame)
 scheduler=ForgeScheduler(plan,generate,num_workers=1,max_retries=0)
 results,fail=await scheduler.run({},output_dir=str(args.output))
 if fail or len(results)!=len(plan.scenes):
  sys.exit("Scenes failed: "+str(fail)+"; use same output dir to recover without duplicate charges")
 ordered=[results[s.id] for s in plan.scenes]
 output=args.output/"final_film.mp4"
 subprocess.run([sys.executable,str(ROOT/"tools"/"assemble.py"),*ordered,"--output",str(output)],check=True)
 print("Complete:",output)

if __name__=="__main__":
 p=argparse.ArgumentParser()
 p.add_argument("storyboard",type=Path)
 p.add_argument("--output",type=Path,default=ROOT/"output")
 p.add_argument("--resolution",choices=["480p","768p"],default="480p")
 p.add_argument("--aspect-ratio",choices=["9:16","16:9","1:1"],default="9:16")
 p.add_argument("--confirm-paid",action="store_true")
 p.add_argument("--max-budget-usd",type=float,default=None)
 asyncio.run(run(p.parse_args()))