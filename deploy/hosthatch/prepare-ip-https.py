#!/usr/bin/env python3
"""Offline configuration checks ONLY. Never reloads Caddy or contacts ACME."""
import hashlib, json, os, pathlib, socket, subprocess, sys, tempfile

IP='167.104.162.4'
LIVE=pathlib.Path('/etc/caddy/Caddyfile')
OUT=pathlib.Path('/srv/iraqi-film-forge/https-plan')
CERT_ROOT='/var/lib/caddy/iff-ip-tls/current'

def run(args):
    r=subprocess.run(args,text=True,capture_output=True)
    if r.returncode:raise RuntimeError('OFFLINE_CHECK_FAILED_NO_CONFIG_OR_SECRET_OUTPUT')
    return r.stdout

def host_matches(tree):
    result=[]
    if isinstance(tree,dict):
        if isinstance(tree.get('host'),list):result+=tree['host']
        for v in tree.values():result+=host_matches(v)
    elif isinstance(tree,list):
        for v in tree:result+=host_matches(v)
    return result

def write_private(path,text):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:f.write(text)
    os.chmod(path,0o600)

def main():
    if os.geteuid()!=0 or socket.gethostname()!='muhtaj-app':raise RuntimeError('WRONG_HOST_OR_NOT_ROOT')
    original=LIVE.read_bytes();digest=hashlib.sha256(original).hexdigest()
    current=json.loads(run(['caddy','adapt','--config',str(LIVE)]))
    if IP in host_matches(current):raise RuntimeError('EXISTING_IP_ROUTE_REQUIRES_REVIEW')
    OUT.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(OUT,0o700)
    source=pathlib.Path(__file__).resolve().parent
    candidates={}
    for name in ['bootstrap','https']:
        fragment=(source/('Caddyfile.ip-'+name+'.fragment')).read_text()
        candidate=original.decode()+'\n\n'+fragment
        path=OUT/('Caddyfile.'+name+'.candidate');write_private(path,candidate)
        candidates[name]=path
        run(['caddy','adapt','--config',str(path),'--adapter','caddyfile'])
    # A test-only self-signed certificate proves parsing/file loading offline.
    # It is destroyed below and is NEVER installed/served or trusted in a browser.
    with tempfile.TemporaryDirectory(prefix='iff-ip-tls-offline-') as tmp:
        folder=pathlib.Path(tmp)
        run(['openssl','req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',str(folder/'privkey.pem'),'-out',str(folder/'fullchain.pem'),'-days','1','-subj','/CN=offline-validation-only','-addext','subjectAltName=IP:'+IP])
        candidate=candidates['https'].read_text().replace(CERT_ROOT,str(folder))
        check=folder/'Caddyfile';write_private(check,candidate)
        run(['caddy','validate','--config',str(check),'--adapter','caddyfile'])
    if LIVE.read_bytes()!=original:raise RuntimeError('LIVE_CONFIGURATION_CHANGED_DURING_REVIEW')
    summary={'host':socket.gethostname(),'ip':IP,'liveConfigSHA256':digest,'existingHostMatches':sorted(set(host_matches(current))),'bootstrapAdapt':'pass','finalAdapt':'pass','finalOfflineValidate':'pass','certificateIssued':False,'publicRouteActivated':False,'caddyReloaded':False,'dnsChanged':False,'testCertificateDestroyed':True,'applicationOriginAfterApproval':'https://'+IP,'paidActionsAfterApproval':'NO','legacyProxyPubliclyAllowed':False,'requiresOwnerApprovalBeforeActivation':True}
    write_private(OUT/'review.json',json.dumps(summary,indent=2))
    print(json.dumps(summary))

if __name__=='__main__':
    try:main()
    except RuntimeError as e:print(str(e),file=sys.stderr);sys.exit(1)
