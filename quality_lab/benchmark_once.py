"""Offline by default. One explicit paid approval allows exactly one profile/job."""
import argparse
import json
import os
import sys
import time
from pathlib import Path
from quality_lab.plan import ROOT, RUNTIME, PROFILES, make_plan


def render_remote(plan):
    """Only serialized into the independent paid lab function after approval."""
    import json
    import os
    import subprocess
    import sys
    import tempfile
    import time
    from pathlib import Path
    with tempfile.TemporaryDirectory(prefix='ltx-quality-') as folder:
        root = Path(folder)
        request = {'plan':plan,'raw':str(root/'raw.mp4'),'metrics':str(root/'metrics.json')}
        (root/'request.json').write_text(json.dumps(request))
        env = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                   HF_HUB_DISABLE_TELEMETRY='1', PYTHONPATH='/root')
        start = time.monotonic()
        # Never print a raw exception/log that may contain environment context.
        result = subprocess.run([sys.executable,'-m','quality_lab.worker',str(root/'request.json')],
                                env=env, capture_output=True, timeout=plan['execution_timeout']-30)
        if result.returncode:
            from telemetry import redact
            return {'video':None,'metrics':{'status':'failed','error':'OFFICIAL_QUALITY_PIPELINE_FAILED_NO_RETRY',
                    'error_log':redact(result.stderr.decode('utf-8',errors='replace')[-14000:]),
                    'total_worker_seconds':time.monotonic()-start,'recorded_cost':None}}
        subprocess.run(['ffmpeg','-nostdin','-v','error','-i',request['raw'],
                        '-map','0:v:0','-map','0:a:0','-vf','crop=720:1280',
                        '-c:v','libx264','-crf','18','-preset','fast','-c:a','copy',
                        '-t',str(plan['seconds']),'-movflags','+faststart',str(root/'video.mp4')],
                       check=True,capture_output=True,timeout=25)
        probe = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams',
                                                   '-show_format','-of','json',str(root/'video.mp4')]))
        video = next(s for s in probe['streams'] if s['codec_type']=='video')
        if (video['width'],video['height']) != (720,1280) or not any(s['codec_type']=='audio' for s in probe['streams']):
            raise RuntimeError('OUTPUT_VALIDATION_FAILED')
        if abs(float(probe['format']['duration'])-plan['seconds']) > .15:
            raise RuntimeError('OUTPUT_DURATION_MISMATCH')
        metrics = json.loads(Path(request['metrics']).read_text())
        metrics.update(total_worker_seconds=time.monotonic()-start, ffprobe=probe,
                       profile=plan['profile'],source_commit=plan['source_commit'],
                       model_revision=plan['model_revision'],prompt_sha256=plan['prompt_sha256'])
        return {'video':(root/'video.mp4').read_bytes(),'metrics':metrics}


def run_paid(plan, args):
    if not args.approve_one_paid_job or not args.workspace or not args.volume:
        raise ValueError('Explicit one-job approval, workspace and existing Volume required')
    # No cloud/image imports or credential checks on the dry-run path.
    sys.path[:0] = [str(RUNTIME),str(ROOT.parent/'engine')]
    from modal_bridge import client, sync_metadata
    credentials = {'mode':'local_profile','expectedWorkspace':args.workspace}
    c, _ = client(credentials)
    existing = sync_metadata(credentials)
    if existing.get('runningTasks') != 0 or any(a.get('containers',0) for a in existing.get('apps',[])):
        raise RuntimeError('ACTIVE_OR_UNKNOWN_CLOUD_TASKS_BLOCK_NEW_COMPARISON')
    os.environ['LTX25_BENCHMARK_APPROVED'] = 'YES'
    import modal
    from benchmark_image import make_image
    import uuid
    import threading
    job = str(uuid.uuid4())
    app = modal.App('iff-engine-'+job)
    image = make_image().add_local_dir(ROOT,remote_path='/root/quality_lab',copy=True,
                                      ignore=['**/__pycache__/**','**/*.pyc'])
    volume = modal.Volume.from_name(args.volume,create_if_missing=False,client=c,
                                   environment_name='main').with_mount_options(read_only=True)
    remote = app.function(image=image,gpu='RTX-PRO-6000',cpu=(4,4),memory=(98304,98304),
        timeout=plan['execution_timeout'],startup_timeout=plan['startup_timeout'],
        retries=0,max_containers=1,min_containers=0,buffer_containers=0,scaledown_window=2,
        volumes={'/models':volume})(render_remote)
    target = Path(args.output_dir)
    target.mkdir(parents=True,exist_ok=False)  # Never overwrite an earlier result.
    receipt = {'job_id':job,'plan':plan,'status':'starting','cloud_stopped':False}
    def save():
        temp = target/'receipt.tmp'
        temp.write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
        temp.replace(target/'receipt.json')
    save()
    done = threading.Event()
    def guard():
        if not done.wait(plan['local_timeout']) and app.app_id:
            try: sync_metadata(credentials,app.app_id,job,True)
            except Exception: pass  # Main finally reconciles; never retry generation.
    threading.Thread(target=guard,daemon=True).start()
    started = time.time()
    try:
        with modal.enable_output(),app.run(client=c):
            receipt.update(app_id=app.app_id,status='running')
            save()
            result = remote.remote(plan)  # The only GPU invocation in this program.
            if result['video'] is not None:
                (target/'video.mp4').write_bytes(result['video'])
            receipt.update(status='completed' if result['video'] is not None else 'failed_no_retry',metrics=result['metrics'])
    except BaseException:
        receipt['status']='failed_or_uncertain_no_retry'
        raise
    finally:
        done.set()
        receipt['elapsed_seconds']=time.time()-started
        if app.app_id:
            try:
                cleanup=sync_metadata(credentials,app.app_id,job,True,started_at=started)
                receipt.update(cleanup=cleanup,cloud_stopped=cleanup['cloud_stopped'])
            except Exception:
                receipt['cleanup_error']='CLOUD_STATE_UNKNOWN_CHECK_EXISTING_APP_NO_NEW_JOB'
        save()
    print(json.dumps({'status':receipt['status'],'cloud_stopped':receipt['cloud_stopped'],
                      'receipt':str(target/'receipt.json')},ensure_ascii=False))


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile',choices=tuple(PROFILES),default='dfr')
    parser.add_argument('--prompt-file',type=Path,required=True)
    parser.add_argument('--seconds',type=int,choices=(5,10),default=5)
    parser.add_argument('--seed',type=int,default=42)
    parser.add_argument('--weights-root',type=Path)
    parser.add_argument('--approve-one-paid-job',action='store_true')
    parser.add_argument('--workspace')
    parser.add_argument('--volume')
    parser.add_argument('--output-dir',default='quality-results')
    args=parser.parse_args(argv)
    plan=make_plan(args.profile,args.prompt_file.read_text(encoding='utf-8'),args.seconds,args.seed)
    if args.weights_root:
        from quality_lab.plan import check_files
        plan['local_files_verified']=check_files(plan,args.weights_root)
    if not args.approve_one_paid_job:
        print(json.dumps({'mode':'offline-plan-only','cloud_checked':False,'plan':plan},ensure_ascii=False,indent=2))
        return
    print(plan['warning'],file=sys.stderr)
    run_paid(plan,args)


if __name__=='__main__':
    main()
