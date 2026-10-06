#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STATE = ROOT / ".state/auth"
PG_SECRETS = ROOT / ".state/postgres/secrets"
BASE = "http://localhost:8180"
ISSUER = BASE + "/realms/ax"
CALLBACK = "http://127.0.0.1:3100/auth/callback"
LOGOUT = "http://127.0.0.1:3100/login"
USERS = {"alice": "alice@example.test", "bob": "bob@example.test"}


def private(path, content):
    with path.open("x", encoding="utf-8") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    path.chmod(0o600)


def secret(name):
    return (STATE / name).read_text().strip()


def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed; output withheld to avoid exposing credentials")
    return result.stdout


def compose(*args):
    return command(["docker", "compose", "-f", str(HERE / "compose.yaml"), *args])


def request(path, *, method="GET", body=None, token=None, form=None, allow_missing=False):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read(2 * 1024 * 1024)
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        if allow_missing and error.code == 404:
            return None
        raise RuntimeError(f"Keycloak {method} {path.split('?')[0]} failed (HTTP {error.code}); response withheld") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Keycloak is unavailable") from None


def admin_token():
    return request("/realms/master/protocol/openid-connect/token", method="POST", form={
        "grant_type": "password", "client_id": "admin-cli", "username": "ax-admin",
        "password": secret("admin.password"),
    })["access_token"]


def initialize():
    names = ["admin.password", "client.secret", "encryption.key", "alice.password", "bob.password"]
    if STATE.exists():
        if not all((STATE / name).is_file() for name in names):
            raise RuntimeError("Incomplete auth files: recover them; credentials are never regenerated automatically")
    else:
        tables = command(["docker", "exec", "ax-local-postgres", "psql", "-X", "-At", "-U", "postgres", "-d", "keycloak", "-c",
                          "SELECT count(*) FROM pg_tables WHERE schemaname='public';"])
        if tables.strip() != b"0":
            raise RuntimeError("Keycloak DB already contains data; recover its original auth files first")
        STATE.mkdir(parents=True, mode=0o700)
        for name in names:
            private(STATE / name, secrets.token_urlsafe(32) + "\n")
    STATE.chmod(0o700)
    config = {
        "issuer": ISSUER, "clientId": "ax-web", "clientSecret": secret("client.secret"),
        "audience": "ax-api", "encryptionKey": secret("encryption.key"),
        "database": {"host": "127.0.0.1", "port": 55432, "database": "app", "user": "ax_app",
                     "password": (PG_SECRETS / "app.password").read_text().strip(),
                     "caPath": str(PG_SECRETS / "ca.crt")},
    }
    path = STATE / "app.json"
    if path.exists():
        if json.loads(path.read_text()) != config:
            raise RuntimeError("Existing app.json differs; restore matching credentials instead of replacing it")
    else:
        private(path, json.dumps(config, indent=2) + "\n")
    for name in [*names, "app.json"]:
        (STATE / name).chmod(0o600)
    print(f"Auth files retained/prepared at {STATE}; credentials were not printed")


def realm_settings():
    return {
        "realm": "ax", "enabled": True, "displayName": "AX local",
        "sslRequired": "none", "registrationAllowed": False, "registrationEmailAsUsername": True,
        "loginWithEmailAllowed": True, "duplicateEmailsAllowed": False, "resetPasswordAllowed": False,
        "editUsernameAllowed": False, "verifyEmail": False, "rememberMe": False,
        "accessTokenLifespan": 1800, "ssoSessionIdleTimeout": 1800, "ssoSessionMaxLifespan": 1800,
        "defaultSignatureAlgorithm": "RS256", "smtpServer": {},
        "internationalizationEnabled": True, "supportedLocales": ["ja", "en"], "defaultLocale": "ja",
        "webAuthnPolicyPasswordlessRpEntityName": "AX local",
        "webAuthnPolicyPasswordlessRpId": "localhost",
        "webAuthnPolicyPasswordlessSignatureAlgorithms": ["ES256", "RS256"],
        "webAuthnPolicyPasswordlessAttestationConveyancePreference": "none",
        "webAuthnPolicyPasswordlessResidentKey": "required",
        "webAuthnPolicyPasswordlessUserVerificationRequirement": "required",
        "webAuthnPolicyPasswordlessPasskeysEnabled": True,
        "webAuthnPolicyPasswordlessMediation": "conditional",
    }


def client_settings():
    return {
        "clientId": "ax-web", "name": "AX web", "enabled": True, "protocol": "openid-connect",
        "publicClient": False, "clientAuthenticatorType": "client-secret", "standardFlowEnabled": True,
        "implicitFlowEnabled": False, "directAccessGrantsEnabled": False, "serviceAccountsEnabled": False,
        "fullScopeAllowed": False, "redirectUris": [CALLBACK], "webOrigins": [],
        "attributes": {"pkce.code.challenge.method": "S256", "post.logout.redirect.uris": LOGOUT,
                       "access.token.signed.response.alg": "RS256", "id.token.signed.response.alg": "RS256"},
        "defaultClientScopes": ["basic", "profile", "email"], "optionalClientScopes": [],
    }


