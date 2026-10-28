# Current Pages access — 2026-10-28

The GitHub Pages entry points now open the actual authenticated HostHatch application at https://167.104.162.4/film.html. Pages does not host the backend, PostgreSQL or GPU runtime. The browser performs provider calls only on the HostHatch origin; there is no cross-site credential forwarding or API proxy in this launcher.

The launcher never reads old browser credentials/storage, starts a GPU, or invokes paid services. Only a validated project identifier is preserved. Other query parameters and fragments are dropped. Existing static assets and historical Git revisions are retained; no user data is migrated or deleted. The source development branch and the live-vs-local DFR distinction remain separate from this Pages access update.

---

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
