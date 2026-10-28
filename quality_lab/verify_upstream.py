"""Read-only AST/commit contract check, without importing CUDA dependencies."""
import ast
import subprocess
from pathlib import Path
from quality_lab.plan import BASE, PROFILES, official_command, make_plan


def verify(source):
    source=Path(source)
    commit=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    if commit!=BASE['source_commit']:
        raise ValueError('Upstream commit mismatch')
    package=source/'packages/ltx-pipelines/src/ltx_pipelines'
    trees={name:ast.parse((package/name).read_text(encoding='utf-8'))
           for name in ['distilled.py','dfr_pipeline.py','utils/args.py','utils/model_paths.py']}
    flags={n.value for tree in trees.values() for n in ast.walk(tree)
           if isinstance(n,ast.Constant) and isinstance(n.value,str) and n.value.startswith('--')}
    for profile in PROFILES:
        plan=make_plan(profile,'A simple scene.')
        for arg in official_command(plan,'/tmp/output.mp4'):
            if arg.startswith('--') and arg not in flags:
                raise ValueError('Unsupported official flag: '+arg)
    for module in ['distilled.py','dfr_pipeline.py']:
        if not any(isinstance(n,ast.FunctionDef) and n.name=='main' for n in trees[module].body):
            raise ValueError('Missing official main entry point')
    return {'source_commit':commit,'official_cli_contract':'passed',
            'runtime_cuda_tested':False,'weights_downloaded':False}


if __name__=='__main__':
    import argparse,json
    parser=argparse.ArgumentParser()
    parser.add_argument('source',type=Path)
    print(json.dumps(verify(parser.parse_args().source),indent=2))