def provision():
    token = admin_token()
    realm = request("/admin/realms/ax", token=token, allow_missing=True)
    request("/admin/realms/ax" if realm else "/admin/realms", token=token,
            method="PUT" if realm else "POST", body=realm_settings())
    clients = request("/admin/realms/ax/clients?clientId=ax-web", token=token)
    client = client_settings()
    if clients:
        if len(clients) != 1:
            raise RuntimeError("Ambiguous ax-web client")
        identifier = clients[0]["id"]
        stored = request(f"/admin/realms/ax/clients/{identifier}/client-secret", token=token)
        if stored["value"] != secret("client.secret"):
            raise RuntimeError("Existing client secret differs; it was not reset")
        request(f"/admin/realms/ax/clients/{identifier}", token=token, method="PUT", body=client)
    else:
        request("/admin/realms/ax/clients", token=token, method="POST",
                body={**client, "secret": secret("client.secret")})
        identifier = request("/admin/realms/ax/clients?clientId=ax-web", token=token)[0]["id"]
    scopes = {item["name"]: item["id"] for item in request("/admin/realms/ax/client-scopes", token=token)}
    for kind, desired in [("default", client["defaultClientScopes"]), ("optional", [])]:
        scope_path = f"/admin/realms/ax/clients/{identifier}/{kind}-client-scopes"
        assigned = {item["name"]: item["id"] for item in request(scope_path, token=token)}
        for name in assigned.keys() - set(desired):
            request(scope_path + "/" + assigned[name], token=token, method="DELETE")
        for name in set(desired) - assigned.keys():
            request(scope_path + "/" + scopes[name], token=token, method="PUT")
    mapper = {"name": "ax-api-audience", "protocol": "openid-connect", "protocolMapper": "oidc-audience-mapper",
              "consentRequired": False, "config": {"included.custom.audience": "ax-api",
                                                   "access.token.claim": "true", "id.token.claim": "false"}}
    mapper_path = f"/admin/realms/ax/clients/{identifier}/protocol-mappers/models"
    existing = [item for item in request(mapper_path, token=token) if item["name"] == mapper["name"]]
    if existing:
        request(mapper_path + "/" + existing[0]["id"], token=token, method="PUT", body={**mapper, "id": existing[0]["id"]})
    else:
        request(mapper_path, token=token, method="POST", body=mapper)
    action_path = "/admin/realms/ax/authentication/required-actions/webauthn-register-passwordless"
    action = request(action_path, token=token)
    request(action_path, token=token, method="PUT", body={**action, "enabled": True, "defaultAction": False})
    for short, email in USERS.items():
        users = request("/admin/realms/ax/users?" + urllib.parse.urlencode({"username": email, "exact": "true"}), token=token)
        if users:
            if len(users) != 1 or users[0].get("email") != email:
                raise RuntimeError("Existing test user differs; no password changed")
            continue
        request("/admin/realms/ax/users", token=token, method="POST", body={
            "username": email, "email": email, "emailVerified": True, "enabled": True,
            "firstName": short.title(), "lastName": "Local", "requiredActions": [],
            "credentials": [{"type": "password", "value": secret(short + ".password"), "temporary": False}],
        })
    print("Realm ax, confidential PKCE client, access-token audience, passkeys and two test users prepared; existing passwords retained")


def status():
    discovery = request("/realms/ax/.well-known/openid-configuration")
    if discovery["issuer"] != ISSUER:
        raise RuntimeError("Unexpected issuer")
    print(json.dumps({"issuer": discovery["issuer"], "pkce_s256": "S256" in discovery["code_challenge_methods_supported"]}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="Local Keycloak; never prints or resets existing credentials")
    parser.add_argument("command", choices=["init", "up", "provision", "status", "stop", "recreate"])
    args = parser.parse_args()
    if args.command == "init":
        initialize()
    elif args.command == "provision":
        provision()
    elif args.command == "status":
        status()
    elif args.command in {"up", "recreate"}:
        if not (STATE / "app.json").is_file():
            raise RuntimeError("Run init or recover the original auth files first")
        compose("up", "-d", *(["--force-recreate"] if args.command == "recreate" else []), "--wait", "--wait-timeout", "180")
        print("Keycloak healthy at http://localhost:8180")
    else:
        compose("stop")
        print("Keycloak stopped; database and private files retained")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(str(error) if isinstance(error, RuntimeError) else "Keycloak operation failed; private state retained, details withheld", file=sys.stderr)
        sys.exit(1)
