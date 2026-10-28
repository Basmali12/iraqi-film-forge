"""Local-only validation of a Modal storyboard. Never imports a cloud SDK."""
import argparse,json
from pathlib import Path
def validate(plan):
 slots=plan['slots'];assert 1<=len(slots)<=360
 for i,s in enumerate(slots):
  assert s['index']==i+1 and s['start']==i*10 and s['end']==(i+1)*10
  assert isinstance(s['prompt'],str) and len(s['prompt'])>25
 return len(slots)*10
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('storyboard',type=Path);args=parser.parse_args()
 data=json.loads(args.storyboard.read_text(encoding='utf-8'));print('VALID_DRY_STORYBOARD_SECONDS',validate(data.get('plan',data)))
