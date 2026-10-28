#!/usr/bin/env python3
"""Fail closed if the service or another ordinary user can replace application code."""
import os, pathlib, stat, sys

ROOT=pathlib.Path('/srv/iraqi-film-forge/current')

def verify_file(path):
    info=path.lstat()
    if stat.S_ISLNK(info.st_mode):raise RuntimeError('APP_SOURCE_SYMLINK_REQUIRES_REVIEW')
    if info.st_uid!=0 or stat.S_IMODE(info.st_mode)&0o022:raise RuntimeError('APP_SOURCE_NOT_ROOT_READONLY')
    if os.geteuid()!=0 and os.access(path,os.W_OK):raise RuntimeError('APP_SERVICE_CAN_MODIFY_SOURCE')

def main():
    if pathlib.Path(__file__).resolve().parents[2]!=ROOT:raise RuntimeError('WRONG_SOURCE_PATH')
    for parent in [pathlib.Path('/srv'),ROOT.parent,ROOT]:verify_file(parent)
    for item in ['server.mjs','package.json','package-lock.json','engine','site','deploy/hosthatch']:
        base=ROOT/item;verify_file(base)
        if base.is_dir():
            for folder,dirs,files in os.walk(base,followlinks=False):
                for name in dirs+files:verify_file(pathlib.Path(folder)/name)
    # Check runtime dependency trees as well, without traversing symlinks outside them.
    for name in ['node_modules','.venv-engine']:
        base=ROOT/name;verify_file(base)
        for folder,dirs,files in os.walk(base,followlinks=False):
            for name in dirs+files:
                target=pathlib.Path(folder)/name
                if target.is_symlink():
                    if name in dirs:dirs.remove(name)
                    # Executable shims can legitimately target the system interpreter.
                    # The containing directory is still root-owned and non-writable.
                    continue
                verify_file(target)
    print('APP_SOURCE_READONLY_VERIFIED')

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(str(e) if isinstance(e,RuntimeError) else 'SOURCE_PERMISSION_CHECK_FAILED',file=sys.stderr);sys.exit(1)
