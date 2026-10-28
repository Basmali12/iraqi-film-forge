"""CPU text detection + bounded local inpainting. Never imports a GPU/LLM SDK."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

MODEL_SHA='f42c0fbd294d95eac1a550e131b277dac97462c8025fa4b6c3cec1b7894bd3d5'
SMALL_SHA='090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f'
LAMA_SHA='7df918ac3921d3daf0aae1d219776cf0dc4e4935f035af81841b40adcf74fdf2'
VERSION='rapidocr-multiscale-opencv-lama-cpu-v2'


def model_path(small=False):
    spec=importlib.util.find_spec('rapidocr')
    if not spec:raise RuntimeError('TEXT_DETECTOR_NOT_INSTALLED')
    path=Path(spec.origin).parent/'models/PP-OCRv6_det_small.onnx' if small else Path(os.environ.get('ENGINE_TEXT_DETECTOR_MODEL',Path(__file__).resolve().parents[1]/'.text-models/PP-OCRv6_det_tiny.onnx'))
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=(SMALL_SHA if small else MODEL_SHA):
        raise RuntimeError('TEXT_DETECTOR_HASH_MISMATCH')
    return path


def detector(small=False):
    os.environ['CUDA_VISIBLE_DEVICES']='';os.environ['NVIDIA_VISIBLE_DEVICES']='void'
    from rapidocr import RapidOCR
    return RapidOCR(params={'Global.use_cls':False,'Global.use_rec':False,'Global.log_level':'error',
        'Det.model_path':str(model_path(small)),'Det.limit_side_len':960,'Det.limit_type':'max',
        'Det.box_thresh':0.35,'Det.thresh':0.25,'Det.unclip_ratio':1.6,
        'EngineConfig.onnxruntime.use_cuda':False,'EngineConfig.onnxruntime.use_dml':False,
        'EngineConfig.onnxruntime.intra_op_num_threads':2,'EngineConfig.onnxruntime.inter_op_num_threads':1})


def lama_path():
    p=Path(os.environ.get('ENGINE_TEXT_INPAINT_MODEL',Path(__file__).resolve().parents[1]/'.text-models/inpainting_lama_2025jan.onnx'))
    if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=LAMA_SHA:raise RuntimeError('TEXT_INPAINT_MODEL_MISSING_OR_INVALID')
    return p


def word_box(box):
    # Isolated 11px clothing buttons were repeatedly false positives in the
    # real fixture. Retain uncertain tiny marks in telemetry, not inpainting.
    import numpy as np
    points=np.asarray(box);edges=points.max(axis=0)-points.min(axis=0)
    return bool(max(edges)>=24 and edges[0]*edges[1]>=300 and edges[0]>=edges[1]*.9)


def scan(source,engine,phase):
    import cv2
    import numpy as np
    cap=cv2.VideoCapture(str(source));fps=cap.get(cv2.CAP_PROP_FPS)
    w,h=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if not cap.isOpened() or not 0<fps<=60 or not 0<w<=4096 or not 0<h<=4096:raise RuntimeError('INVALID_TEXT_QC_VIDEO')
    frames=[];expected=int(cap.get(cv2.CAP_PROP_FRAME_COUNT));ambiguous=0
    detailed=detector(small=True);tracked=[];previous=None
    try:
        while True:
            ok,frame=cap.read()
            if not ok:break
            gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
            if previous is not None and tracked:
                kept=[]
                for polygon in tracked:
                    points=np.asarray(polygon,dtype=np.float32).reshape(-1,1,2)
                    moved,valid,error=cv2.calcOpticalFlowPyrLK(previous,gray,points,None)
                    if moved is not None and valid.all() and float(error.mean())<25:kept.append(moved.reshape(-1,2).tolist())
                tracked=kept
            if previous is None or len(frames)%max(1,round(fps))==0 or (previous is not None and float(cv2.absdiff(previous,gray).mean())>30):
                tracked=[]
                # High-detail tile checks catch stylized background signs missed
                # at the full-frame detector scale. Optical flow follows those
                # signs between checks rather than freezing their coordinates.
                for row in range(3):
                    for col in range(3):
                        x0=max(0,col*w//3-24);x1=min(w,(col+1)*w//3+24)
                        y0=max(0,row*h//3-24);y1=min(h,(row+1)*h//3+24)
                        tile=cv2.resize(frame[y0:y1,x0:x1],None,fx=2,fy=2)
                        found=detailed(tile,use_cls=False,use_rec=False,box_thresh=.55)
                        if found.boxes is None:continue
                        for polygon in found.boxes:
                            p=polygon/2+np.array([x0,y0])
                            if p[:,1].mean()<h*.65 and word_box(p):tracked.append(p.tolist())
            result=engine(frame,use_cls=False,use_rec=False)
            all_boxes=result.boxes.tolist() if result.boxes is not None else []
            ambiguous+=sum(not word_box(b) for b in all_boxes)
            boxes=[b for b in all_boxes if word_box(b)]+tracked
            frames.append(boxes)
            previous=gray
            if len(frames)%24==0:print(json.dumps({'phase':phase,'frames':len(frames),'total':expected}),flush=True)
            if len(frames)>1800:raise RuntimeError('TEXT_QC_DURATION_LIMIT')
    finally:cap.release()
    if not frames or abs(len(frames)-expected)>1:raise RuntimeError('VIDEO_DECODE_INCOMPLETE')
    return {'frames':frames,'fps':fps,'width':w,'height':h,
            'text_frames':sum(bool(b) for b in frames),'box_count':sum(len(b) for b in frames),'ambiguous_small_marks':ambiguous}


def audio_hash(ffmpeg,path):
    return subprocess.check_output([ffmpeg,'-nostdin','-v','error','-i',str(path),'-map','0:a:0',
                                   '-c','copy','-f','hash','-hash','sha256','-'],timeout=30).decode().strip()


def repair(source,destination,info,ffmpeg):
    import cv2
    import numpy as np
    cap=cv2.VideoCapture(str(source));w,h=info['width'],info['height'];fps=info['fps']
    command=[ffmpeg,'-nostdin','-v','error','-y','-f','rawvideo','-pixel_format','bgr24',
             '-video_size',f'{w}x{h}','-framerate',str(fps),'-i','pipe:0','-i',str(source),
             '-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','18',
             '-c:a','copy','-movflags','+faststart',str(destination)]
    maximum=0.0
    net=cv2.dnn.readNetFromONNX(str(lama_path()))
    net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV);net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
    cv2.setNumThreads(4)
    with tempfile.TemporaryFile() as errors:
        process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=errors)
        try:
            for i in range(len(info['frames'])):
                ok,frame=cap.read()
                if not ok:raise RuntimeError('VIDEO_DECODE_INCOMPLETE')
                mask=np.zeros((h,w),np.uint8)
                # Short temporal union reduces mask popping without copying pixels
                # from a different moment or extending one caption across a scene.
                for boxes in info['frames'][max(0,i-2):min(len(info['frames']),i+3)]:
                    for box in boxes:
                        polygon=np.rint(box).astype(np.int32)
                        cv2.fillPoly(mask,[polygon],255)
                mask=cv2.dilate(mask,np.ones((7,7),np.uint8))
                ratio=float(np.count_nonzero(mask))/(w*h);maximum=max(maximum,ratio)
                if ratio>.08:raise RuntimeError('TEXT_MASK_TOO_LARGE_REVIEW_REQUIRED')
                if ratio:
                    # Official OpenCV Zoo LaMa preprocessing, on local CPU.
                    # Process contextual ROIs and composite only the detected
                    # mask, preserving geometry and avoiding spatial smear.
                    groups=cv2.dilate(mask,np.ones((35,35),np.uint8))
                    contours,_=cv2.findContours(groups,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
                    for contour in contours:
                        x,y,rw,rh=cv2.boundingRect(contour);pad=64
                        x0=max(0,x-pad);y0=max(0,y-pad);x1=min(w,x+rw+pad);y1=min(h,y+rh+pad)
                        roi=frame[y0:y1,x0:x1];roi_mask=mask[y0:y1,x0:x1]
                        net.setInput(cv2.dnn.blobFromImage(roi,.00392,(512,512),(0,0,0),False,False),'image')
                        net.setInput((cv2.dnn.blobFromImage(roi_mask,1.0,(512,512))>0).astype(np.float32),'mask')
                        restored=net.forward()[0].transpose(1,2,0).clip(0,255).astype(np.uint8)
                        restored=cv2.resize(restored,(x1-x0,y1-y0))
                        roi[roi_mask>0]=restored[roi_mask>0]
                process.stdin.write(frame.tobytes())
                if (i+1)%24==0:print(json.dumps({'phase':'text_repair','frames':i+1,'total':len(info['frames'])}),flush=True)
            process.stdin.close()
            if process.wait(timeout=60):raise RuntimeError('TEXT_REPAIR_ENCODING_FAILED')
        except BaseException:
            process.kill();process.wait();raise
        finally:cap.release()
    return maximum


def process_video(source,output,report,scan_only=False,repair_text=False):
    source=Path(source).resolve();output=Path(output).resolve();report=Path(report).resolve()
    if source==output or output.exists():raise RuntimeError('ORIGINAL_OR_PRIOR_OUTPUT_MUST_NOT_BE_OVERWRITTEN')
    if source.stat().st_size>160*1024**2:raise RuntimeError('TEXT_QC_FILE_LIMIT')
    import imageio_ffmpeg
    ffmpeg=imageio_ffmpeg.get_ffmpeg_exe();engine=detector();start=time.monotonic()
    original_sha=hashlib.sha256(source.read_bytes()).hexdigest()
    before=scan(source,engine,'text_detection');native_audio_hash=audio_hash(ffmpeg,source)
    summary={'version':VERSION,'gpu_used':False,'source_sha256':original_sha,
             'frames_scanned':len(before['frames']),'text_frames_before':before['text_frames'],
             'boxes_before':before['box_count'],'status':'detected' if before['box_count'] else 'passed',
             'detector_limit':'Detector-based checks cannot prove absence of every possible glyph.',
             'method':'multiscale CPU text detection; experimental repair only when explicitly requested',
             'ambiguous_small_marks_before':before['ambiguous_small_marks']}
    output.parent.mkdir(parents=True,exist_ok=True)
    if scan_only:
        summary.update(seconds=time.monotonic()-start);report.write_text(json.dumps(summary,indent=2));return summary
    if before['box_count'] and not repair_text:
        summary.update(status='needs_review',source_preserved=True,
                       native_audio_bitstream_unchanged=True,repair_enabled=False,
                       seconds=time.monotonic()-start)
        report.write_text(json.dumps(summary,indent=2),encoding='utf-8')
        print(json.dumps(summary),flush=True)
        return summary
    with tempfile.TemporaryDirectory(prefix='text-repair-',dir=output.parent) as temp:
        current=source;info=before;max_ratio=0.0
        for attempt in range(2):
            if not info['box_count']:break
            target=Path(temp)/f'pass-{attempt}.mp4'
            max_ratio=max(max_ratio,repair(current,target,info,ffmpeg))
            current=target;info=scan(current,engine,'text_verification')
        if original_sha!=hashlib.sha256(source.read_bytes()).hexdigest():raise RuntimeError('ORIGINAL_CHANGED')
        if audio_hash(ffmpeg,current)!=native_audio_hash:raise RuntimeError('NATIVE_AUDIO_BITSTREAM_CHANGED')
        summary.update(status='passed' if not info['box_count'] else 'needs_review',
                       text_frames_after=info['text_frames'],boxes_after=info['box_count'],
                       maximum_mask_fraction=max_ratio,native_audio_bitstream_unchanged=True,
                       source_preserved=True,width=info['width'],height=info['height'],fps=info['fps'],
                       seconds=time.monotonic()-start)
        summary['residual_regions']=[{'frame':i,'boxes':boxes} for i,boxes in enumerate(info['frames']) if boxes]
        import shutil
        shutil.copyfile(current,output)
        summary['output_sha256']=hashlib.sha256(output.read_bytes()).hexdigest()
    report.write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps(summary),flush=True)
    return summary


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--capability',action='store_true');parser.add_argument('--source',type=Path)
    parser.add_argument('--output',type=Path);parser.add_argument('--report',type=Path)
    parser.add_argument('--scan-only',action='store_true')
    parser.add_argument('--repair-text',action='store_true',help='Experimental CPU repair; never enabled by the production API')
    args=parser.parse_args()
    if args.capability:
        import cv2,onnxruntime,imageio_ffmpeg
        model_path();model_path(small=True)
        if args.repair_text:lama_path()
        print(json.dumps({'ready':True,'version':VERSION,'gpu':False,'repairEnabled':args.repair_text}));return
    if not all([args.source,args.output,args.report]):parser.error('source, output and report required')
    process_video(args.source,args.output,args.report,args.scan_only,args.repair_text)


if __name__=='__main__':main()
