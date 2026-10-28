# LTX-2.5 independent quality lab

Prepared locally, then tested by one approved cloud comparison. Not deployed to HostHatch or wired into
the production engine. Existing jobs, successful media, Volumes and receipts
are unchanged. Production still uses the existing optimized Conv VAE engine.

## Approved run result (2026-10-28)

One 10-second DFR + Diffusion VAE run completed on RTX PRO 6000 in
`basm1998ali`: local elapsed 182.89s, official pipeline 134.91s,
Torch peaks allocated 30.45GiB / reserved 33.18GiB, native AAC audio,
720×1280 MP4. CUDA 12.8 / Torch 2.9.1+cu128. Both additional weights
are now prepared in this account only; no repeated base-weight download.
The app is verified stopped with zero tasks/containers. Modal reported
$0.17726838 provisionally on the later read. This is one tested prompt,
not proof for all resolutions/durations or a financial ceiling.

Embedded Arabic text and unrequested table props still occur. Do not
promote the lab as a fix for dialect, speaker assignment or text suppression.
The older Conv run was warm; this DFR CLI run was cold and also changed the
style suffix, so it is not a pure single-variable performance experiment.
See [full comparison report](../../ltx-quality-preparation/DFR-COMPARISON-REPORT.txt).

## Comparison contract

| Profile | Official entry point | Video decoder | Extra files |
| --- | --- | --- | --- |
| baseline | `ltx_pipelines.distilled` | Conv VAE | none |
| diffvae | `ltx_pipelines.distilled` | Diffusion VAE | Diffusion VAE |
| dfr | `ltx_pipelines.dfr_pipeline` | Diffusion VAE | Diffusion VAE + detailing IC-LoRA |

All profiles use the same pinned distilled transformer, Gemma text encoder,
audio VAE, spatial upscaler, prompt, seed, 24fps, CPU offload and fp8-cast.
Initial comparison is 5 seconds / 121 frames, 768×1280 native, center crop
to exact 720×1280. An explicit 10-second / 241-frame option is available.
No prompt enhancer, compile, external speech engine or temporal upscale is
enabled. DFR itself adds its official keyframe/detailing operations: this is
the intentional quality variable, not an identical denoising workload.

The baseline is the **official cold CLI**, not the optimized persistent
production session. Compare the three lab profiles against each other; do
not attribute differences versus an old warm session solely to DFR/VAE.
The existing production Transformer sharing is not changed. DFR retains its
official model/LoRA lifetime handling; the production private-context override
is deliberately not transplanted into a differently weighted detailing stage.

## Offline commands (repository root)

```powershell
.\.venv-engine\Scripts\python.exe -m unittest quality_lab.test_quality_lab -v
.\.venv-engine\Scripts\python.exe -m quality_lab.verify_upstream ../../work/LTX-2-official
.\.venv-engine\Scripts\python.exe -m quality_lab.benchmark_once --profile dfr --prompt-file quality_lab/fixtures/advertisement.txt
```

The last command **only prints a plan**. It does not import Modal/Torch,
inspect a live Volume, build an image or verify that cloud weights exist.
Use `--weights-root PATH` only for a genuinely available local mount: it
checks READY, exact sizes and extra-file SHA256 without downloading anything.

## Additional weights: originally planned, now prepared in basm1998ali

`extra-weights.json` records official repository revisions, sizes and LFS
SHA256 hashes obtained through read-only Hugging Face metadata endpoints.

- Diffusion VAE: 1,472,223,346 bytes.
- Detailing IC-LoRA: 327,322,640 bytes.
- Combined: 1,799,545,986 bytes, about 1.676GiB.

Files must be staged later, under a separately approved preparation operation,
in the existing model-root path specified by the plan. Do not overwrite the
Conv VAE, the old READY.json or existing model files. The lab contains no
downloader and never copies secrets. Native audio VAE is reused.

## Future one-job command — NOT approved or executed by this change

After weights are prepared and pricing/VRAM risks approved separately:

```powershell
.\.venv-engine\Scripts\python.exe -m quality_lab.benchmark_once --profile dfr --prompt-file quality_lab/fixtures/advertisement.txt --workspace husrd2021 --volume modal-ltx25-test-models --output-dir quality-results-dfr-once --approve-one-paid-job
```

This command is an example for a single DFR test, **not approval to run all
profiles**. Each other profile requires its own approval. The selected local
Modal profile must match `--workspace`; no credentials are put into argv.
Paid mode refuses an active/unknown task inventory, mounts the existing Volume
read-only, uses only RTX-PRO-6000, retries=0, max_containers=1,
min_containers=0 and one `.remote()` invocation. It does not deploy an endpoint.
Leaving `app.run` and the scoped cleanup stop the application; cleanup status
is recorded, never assumed. It cannot resume/retry a failed generation.

Execution timeout: 900s; startup timeout: 180s; idle scaledown: 2s.
Local watchdog: 1500s, including image preparation, requests scoped cancellation.
Neither local cancellation nor these values guarantee a billing ceiling.
The existing static image/locked dependencies and source commit are reused;
adding the lab creates a separate cached image layer. First build may still
take time and incur charges. No NATTEN/FlashAttention upgrade is installed.
Official Diffusion VAE fallback is used if its optional optimized backend is
unavailable; CUDA performance and VRAM remain untested.

At rates verified on https://modal.com/pricing on 2026-10-28:
RTX .000842 + CPU 4×.0000131 + RAM 96×.00000222 = $0.00110752/s.
3/5/10 minutes cost about $0.199/$0.332/$0.665 in these resources.
The 1082-second startup+execution+idle window estimate is about $1.198.
These are scenarios, not measured DFR runtime, a quote or a bill cap; image
build, storage, network and other charges are separate. Recorded cost is null
until a real Modal billing report becomes available.

## Measurement and acceptance

The worker invokes the pinned upstream Python CLI `main`, preserving official
DFR scheduling, keyframes, LoRA application, decoding and native audio. Scoped
observers record real component calls (prompt preparation, denoising, video
decode, audio decode, encoding), lazy decode iterator time and Torch VRAM
peaks. Nested spans are not additive; component times include their own
loading/transfer overhead. They are not per-step percentages. Total worker
time includes checks, crop/mux and ffprobe. CUDA timing/observer compatibility
is not yet tested. No fake ETA, invoice or success is produced.

Accept only after MP4 decode, speaker assignment, Iraqi pronunciation, native
audio cleanliness, no embedded text, object identity and chronological action
are reviewed on the same fixture. Better visual detail does not prove better
dialogue, and image-to-video last-frame conditioning is not continuous audio
latent carry. Keep all successful original clips and receipts.

Official references:
- https://github.com/Lightricks/LTX-2/tree/e98f6d927d83c92ef2be6aec76c8440b19306e39
- https://huggingface.co/Lightricks/LTX-2.5
- https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler
- https://docs.ltx.video/open-source-model/usage-guides/prompting-guide

## Rollback

Nothing is enabled in production by this local change. Remove/ignore the
unreferenced `quality_lab` directory to withdraw the comparison. Do not use
`git reset --hard` or broad checkout operations: this repository contains
earlier user-owned uncommitted work. The only production behavior changed
locally is the authored-style rule and exact legacy-suffix replacement for
new requests; existing stored stories/receipts are never migrated.
