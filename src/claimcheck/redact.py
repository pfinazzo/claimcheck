"""Keeps secrets out of everything that is sent to a model (redact.py).

Three layers, applied to every outgoing payload:
  1. Files that look like secret stores (.env, private keys, credentials) are never read into a
     prompt, and their names are not even listed.
  2. Inside any other text, values that look like secrets (API keys, tokens, private key blocks,
     passwords in assignments, URLs with credentials, long random strings) are replaced with
     [REDACTED:kind] before the text leaves this process.
  3. Payloads have a size cap, so a large file or a generated blob cannot carry more than intended.

This is a safety net, not a guarantee. The pattern list is conservative on purpose: it prefers
redacting a harmless value to sending a real one. The Desk app keeps a mirror of the path rules and
both are tested against the same fixture (tests/fixtures/secret_paths.json).

@author Patrick Finazzo
"""

from __future__ import annotations

import fnmatch
import math
import re
from typing import TypedDict

# ---- layer 1: paths ---------------------------------------------------------

# Matched against the file name (case-insensitive).
SECRET_NAME_GLOBS = [
    ".env", ".env.*", "*.env", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.p8",
    "*.ppk", "*.kdbx", "*.gpg", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*",
    ".npmrc", ".pypirc", ".netrc", "_netrc", ".pgpass", ".git-credentials", ".htpasswd", ".dockercfg",
    "credentials", "credentials.*", "secret", "secret.*", "secrets", "secrets.*", "*.secrets", "*.secret",
    "service-account*.json", "*serviceaccount*.json", "*service_account*.json", "terraform.tfstate*",
    "*.tfvars", "*.tfvars.json", "kubeconfig", "*.kubeconfig", "wp-config.php", "local.settings.json",
    "firebase-adminsdk*.json", "client_secret*.json", "*.mobileprovision",
]
# Any path that passes through one of these folders.
SECRET_DIRS = {".ssh", ".aws", ".gnupg", ".kube", ".docker", "secrets", ".secrets", ".azure", ".gcloud"}


def is_secret_path(path: str) -> bool:
    """Whether a path looks like a secret store (a .env, a key file, a credentials folder), so it is never sent."""
    p = path.replace("\\", "/").strip("/")
    parts = [x for x in p.split("/") if x]
    if not parts:
        return False
    if any(d.lower() in SECRET_DIRS for d in parts[:-1]):
        return True
    name = parts[-1].lower()
    return any(fnmatch.fnmatchcase(name, g) for g in SECRET_NAME_GLOBS)


# ---- layer 2: values --------------------------------------------------------

_KEYWORD = r"(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth(?:orization)?|credential|signing[_-]?key|session[_-]?key)s?"

# (kind, compiled pattern). Order matters: block patterns first, then specific, then generic.
_SPECIFIC: list[tuple[str, re.Pattern[str]]] = [
    ("private-key", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\Z)", re.S)),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{8,}")),
    ("openai-key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("gitlab-token", re.compile(r"\bglpat-[A-Za-z0-9_-]{16,}")),
    ("slack-token", re.compile(r"\bxox[abprso]-[A-Za-z0-9-]{10,}")),
    ("stripe-key", re.compile(r"\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{30,}")),
    ("npm-token", re.compile(r"\bnpm_[A-Za-z0-9]{30,}")),
    ("twilio-key", re.compile(r"\bSK[0-9a-f]{32}\b")),
    ("sendgrid-key", re.compile(r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}")),
    ("bearer-token", re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,}")),
]
_URL_CREDS = re.compile(r"([a-z][a-z0-9+.-]*://[^\s:/@\"']+:)([^\s@/\"']{3,})(@)", re.I)
_ASSIGN = re.compile(
    rf"(?i)(\b[A-Za-z0-9_.-]*{_KEYWORD}[A-Za-z0-9_.-]*[\"']?\s*[:=]\s*)(['\"]?)([^\s'\",;)\]}}]{{6,}})(['\"]?)"
)
_QUOTED_BLOB = re.compile(r"(['\"])([A-Za-z0-9+/=_-]{32,})\1")

_PLACEHOLDER = re.compile(
    r"(?i)^(?:changeme|change-me|change_me|password|passwd|secret|token|example|sample|dummy|test|testing|todo|fixme|"
    r"your[-_ ]?\w*|my[-_ ]?\w*|xxx+|\*+|\.\.\.|null|none|true|false|undefined|redacted.*)$"
)
_CODE_REF = re.compile(
    r"(?i)^(?:\$\{|\$\(|\{\{|<|%|os\.|process\.|env\b|getenv|config\.|settings\.|self\.|this\.|args\.|params\.|input|request\.|"
    r"[a-z_][\w.]*\()"
)


def _entropy(s: str) -> float:
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in counts.values())


