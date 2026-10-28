"""Real Caddy/Node on loopback only, with a disposable test CA. No ACME/Modal calls."""
import base64, http.client, json, os, pathlib, shutil, socket, ssl
import subprocess, tempfile, time, unittest, urllib.request, urllib.error

ROOT=pathlib.Path(__file__).resolve().parents[1]

def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

@unittest.skipUnless(shutil.which('caddy') and shutil.which('openssl') and shutil.which('node'),'Needs installed Caddy, OpenSSL and Node; no automatic downloads')
class IPProxyTests(unittest.TestCase):
    def test_https_proxy_isolation_auth_guard_and_no_public_legacy_proxy(self):
        with tempfile.TemporaryDirectory(prefix='iff-ip-proxy-test-') as tmp:
            folder=pathlib.Path(tmp);http_port,tls_port,backend=free_port(),free_port(),free_port()
            subprocess.run(['openssl','req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',str(folder/'privkey.pem'),'-out',str(folder/'fullchain.pem'),'-days','1','-subj','/CN=localhost-test-only','-addext','subjectAltName=IP:127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            snippet=(ROOT/'deploy/hosthatch/Caddyfile.ip-https.fragment').read_text()
            snippet=snippet.replace('http://167.104.162.4',f'http://127.0.0.1:{http_port}').replace('https://167.104.162.4',f'https://127.0.0.1:{tls_port}').replace('/var/lib/caddy/iff-ip-tls/current',str(folder)).replace('127.0.0.1:3107',f'127.0.0.1:{backend}').replace('/var/lib/iraqi-film-forge-acme-webroot',str(folder/'webroot'))
            (folder/'webroot/.well-known/acme-challenge').mkdir(parents=True)
            (folder/'webroot/.well-known/acme-challenge/fixture').write_text('test-challenge')
            config=folder/'Caddyfile';config.write_text('{\n admin off\n auto_https disable_redirects\n http_port '+str(http_port)+'\n https_port '+str(tls_port)+'\n}\n'+snippet)
            env={k:v for k,v in os.environ.items() if not k.startswith(('ENGINE_','MODAL_','PG')) and k not in ['DATABASE_URL','OPENAI_API_KEY','HF_TOKEN']}
            env.update({'HOST':'127.0.0.1','PORT':str(backend),'ENGINE_DATA_DIR':str(folder/'app-data'),'ENGINE_MASTER_KEY':base64.b64encode(os.urandom(32)).decode(),'ENGINE_TRUST_PROXY':'loopback','ENGINE_ALLOW_PAID_ACTIONS':'NO','ENGINE_ORIGIN':f'https://127.0.0.1:{tls_port}','XDG_DATA_HOME':str(folder/'xdg-data'),'XDG_CONFIG_HOME':str(folder/'xdg-config')})
            children=[]
            try:
                children.append(subprocess.Popen(['node','server.mjs'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
                children.append(subprocess.Popen(['caddy','run','--config',str(config),'--adapter','caddyfile'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
                context=ssl.create_default_context(cafile=str(folder/'fullchain.pem'))
                base=f'https://127.0.0.1:{tls_port}'
                ready=False
                for _ in range(80):
                    if any(p.poll() is not None for p in children):self.fail('Isolated proxy/backend exited')
                    try:
                        with urllib.request.urlopen(base+'/api/engine/health',context=context,timeout=1) as response:
                            health=json.load(response);self.assertTrue(health['secure']);self.assertFalse(health['configured']);ready=True;break
                    except (OSError,urllib.error.URLError):time.sleep(.05)
                self.assertTrue(ready,'Test proxy did not start')
                with urllib.request.urlopen(base+'/director.html',context=context) as response:
                    html=response.read().decode();self.assertIn('url=./film.html',html);self.assertEqual(response.headers['X-Frame-Options'],'DENY')
                with urllib.request.urlopen(base+'/film.html',context=context) as response:
                    html=response.read().decode();self.assertIn('id="saveServer"',html);self.assertIn('id="toggleStories"',html);self.assertEqual(response.headers['X-Frame-Options'],'DENY')
                for route in ['/api/engine/state','/api/v1/key','/api/director/chat']:
                    with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(base+route,context=context)
                    self.assertEqual(error.exception.code,401 if route.startswith('/api/engine/') else 403)
                connection=http.client.HTTPConnection('127.0.0.1',http_port,timeout=3)
                connection.request('GET','/.well-known/acme-challenge/fixture');response=connection.getresponse()
                self.assertEqual(response.status,200);self.assertEqual(response.read(),b'test-challenge')
                connection.request('GET','/director.html');response=connection.getresponse()
                self.assertEqual(response.status,308);self.assertEqual(response.headers['Location'],base+'/director.html');response.read();connection.close()
                with self.assertRaises(urllib.error.URLError) as error:urllib.request.urlopen(base+'/api/engine/health',context=ssl.create_default_context())
                self.assertIsInstance(error.exception.reason,ssl.SSLCertVerificationError)
                # The generated test CA is not a publicly trusted certificate.
            finally:
                for child in reversed(children):
                    if child.poll() is None:
                        child.terminate()
                        try:child.wait(timeout=5)
                        except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)

if __name__=='__main__':unittest.main()
