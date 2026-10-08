#!/usr/bin/env python3
import pathlib, json, hashlib
root=pathlib.Path(__file__).resolve().parent.parent
entries=json.loads((root/"locks/maintained-source-sha256.json").read_text())
wrong=[p for p,h in entries.items() if not (root/p).is_file() or hashlib.sha256((root/p).read_bytes()).hexdigest()!=h]
if wrong:raise SystemExit("Source integrity mismatch: "+", ".join(wrong))
print(f"Maintained source integrity: {len(entries)} files match")
