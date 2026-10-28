#!/usr/bin/env python3
"""Fresh, private staging only. Never imports existing data or edits the live proxy."""
import os, pathlib, subprocess, secrets, base64, pwd, grp, sys

def run(args, data=None):
    result=subprocess.run(args,input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode: raise RuntimeError('HOST_PREPARATION_FAILED_CHECK_PRIVATELY')
    return result.stdout.strip()

def sql(text, database='postgres'):
    return run(['runuser','-u','postgres','--','psql','-X','-v','ON_ERROR_STOP=1','-At','-d',database],text)

def main():
    if os.geteuid()!=0 or '--approve-new-private-staging' not in sys.argv: raise RuntimeError('EXPLICIT_STAGING_APPROVAL_REQUIRED')
    if run(['hostname'])!='muhtaj-app': raise RuntimeError('WRONG_HOST')
    config=pathlib.Path('/etc/iraqi-film-forge')
    # A partial or existing install requires inspection; never rotate credentials silently.
    if config.exists() or sql("SELECT 1 FROM pg_database WHERE datname='iraqi_film_forge'") or sql("SELECT 1 FROM pg_roles WHERE rolname IN ('iff_owner','iff_app')"):
        raise RuntimeError('EXISTING_IFF_STATE_STOP_FOR_INSPECTION')
    if run(['ss','-H','-ltn','sport = :3107']): raise RuntimeError('STAGING_PORT_IN_USE')
    run(['useradd','--system','--home-dir','/var/lib/iraqi-film-forge','--shell','/usr/sbin/nologin','iff'])
    uid=pwd.getpwnam('iff').pw_uid; gid=grp.getgrnam('iff').gr_gid
    config.mkdir(mode=0o750); os.chown(config,0,gid)
    data=pathlib.Path('/var/lib/iraqi-film-forge');data.mkdir(mode=0o700);os.chown(data,uid,gid)
    password=secrets.token_hex(32)
    def private_file(name,content):
        p=config/name
        with p.open('x') as f:f.write(content+'\n')
        os.chmod(p,0o640);os.chown(p,0,gid)
    private_file('database-password',password)
    private_file('master-key',base64.b64encode(secrets.token_bytes(32)).decode())
    sql("CREATE ROLE iff_owner NOLOGIN; CREATE ROLE iff_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+password+"'; CREATE DATABASE iraqi_film_forge OWNER iff_owner;")
    sql('REVOKE ALL ON DATABASE iraqi_film_forge FROM PUBLIC; GRANT CONNECT ON DATABASE iraqi_film_forge TO iff_app;')
    sql('REVOKE CREATE ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO iff_owner;', 'iraqi_film_forge')
    migration=pathlib.Path(__file__).resolve().parents[2]/'engine/migrations/001.sql'
    sql('SET ROLE iff_owner;\n'+migration.read_text(), 'iraqi_film_forge')
    sql('GRANT USAGE ON SCHEMA public TO iff_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO iff_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO iff_app; ALTER DEFAULT PRIVILEGES FOR ROLE iff_owner IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO iff_app; ALTER DEFAULT PRIVILEGES FOR ROLE iff_owner IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO iff_app;', 'iraqi_film_forge')
    private_file('app.env','''HOST=127.0.0.1
PORT=3107
ENGINE_DATA_DIR=/var/lib/iraqi-film-forge
ENGINE_DATABASE_DRIVER=postgres
ENGINE_DATABASE_HOST=127.0.0.1
ENGINE_DATABASE_NAME=iraqi_film_forge
ENGINE_DATABASE_USER=iff_app
ENGINE_DATABASE_PASSWORD_FILE=/etc/iraqi-film-forge/database-password
ENGINE_MASTER_KEY_FILE=/etc/iraqi-film-forge/master-key
ENGINE_ALLOW_PAID_ACTIONS=NO
ENGINE_ORIGIN=https://localhost:3107
ENGINE_ALLOWED_ORIGINS=https://localhost:3107
ENGINE_COOKIE_SAME_SITE=strict
ENGINE_TRUST_PROXY=
ENGINE_PYTHON=/srv/iraqi-film-forge/current/.venv-engine/bin/python''')
    print('Private database, limited role, encryption key and staging environment prepared; no secrets printed.')

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(str(e) if isinstance(e,RuntimeError) else 'HOST_PREPARATION_FAILED_NO_AUTOMATIC_RETRY',file=sys.stderr);sys.exit(1)
