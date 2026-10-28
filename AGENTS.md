# Codex implementation instructions — Iraqi Film Forge

This repository is an **independent project**. NEVER edit or connect to `mashhad-ad-studio` or any other existing repo.

## Current product requirements
- User authorization 2026-10-28 retires all secondary video-provider integrations. Only OpenAI text planning and Modal LTX-2.5 video/audio are active. Preserve old projects/media read-only; never relabel their jobs or regenerate them automatically.

## Historical requirements (superseded where conflicting)
- User-supplied `OPENROUTER_API_KEY` must never be committed, logged, placed in query params, or exposed to other users.
- Show current real pricing before generation and require an explicit user click to incur charges.
- Preserve Iraqi dialect scripts and chronological cause → effect.
- Scene continuation uses the approved last frame as the next first frame; repeated characters also need pinned reference portraits/voice assets.
- No claim of 100% character identity preservation.
- No autoplay paid rendering. Dry-run plan first; test three scenes before scaling.
- Store job IDs and poll existing jobs on resume to prevent accidental repeated billing.
- Keep dialogue and audio when concatenating via FFmpeg.
- The static GitHub Pages UI is only a frontend; Python Forge workflow and FFmpeg require a trusted separate server.
- Browser CORS limits may require a same-origin authenticated HTTPS API proxy; current Node proxy defaults to localhost for safety.
- Never serve the personal API proxy publicly until identity, HTTPS, rate limiting, budget limits, secret handling and concurrency are implemented.

## Forge Film integration
- Pin upstream MIT repo `https://github.com/F-R-L/forge-film` commit `f67f0a003`.
- Run `bash scripts/vendor_forge.sh` to vendor full source into `vendor/forge-film` and retain MIT LICENSE.
- The repo currently contains the upstream integration scripts but NOT the complete upstream source until this command runs and code is committed.
- `tools/assemble.py`: FFmpeg merge with audio.
- `site/`: public UI mirrored on `gh-pages`; synchronize when editing.

## Before claiming done
- Verify `npm run check`, verify local server health and no unauthenticated API access.
- Run Python syntax checks without paid requests.
- Run a dry storyboard test.
- Verify GitHub Pages public URL actually resolves rather than guessing.
- Never run any video generation request unless the user authorizes its cost.
- Modal management: keep ENGINE_ALLOW_PAID_ACTIONS disabled by default. A deployment, Volume creation, transfer, image build, GPU allocation or generation is not authorized by a local implementation/test request. Tests use isolated fixtures, never real cloud mutations.

## Film continuation and no-loss merging (added 2026-10-26)
- The browser must maintain an ordered `filmClips` array of *original generated video blobs*, and the latest **raw** clip is the source for the next last-frame seed.
- NEVER overwrite the previous successful clip when a continuation succeeds.
- After each continuation, try local FFmpeg.wasm quick stream-copy concatenation. If the user selects a soft transition, attempt 0.20s `xfade` and `acrossfade` for aligned audio/video, but preserve all original segments if merging fails.
- Use IndexedDB for clip blobs, not API keys. Offer user-imported prior MP4 clips to recover older work, and an explicit reset action only after confirmation.
- For server-side final rendering, `tools/assemble.py --transition smooth` uses FFmpeg native filters, retaining Iraqi dialogue.
- Browser WASM is limited on phones and downloads its core from a pinned JSDelivr CDN version. For production or longer films, migrate to a secure authorized backend.
- Video concatenation is not native video continuation; optical flow, identity and voice quality are not guaranteed. Do not hide this distinction.
- Inspect and test both `site/` on `main` and mirrored `gh-pages` assets before deploying.