def _looks_like_secret_value(value: str, quoted: bool) -> bool:
    v = value.strip()
    if len(v) < 6 or _PLACEHOLDER.match(v) or _CODE_REF.match(v) or "[REDACTED" in v:
        return False
    if len(set(v)) <= 2:
        return False
    if quoted:
        return True
    # unquoted: attribute access (config.token) is code; a bare identifier is code unless it is a long
    # mix of letters and digits, which is what a password or key looks like.
    has_digit = any(c.isdigit() for c in v)
    has_alpha = any(c.isalpha() for c in v)
    if re.fullmatch(r"[A-Za-z_]\w*", v):
        return len(v) >= 12 and has_digit and has_alpha
    if re.fullmatch(r"[A-Za-z_][\w.]*", v):
        return False
    return len(v) >= 16 and has_digit and has_alpha


# What redact_text replaced: how many values in all, and how many of each kind.
Redaction = TypedDict("Redaction", {"count": int, "kinds": dict[str, int]})


def make_redaction() -> Redaction:
    """An empty Redaction: nothing replaced yet."""
    return {"count": 0, "kinds": {}}


def count_redaction(rep: Redaction, *, kind: str) -> None:
    """Record one more replaced value of `kind`."""
    rep["count"] += 1
    rep["kinds"][kind] = rep["kinds"].get(kind, 0) + 1


def redact_text(text: str) -> tuple[str, Redaction]:
    """Replace secret-looking values with [REDACTED:kind]. Returns (clean text, what was done)."""
    rep = make_redaction()

    def sub_kind(kind: str):
        """A re.sub replacement that redacts the whole match as `kind` and counts it."""
        def inner(m: re.Match[str]) -> str:
            """Count the match and replace it with its redaction marker."""
            count_redaction(rep, kind=kind)
            return f"[REDACTED:{kind}]"
        return inner

    for kind, pat in _SPECIFIC:
        text = pat.sub(sub_kind(kind), text)

    def creds(m: re.Match[str]) -> str:
        """Redact the password in a URL, unless it is a placeholder or a code reference."""
        if _PLACEHOLDER.match(m.group(2)) or _CODE_REF.match(m.group(2)):
            return m.group(0)
        count_redaction(rep, kind="url-credentials")
        return f"{m.group(1)}[REDACTED:url-credentials]{m.group(3)}"

    text = _URL_CREDS.sub(creds, text)

    def assign(m: re.Match[str]) -> str:
        """Redact the value in `secret = value`, unless the value does not look secret."""
        head, open_q, value, close_q = m.group(1), m.group(2), m.group(3), m.group(4)
        if not _looks_like_secret_value(value, quoted=bool(open_q)):
            return m.group(0)
        count_redaction(rep, kind="assigned-secret")
        return f"{head}{open_q}[REDACTED:assigned-secret]{close_q}"

    text = _ASSIGN.sub(assign, text)

    def blob(m: re.Match[str]) -> str:
        """Redact a long random-looking string; hashes and ids are left alone."""
        s = m.group(2)
        # Hashes and ids are fine.
        if _entropy(s) < 4.0 or re.fullmatch(r"[0-9a-f]{32,}", s):
            return m.group(0)
        count_redaction(rep, kind="random-string")
        return f"{m.group(1)}[REDACTED:random-string]{m.group(1)}"

    text = _QUOTED_BLOB.sub(blob, text)
    return text, rep


# ---- layer 3: diffs and size caps -------------------------------------------

PER_FILE_CHARS = 40_000
TOTAL_CHARS = 250_000
_HEADER = re.compile(r"^diff --git a/(.+?) b/(.+)$")


# What was held back, for the person to see. Never contains the withheld content itself.
Sent = TypedDict("Sent", {"files_omitted": list[str], "redactions": int, "kinds": dict[str, int], "truncated": bool})


def make_sent() -> Sent:
    """An empty Sent: nothing withheld yet."""
    return {"files_omitted": [], "redactions": 0, "kinds": {}, "truncated": False}


def filter_diff(diff: str) -> tuple[str, Sent]:
    """Make a unified diff safe to send: drop secret files, redact values, cap the size."""
    sent = make_sent()
    sections: list[tuple[str | None, list[str]]] = []
    for line in diff.split("\n"):
        m = _HEADER.match(line)
        if m:
            sections.append((m.group(2), [line]))
        elif sections:
            sections[-1][1].append(line)
        else:
            sections.append((None, [line]))
    out: list[str] = []
    total = 0
    for path, lines in sections:
        if path is not None and is_secret_path(path):
            sent["files_omitted"].append(path)
            out.append(f"diff --git a/{path} b/{path}\n[withheld: {path} looks like a secret store, so its contents are not sent]")
            continue
        body, rep = redact_text("\n".join(lines))
        sent["redactions"] += rep["count"]
        for k, v in rep["kinds"].items():
            sent["kinds"][k] = sent["kinds"].get(k, 0) + v
        if len(body) > PER_FILE_CHARS:
            body = body[:PER_FILE_CHARS] + f"\n[truncated: this file's diff is longer than {PER_FILE_CHARS} characters]"
            sent["truncated"] = True
        if total + len(body) > TOTAL_CHARS:
            out.append(f"[truncated: the rest of the diff is longer than {TOTAL_CHARS} characters in total]")
            sent["truncated"] = True
            break
        total += len(body)
        out.append(body)
    return "\n".join(out), sent
