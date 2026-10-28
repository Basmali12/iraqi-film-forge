#!/usr/bin/env python3
"""Explicitly approved IP preview activation. No DNS, GitHub, GPU or transfer actions."""
import datetime, hashlib, http.client, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time

ROOT=pathlib.Path('/srv/iraqi-film-forge/current')
LIVE=pathlib.Path('/etc/caddy/Caddyfile')
PLAN=pathlib.Path('/srv/iraqi-film-forge/https-plan')
STATE=PLAN/'activation.json'
ENV=pathlib.Path('/etc/iraqi-film-forge/app.env')
EXPECTED='b52009766399f33902161f8de05fe93c399d2d01579511d53ebd4951d683e231'
IP='167.104.162.4'
SHARED={'reels-storage.service':'2e1cad00ebe19feb8f832b0a8f2b8f3e7435c1700d9835d2e786aeaf22c4c71c','reels-publisher.service':'41f296cba0ce6c465b5062813fdafa7c004f2fb2a5ee1844e0c2d8943b18271d'}

def digest(data):return hashlib.sha256(data).hexdigest()
def run(args,log=None):
    result=subprocess.run(args,text=True,capture_output=True)
    if log:
        log.write_text(result.stdout+result.stderr);os.chmod(log,0o600)
    if result.returncode:raise RuntimeError('COMMAND_FAILED_REVIEW_PRIVATE_LOG_NO_AUTOMATIC_RETRY')
    return result.stdout.strip()
