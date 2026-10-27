"""Pure filesystem validation shared by preparation and inference; no downloads."""
import json
from pathlib import Path

from settings import MANIFEST, MODEL_DIR, MODEL_FILES, MODEL_REVISION


def check_weights() -> dict:
    root = Path(MODEL_DIR)
    marker = root / "READY.json"
    if not marker.is_file():
        raise RuntimeError("No complete model snapshot. Run an approved --prepare-only stage first.")
    saved = json.loads(marker.read_text())
    if saved.get("revision") != MODEL_REVISION:
        raise RuntimeError("Unexpected model revision; prepare the pinned revision first")
    for filename, info in MANIFEST["files"].items():
        path = root / filename
        if not path.is_file() or path.stat().st_size != info["size"]:
            raise RuntimeError(f"Missing or incomplete weight: {filename}")
    return {"revision": MODEL_REVISION, "files": len(MODEL_FILES)}
