#!/usr/bin/env python3
"""Link ignored development dependencies from the installed stack; never edit production."""
import pathlib, os
root=pathlib.Path(__file__).resolve().parent.parent
sdk=pathlib.Path(os.environ.get("PI_SDK_DIR",str(pathlib.Path.home()/".nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent")))
plugins=pathlib.Path(os.environ.get("PI_PACKAGES_DIR",str(pathlib.Path.home()/".pi/agent/npm/node_modules")))
links={"@earendil-works/pi-coding-agent":sdk,"@earendil-works/pi-tui":sdk/"node_modules/@earendil-works/pi-tui","typebox":sdk/"node_modules/typebox","@carderne/sandbox-runtime":plugins/"@carderne/sandbox-runtime","proper-lockfile":plugins/"proper-lockfile"}
for name in ["background-carderne","pi-sandbox-background-bridge"]:
 for dep,target in links.items():
  if not target.exists():raise SystemExit(f"Missing installed dependency: {target}")
  link=root/"work/replacements"/name/"node_modules"/dep
  link.parent.mkdir(parents=True,exist_ok=True)
  if link.is_symlink() or link.exists():continue
  link.symlink_to(target,target_is_directory=True)
print("Development dependency links ready")