def atomic(path,data,mode=0o600):
    fd,name=tempfile.mkstemp(prefix='.iff-update-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        os.chmod(name,mode);os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)
def save(state):atomic(STATE,json.dumps(state,indent=2).encode())
def backend_probe():
    connection=http.client.HTTPConnection('127.0.0.1',3107,timeout=5)
    connection.request('GET','/');response=connection.getresponse();response.read()
    if response.status!=302 or not response.headers.get('Location','').startswith('/login.html'):raise RuntimeError('PASSWORD_GATE_NOT_ACTIVE')
    connection.request('GET','/api/engine/health');response=connection.getresponse();health=json.loads(response.read());connection.close()
    if response.status!=200 or not health.get('configured'):raise RuntimeError('ADMINISTRATOR_NOT_CONFIGURED')

def bootstrap():
    if STATE.exists():raise RuntimeError('ACTIVATION_STATE_EXISTS_REVIEW_BEFORE_RETRY')
    original=LIVE.read_bytes()
    if digest(original)!=EXPECTED:raise RuntimeError('SHARED_PROXY_CHANGED_REVIEW_REQUIRED')
    admin=run(['runuser','-u','postgres','--','psql','-X','-At','-d','iraqi_film_forge','-c',"SELECT count(*) FROM iff_records WHERE kind='admin' AND id='administrator';"])
    if admin!='1':raise RuntimeError('PROVISION_ADMINISTRATOR_FIRST')
    for name,expected in SHARED.items():
        p=pathlib.Path('/etc/systemd/system')/name
        if not p.is_file() or p.is_symlink() or digest(p.read_bytes())!=expected:raise RuntimeError('SHARED_UNIT_CHANGED_REVIEW_REQUIRED')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=pathlib.Path('/var/backups/iraqi-film-forge-activation')/stamp;backup.mkdir(mode=0o700,parents=True)
    for p,name in [(LIVE,'Caddyfile'),(ENV,'app.env')]:
        shutil.copyfile(p,backup/name);os.chmod(backup/name,0o600)
    state={'phase':'preparing','startedAt':stamp,'backup':str(backup),'baseCaddySHA256':EXPECTED,'sharedUnitContentsChanged':False,'certificateIssued':False,'gpuStarted':False}
    save(state)
    try:
        for name in SHARED:os.chmod(pathlib.Path('/etc/systemd/system')/name,0o644)
        env=ENV.read_text().splitlines();changes={'ENGINE_ORIGIN':'https://'+IP,'ENGINE_ALLOWED_ORIGINS':'https://'+IP,'ENGINE_TRUST_PROXY':'loopback','ENGINE_PREVIEW_PASSWORD_GATE':'YES','ENGINE_ALLOW_PAID_ACTIONS':'NO'}
        rows=[line for line in env if line.split('=',1)[0] not in changes]
        rows += [k+'='+v for k,v in changes.items()]
        atomic(ENV,('\n'.join(rows)+'\n').encode(),0o640);shutil.chown(ENV,user='root',group='iff')
        run(['systemctl','restart','iraqi-film-forge'])
        ready=False
        for _ in range(30):
            try:backend_probe();ready=True;break
            except (OSError,RuntimeError):time.sleep(.2)
        if not ready:raise RuntimeError('PRIVATE_BACKEND_READINESS_FAILED')
        webroot=pathlib.Path('/var/lib/iraqi-film-forge-acme-webroot');(webroot/'.well-known/acme-challenge').mkdir(mode=0o755,parents=True,exist_ok=True)
        (webroot/'.well-known/acme-challenge/iff-preflight').write_text('iraqi-film-forge-acme-ready');os.chmod(webroot/'.well-known/acme-challenge/iff-preflight',0o644)
        candidate=original+b'\n\n'+(ROOT/'deploy/hosthatch/Caddyfile.ip-bootstrap.fragment').read_bytes()
        check=PLAN/'Caddyfile.bootstrap.approved';atomic(check,candidate)
        run(['caddy','validate','--config',str(check),'--adapter','caddyfile'],PLAN/'bootstrap-validation.log')
        atomic(LIVE,candidate,0o644);run(['systemctl','reload','caddy'])
        state.update(phase='bootstrap_ready',bootstrapSHA256=digest(candidate),passwordGateEnabled=True,sharedUnitModes='0644',externalChallengeURL='http://'+IP+'/.well-known/acme-challenge/iff-preflight');save(state)
        print(json.dumps({k:v for k,v in state.items() if k!='backup'}))
    except Exception:
        atomic(LIVE,original,0o644);run(['systemctl','reload','caddy'])
        # Retain the safer shared-unit modes and the new administrator, but restore the old private app config.
        atomic(ENV,(backup/'app.env').read_bytes(),0o640);shutil.chown(ENV,user='root',group='iff');run(['systemctl','restart','iraqi-film-forge'])
        state['phase']='bootstrap_failed_rolled_back';save(state);raise

def issue_and_activate():
    state=json.loads(STATE.read_text())
    if state['phase']!='bootstrap_ready' or digest(LIVE.read_bytes())!=state['bootstrapSHA256']:raise RuntimeError('ACTIVATION_STATE_CHANGED_REVIEW_REQUIRED')
    backend_probe()
    for folder in ['/etc/iraqi-film-forge-acme','/var/lib/iraqi-film-forge-acme-client','/var/log/iraqi-film-forge-acme']:
        pathlib.Path(folder).mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(folder,0o700)
    hook=pathlib.Path('/usr/local/sbin/iraqi-film-forge-install-ip-certificate');shutil.copyfile(ROOT/'deploy/hosthatch/install-ip-certificate.sh',hook);os.chmod(hook,0o700)
    common=['/opt/iff-certbot/bin/certbot','certonly','--non-interactive','--agree-tos','--register-unsafely-without-email','--preferred-profile','shortlived','--webroot','--webroot-path','/var/lib/iraqi-film-forge-acme-webroot','--ip-address',IP,'--cert-name','iff-hosthatch-ip','--config-dir','/etc/iraqi-film-forge-acme','--work-dir','/var/lib/iraqi-film-forge-acme-client','--logs-dir','/var/log/iraqi-film-forge-acme']
    state['phase']='certificate_dry_run';save(state)
    try:
        run(common+['--dry-run'],PLAN/'certificate-dry-run.log')
        state['phase']='certificate_issuance';save(state)
        run(common+['--deploy-hook',str(hook)],PLAN/'certificate-issuance.log')
        state['certificateIssued']=True;save(state)
        original=(pathlib.Path(state['backup'])/'Caddyfile').read_bytes()
        candidate=original+b'\n\n'+(ROOT/'deploy/hosthatch/Caddyfile.ip-https.fragment').read_bytes()
        check=PLAN/'Caddyfile.https.approved';atomic(check,candidate)
        run(['caddy','validate','--config',str(check),'--adapter','caddyfile'],PLAN/'https-validation.log')
        atomic(LIVE,candidate,0o644);run(['systemctl','reload','caddy'])
        for name in ['iraqi-film-forge-cert-renew.service','iraqi-film-forge-cert-renew.timer']:
            target=pathlib.Path('/etc/systemd/system')/name;shutil.copyfile(ROOT/'deploy/hosthatch'/name,target);os.chmod(target,0o644)
        run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','iraqi-film-forge-cert-renew.timer'])
        state.update(phase='https_active',url='https://'+IP,finalCaddySHA256=digest(candidate),paidActions='NO',publicPasswordGate=True,renewalEnabled=True);save(state)
        print(json.dumps({k:v for k,v in state.items() if k!='backup'}))
    except Exception:
        # Keep only the reviewed ACME challenge route on failure, never expose an unprotected application.
        bootstrap=(PLAN/'Caddyfile.bootstrap.approved').read_bytes();atomic(LIVE,bootstrap,0o644);run(['systemctl','reload','caddy'])
        state['phase']='issuance_or_activation_failed_review_required';save(state);raise

def main():
    if os.geteuid()!=0 or socket.gethostname()!='muhtaj-app' or '--approve-public-ip-https' not in sys.argv:raise RuntimeError('EXPLICIT_APPROVAL_AND_CORRECT_HOST_REQUIRED')
    if '--bootstrap-only' in sys.argv:bootstrap()
    elif '--issue-and-activate' in sys.argv:issue_and_activate()
    else:raise RuntimeError('SELECT_EXPLICIT_ACTIVATION_PHASE')

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(str(e) if isinstance(e,RuntimeError) else 'ACTIVATION_FAILED_REVIEW_PRIVATE_STATE_NO_AUTOMATIC_RETRY',file=sys.stderr);sys.exit(1)
