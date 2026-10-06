#!/usr/bin/env python3
import base64
import hashlib
from html.parser import HTMLParser
import http.cookiejar
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

from manage import BASE, CALLBACK, ISSUER, LOGOUT, STATE, USERS, admin_token, command, request, secret


class Form(HTMLParser):
    def __init__(self):
        super().__init__()
        self.action = None
        self.hidden = {}
        self.active = False

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        if tag == "form" and fields.get("id") == "kc-form-login":
            self.active = True
            self.action = fields.get("action")
        if self.active and tag == "input" and fields.get("type") == "hidden" and fields.get("name"):
            self.hidden[fields["name"]] = fields.get("value", "")

    def handle_endtag(self, tag):
        if tag == "form":
            self.active = False


class LocalRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if (target.scheme, target.netloc) != ("http", "localhost:8180"):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class LocalCookiePolicy(http.cookiejar.DefaultCookiePolicy):
    def return_ok_secure(self, cookie, req):
        target = urllib.parse.urlsplit(req.full_url)
        if target.scheme == "http" and target.netloc == "localhost:8180":
            return True
        return super().return_ok_secure(cookie, req)


def claims(jwt):
    return json.loads(base64.urlsafe_b64decode(jwt.split(".")[1] + "=="))


def login(short):
    verifier = secrets.token_urlsafe(48)
    nonce = secrets.token_urlsafe(24)
    state = secrets.token_urlsafe(24)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    params = {"client_id": "ax-web", "redirect_uri": CALLBACK, "response_type": "code",
              "scope": "openid email profile", "state": state, "nonce": nonce,
              "code_challenge": challenge, "code_challenge_method": "S256"}
    jar = http.cookiejar.CookieJar(policy=LocalCookiePolicy())
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), LocalRedirect())
    with opener.open(ISSUER + "/protocol/openid-connect/auth?" + urllib.parse.urlencode(params), timeout=20) as response:
        form = Form()
        form.feed(response.read(1024 * 1024).decode())
    if not form.action or not form.action.startswith(BASE + "/"):
        raise RuntimeError("Keycloak login form was not available")
    body = urllib.parse.urlencode({**form.hidden, "username": USERS[short], "password": secret(short + ".password")}).encode()
    try:
        opener.open(urllib.request.Request(form.action, data=body), timeout=20).close()
        raise RuntimeError("Password login did not return an authorization code")
    except urllib.error.HTTPError as error:
        if error.code not in {302, 303}:
            raise RuntimeError(f"Password login failed (HTTP {error.code}); response withheld") from None
        location = error.headers.get("Location", "")
    target = urllib.parse.urlsplit(location)
    if urllib.parse.urlunsplit((target.scheme, target.netloc, target.path, "", "")) != CALLBACK:
        raise RuntimeError("Unexpected login redirect")
    query = urllib.parse.parse_qs(target.query)
    if query.get("state") != [state] or len(query.get("code", [])) != 1:
        raise RuntimeError("Authorization response mismatch")
    result = request("/realms/ax/protocol/openid-connect/token", method="POST", form={
        "grant_type": "authorization_code", "client_id": "ax-web", "client_secret": secret("client.secret"),
        "redirect_uri": CALLBACK, "code": query["code"][0], "code_verifier": verifier,
    })
    access, identity = claims(result["access_token"]), claims(result["id_token"])
    header = json.loads(base64.urlsafe_b64decode(result["access_token"].split(".")[0] + "=="))
    audience = access.get("aud")
    if isinstance(audience, str):
        audience = [audience]
    checks = {
        "password_authorization_code_pkce": bool(access.get("sub")),
        "access_claims": access.get("iss") == ISSUER and access.get("azp") == "ax-web"
                         and access.get("typ") == "Bearer" and "ax-api" in (audience or [])
                         and header.get("alg") == "RS256" and 0 < access["exp"] - access["iat"] <= 1800,
        "id_token_not_api_audience": identity.get("aud") == "ax-web" and identity.get("nonce") == nonce,
    }
    request("/realms/ax/protocol/openid-connect/logout", method="POST", form={
        "client_id": "ax-web", "client_secret": secret("client.secret"), "refresh_token": result["refresh_token"],
    })
    return checks, access["sub"]


def verify():
    token = admin_token()
    realm = request("/admin/realms/ax", token=token)
    client = request("/admin/realms/ax/clients?clientId=ax-web", token=token)[0]
    action = request("/admin/realms/ax/authentication/required-actions/webauthn-register-passwordless", token=token)
    discovery = request("/realms/ax/.well-known/openid-configuration")
    checks = {
        "discovery": discovery["issuer"] == ISSUER and "S256" in discovery["code_challenge_methods_supported"],
        "registration_and_email_disabled": realm["registrationAllowed"] is False
            and realm["resetPasswordAllowed"] is False and not realm.get("smtpServer"),
        "passkey_policy": realm.get("webAuthnPolicyPasswordlessPasskeysEnabled") is True
            and realm.get("webAuthnPolicyPasswordlessRpId") == "localhost"
            and realm.get("webAuthnPolicyPasswordlessResidentKey") == "required"
            and realm.get("webAuthnPolicyPasswordlessUserVerificationRequirement") == "required"
            and action["enabled"] is True and action["defaultAction"] is False,
        "client_confidential_pkce": client["publicClient"] is False and client["standardFlowEnabled"] is True
            and client["directAccessGrantsEnabled"] is False and client["implicitFlowEnabled"] is False
            and client["serviceAccountsEnabled"] is False and client["attributes"].get("pkce.code.challenge.method") == "S256",
        "exact_redirects": client["redirectUris"] == [CALLBACK]
            and client["attributes"].get("post.logout.redirect.uris") == LOGOUT,
        "private_files": STATE.stat().st_mode & 0o777 == 0o700 and all(
            (STATE / name).stat().st_mode & 0o777 == 0o600
            for name in ["admin.password", "client.secret", "encryption.key", "alice.password", "bob.password", "app.json"]),
    }
    subjects = {}
    for short in USERS:
        observed, subjects[short] = login(short)
        checks.update({short + ":" + key: value for key, value in observed.items()})
    checks["distinct_users"] = subjects["alice"] != subjects["bob"]
    tls = command(["docker", "exec", "ax-local-postgres", "psql", "-X", "-At", "-U", "postgres", "-d", "postgres", "-c",
                   "SELECT count(*)>0 AND bool_and(s.ssl) FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.usename='ax_keycloak' AND a.datname='keycloak';"])
    checks["database_tls"] = tls.strip() == b"t"
    result = {"checks": checks, "subjects": subjects, "realm_id": realm["id"], "client_id": client["id"]}
    if not all(checks.values()):
        print(json.dumps(checks, indent=2))
        raise RuntimeError("Keycloak verification failed")
    return result


def main():
    os.umask(0o077)
    result = verify()
    path = STATE / "verification.json"
    path.write_text(json.dumps(result, indent=2) + "\n")
    path.chmod(0o600)
    print(json.dumps(result["checks"], indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Keycloak verification failed; credential-bearing details withheld", file=sys.stderr)
        sys.exit(1)
