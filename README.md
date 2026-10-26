# Iraqi Film Forge — ستوديو الأفلام العراقي

Independent project for cinematic Iraqi-language video production. **Not connected to Mashhad**.

## Project goals
- OpenRouter BYOK frontend; API key must never be committed.
- **Video model locked to** `heygen/heygen-video-1`.
- Text chat for writing storyboards using a separate low-cost text model.
- Manual paid-generation confirmation; 5–15-second scenes.
- Save final frames to seed subsequent clips (image-to-video). Face continuity is **not guaranteed**.
- `F-R-L/forge-film` (MIT) serves as orchestration foundation for story DAG, scene scheduling and continuity.
- FFmpeg merge retains audio and dialogue.

## Deploy
Frontend files are published separately on the `gh-pages` branch. For the first deployment open **Settings → Pages → Deploy from a branch → gh-pages → / (root) → Save**.

Expected page: https://basmali12.github.io/iraqi-film-forge/

GitHub Pages is static hosting; automatic server-side Forge/FFmpeg workflows require Node/Python deployment on an authorized server. Users enter their own OpenRouter key only into the trusted live app; the key is not included in the repo.

## Upstream acknowledgments
Forge Film © respective upstream authors. MIT: https://github.com/F-R-L/forge-film — retain the MIT copyright and license with any vendored copy.

## Local full source package
The original self-contained project package includes Node server, browser frontend, Forge adapter and assemble tools. The repo deployment will be enhanced with these files; do not claim them to be present until pushed and verified.

See: https://github.com/Basmali12/iraqi-film-forge
