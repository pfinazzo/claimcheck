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
    normalized = path.replace("\\", "/").strip("/")
    parts = [value for value in normalized.split("/") if value]
    if not parts:
        return False
    if any(part.lower() in SECRET_DIRS for part in parts[:-1]):
        return True
    name = parts[-1].lower()
    return any(fnmatch.fnmatchcase(name, secret_name_glob) for secret_name_glob in SECRET_NAME_GLOBS)


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


def _compute_entropy(s: str) -> float:
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for char in s:
        counts[char] = counts.get(char, 0) + 1
    count = len(s)
    return -sum(character / count * math.log2(character / count) for character in counts.values())


def _is_likely_secret_value(value: str, *, quoted: bool) -> bool:
    element = value.strip()
    if len(element) < 6 or _PLACEHOLDER.match(element) or _CODE_REF.match(element) or "[REDACTED" in element:
        return False
    if len(set(element)) <= 2:
        return False
    if quoted:
        return True
    # unquoted: attribute access (config.token) is code; a bare identifier is code unless it is a long
    # mix of letters and digits, which is what a password or key looks like.
    has_digit = any(char.isdigit() for char in element)
    has_alpha = any(character.isalpha() for character in element)
    if re.fullmatch(r"[A-Za-z_]\w*", element):
        return len(element) >= 12 and has_digit and has_alpha
    if re.fullmatch(r"[A-Za-z_][\w.]*", element):
        return False
    return len(element) >= 16 and has_digit and has_alpha


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

    def make_kind_replacer(kind: str):
        """A re.sub replacement that redacts the whole match as `kind` and counts it."""
        def replace_match(m: re.Match[str]) -> str:
            """Count the match and replace it with its redaction marker."""
            count_redaction(rep, kind=kind)
            return f"[REDACTED:{kind}]"
        return replace_match

    for kind, pat in _SPECIFIC:
        text = pat.sub(make_kind_replacer(kind), text)

    def redact_creds(m: re.Match[str]) -> str:
        """Redact the password in a URL, unless it is a placeholder or a code reference."""
        if _PLACEHOLDER.match(m.group(2)) or _CODE_REF.match(m.group(2)):
            return m.group(0)
        count_redaction(rep, kind="url-credentials")
        return f"{m.group(1)}[REDACTED:url-credentials]{m.group(3)}"

    text = _URL_CREDS.sub(redact_creds, text)

    def redact_assign(m: re.Match[str]) -> str:
        """Redact the value in `secret = value`, unless the value does not look secret."""
        head, open_q, value, close_q = m.group(1), m.group(2), m.group(3), m.group(4)
        if not _is_likely_secret_value(value, quoted=bool(open_q)):
            return m.group(0)
        count_redaction(rep, kind="assigned-secret")
        return f"{head}{open_q}[REDACTED:assigned-secret]{close_q}"

    text = _ASSIGN.sub(redact_assign, text)

    def redact_blob(m: re.Match[str]) -> str:
        """Redact a long random-looking string; hashes and ids are left alone."""
        message = m.group(2)
        # Hashes and ids are fine.
        if _compute_entropy(message) < 4.0 or re.fullmatch(r"[0-9a-f]{32,}", message):
            return m.group(0)
        count_redaction(rep, kind="random-string")
        return f"{m.group(1)}[REDACTED:random-string]{m.group(1)}"

    text = _QUOTED_BLOB.sub(redact_blob, text)
    return text, rep


# ---- layer 3: diffs and size caps -------------------------------------------

PER_FILE_CHARS = 40_000
TOTAL_CHARS = 250_000
_HEADER = re.compile(r"^diff --git a/(.+?) b/(.+)$")


# What was held back, for the person to see. Never contains the withheld content itself.
# `files_truncated` names each file the checker saw only part of, or none of, because of the size caps.
Sent = TypedDict(
    "Sent", {"files_omitted": list[str], "files_truncated": list[str], "redactions": int, "kinds": dict[str, int], "truncated": bool}
)


def make_sent() -> Sent:
    """An empty Sent: nothing withheld yet."""
    return {"files_omitted": [], "files_truncated": [], "redactions": 0, "kinds": {}, "truncated": False}


def filter_diff(diff: str) -> tuple[str, Sent]:
    """Make a unified diff safe to send: drop secret files, redact values, cap the size."""
    sent = make_sent()
    sections: list[tuple[str | None, list[str]]] = []
    for line in diff.split("\n"):
        found = _HEADER.match(line)
        if found:
            sections.append((found.group(2), [line]))
        elif sections:
            sections[-1][1].append(line)
        else:
            sections.append((None, [line]))
    kept_lines: list[str] = []
    total = 0
    for index, (path, lines) in enumerate(sections):
        if path is not None and is_secret_path(path):
            sent["files_omitted"].append(path)
            kept_lines.append(f"diff --git a/{path} b/{path}\n[withheld: {path} looks like a secret store, so its contents are not sent]")
            continue
        body, rep = redact_text("\n".join(lines))
        sent["redactions"] += rep["count"]
        for key, value in rep["kinds"].items():
            sent["kinds"][key] = sent["kinds"].get(key, 0) + value
        if len(body) > PER_FILE_CHARS:
            body = body[:PER_FILE_CHARS] + f"\n[truncated: this file's diff is longer than {PER_FILE_CHARS} characters]"
            sent["truncated"] = True
            sent["files_truncated"] += [path] if path is not None else []
        if total + len(body) > TOTAL_CHARS:
            kept_lines.append(f"[truncated: the rest of the diff is longer than {TOTAL_CHARS} characters in total]")
            sent["truncated"] = True
            # This file and every one after it were never sent.
            sent["files_truncated"].extend(rest for rest, _lines in sections[index:] if rest is not None and rest not in sent["files_truncated"])
            break
        total += len(body)
        kept_lines.append(body)
    return "\n".join(kept_lines), sent
