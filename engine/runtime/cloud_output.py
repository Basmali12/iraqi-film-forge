"""Filesystem/output utilities. No GPU/model/cloud side effects on import."""
import json
import subprocess
import uuid
from pathlib import Path
import settings as cfg
from settings import MODEL_REVISION,SOURCE_COMMIT


def output_paths():
    folder=Path('/models/results/story-lab')
    folder.mkdir(parents=True,exist_ok=True)
    run_id=uuid.uuid4().hex  # Must run after restore, never captured in a Snapshot.
    return f'/tmp/{run_id}-raw.mp4',folder/f'{run_id}.mp4',folder/f'{run_id}-audit.json'


def finalize(raw,final,duration=9,*,width=None,height=None,output_width=None,output_height=None):
    # Warm sessions may change orientation after this module was imported.
    width=cfg.WIDTH if width is None else width
    height=cfg.HEIGHT if height is None else height
    native_width,native_height=width,height
    filters=[]
    if output_width is not None or output_height is not None:
        if not all(isinstance(v,int) and v>0 and v%2==0 for v in (output_width,output_height)) or output_width>width or output_height>height:raise RuntimeError('Invalid output crop')
        filters=['-vf',f'crop={output_width}:{output_height}:(iw-ow)/2:(ih-oh)/2']
        width,height=output_width,output_height
    subprocess.run(['ffmpeg','-v','error','-y','-i',str(raw),'-map','0:v:0','-map','0:a:0',*filters,
        '-t',str(duration),'-c:v','libx264','-preset','fast','-crf','18','-c:a','copy',
        '-movflags','+faststart',str(final)],check=True,timeout=40)
    metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format',
        '-of','json',str(final)],timeout=10))
    video=next(s for s in metadata['streams'] if s['codec_type']=='video')
    if not any(s['codec_type']=='audio' for s in metadata['streams']):raise RuntimeError('Native audio missing')
    if (video['width'],video['height'])!=(width,height):raise RuntimeError('Resolution changed')
    if abs(float(metadata['format']['duration'])-duration)>.1:raise RuntimeError('Duration changed')
    final.with_suffix('.json').write_text(json.dumps({'duration_seconds':duration,'width':width,'height':height,
        'native_width':native_width,'native_height':native_height,'center_cropped':bool(filters),
        'audio':'native LTX AAC stream copied without re-encoding','source_commit':SOURCE_COMMIT,'model_revision':MODEL_REVISION,
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
