"""Filesystem/output utilities. No GPU/model/cloud side effects on import."""
import json
import subprocess
import uuid
from pathlib import Path
from settings import WIDTH,HEIGHT,MODEL_REVISION,SOURCE_COMMIT


def output_paths():
    folder=Path('/models/results/story-lab')
    folder.mkdir(parents=True,exist_ok=True)
    run_id=uuid.uuid4().hex  # Must run after restore, never captured in a Snapshot.
    return f'/tmp/{run_id}-raw.mp4',folder/f'{run_id}.mp4',folder/f'{run_id}-audit.json'


def finalize(raw,final,duration=9):
    subprocess.run(['ffmpeg','-v','error','-y','-i',str(raw),'-map','0:v:0','-map','0:a:0',
        '-t',str(duration),'-c:v','libx264','-preset','fast','-crf','23','-c:a','aac',
        '-movflags','+faststart',str(final)],check=True,timeout=40)
    metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format',
        '-of','json',str(final)],timeout=10))
    video=next(s for s in metadata['streams'] if s['codec_type']=='video')
    if not any(s['codec_type']=='audio' for s in metadata['streams']):raise RuntimeError('Native audio missing')
    if (video['width'],video['height'])!=(WIDTH,HEIGHT):raise RuntimeError('Resolution changed')
    if abs(float(metadata['format']['duration'])-duration)>.1:raise RuntimeError('Duration changed')
    final.with_suffix('.json').write_text(json.dumps({'duration_seconds':duration,'width':WIDTH,'height':HEIGHT,
        'audio':'native LTX audio encoded as AAC','source_commit':SOURCE_COMMIT,'model_revision':MODEL_REVISION,
        'ffprobe':metadata},indent=2))
    return str(final).removeprefix('/models')


def download_outputs(volume,remote_path,root):
    destination=root/'results'
    destination.mkdir(exist_ok=True)
    paths=[remote_path,remote_path.removesuffix('.mp4')+'.json',remote_path.removesuffix('.mp4')+'-audit.json']
    for remote in paths:
        with (destination/Path(remote).name).open('wb') as stream:
            for chunk in volume.read_file(remote):stream.write(chunk)
    print(f'Saved: {destination/Path(remote_path).name}')
