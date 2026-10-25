/**
 * Keeps secrets out of everything the app sends to a model. A mirror of src/claimcheck/redact.py:
 * both are tested against tests/fixtures/secret_cases.json so they cannot drift apart.
 *
 * Layers: secret-looking file names are never read or listed; secret-looking values inside any other
 * text become [REDACTED:kind]; payloads have a size cap. A safety net that prefers over-redacting.
 *
 * @author Patrick Finazzo
 */

const NAME_GLOBS = [
  '.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.p8', '*.ppk', '*.kdbx', '*.gpg',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc', '_netrc', '.pgpass', '.git-credentials',
  '.htpasswd', '.dockercfg', 'credentials', 'credentials.*', 'secret', 'secret.*', 'secrets', 'secrets.*', '*.secrets', '*.secret',
  'service-account*.json', '*serviceaccount*.json', '*service_account*.json', 'terraform.tfstate*', '*.tfvars', '*.tfvars.json',
  'kubeconfig', '*.kubeconfig', 'wp-config.php', 'local.settings.json', 'firebase-adminsdk*.json', 'client_secret*.json', '*.mobileprovision',
];
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', 'secrets', '.secrets', '.azure', '.gcloud']);

const globToRegExp = (glob: string): RegExp =>
  new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
const NAME_PATTERNS = NAME_GLOBS.map(globToRegExp);

export const isSecretPath = (p: unknown): boolean => {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.slice(0, -1).some((d) => SECRET_DIRS.has(d.toLowerCase()))) return true;
  const name = (parts.at(-1) ?? '').toLowerCase();
  return NAME_PATTERNS.some((re) => re.test(name));
};

const KEYWORD = '(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth(?:orization)?|credential|signing[_-]?key|session[_-]?key)s?';

const SPECIFIC: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{8,}/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{16,}/g],
  ['slack-token', /\bxox[abprso]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}/g],
  ['twilio-key', /\bSK[0-9a-f]{32}\b/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g],
  ['bearer-token', /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi],
];
const URL_CREDS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)([^\s@/"']{3,})(@)/gi;
const ASSIGN = new RegExp(`(\\b[A-Za-z0-9_.-]*${KEYWORD}[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*)(['"]?)([^\\s'",;)\\]}]{6,})(['"]?)`, 'gi');
const QUOTED_BLOB = /(['"])([A-Za-z0-9+/=_-]{32,})\1/g;
const PLACEHOLDER = /^(?:changeme|change-me|change_me|password|passwd|secret|token|example|sample|dummy|test|testing|todo|fixme|your[-_ ]?\w*|my[-_ ]?\w*|xxx+|\*+|\.\.\.|null|none|true|false|undefined|redacted.*)$/i;
const CODE_REF = /^(?:\$\{|\$\(|\{\{|<|%|os\.|process\.|env\b|getenv|config\.|settings\.|self\.|this\.|args\.|params\.|input|request\.|[a-z_][\w.]*\()/i;

const entropy = (s: string): number => {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) h -= (c / s.length) * Math.log2(c / s.length);
  return h;
};

const looksLikeSecretValue = (value: string, quoted: boolean): boolean => {
  const v = value.trim();
  if (v.length < 6 || PLACEHOLDER.test(v) || CODE_REF.test(v) || v.includes('[REDACTED')) return false;
  if (new Set(v).size <= 2) return false;
  if (quoted) return true;
  const hasDigit = /\d/.test(v);
  const hasAlpha = /[A-Za-z]/.test(v);
  if (/^[A-Za-z_]\w*$/.test(v)) return v.length >= 12 && hasDigit && hasAlpha;
  if (/^[A-Za-z_][\w.]*$/.test(v)) return false;
  return v.length >= 16 && hasDigit && hasAlpha;
};

/** Replaces secret-looking values with [REDACTED:kind]. Returns { text, count, kinds }. */
export type Redaction = {
  text: string;
  count: number;
  kinds: Record<string, number>;
};

export const redactText = (input: unknown): Redaction => {
  let text = String(input ?? '');
  let count = 0;
  const kinds: Record<string, number> = {};
  const add = (kind: string): void => {
    count += 1;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  };
  for (const [kind, re] of SPECIFIC) {
    text = text.replace(re, () => {
      add(kind);
      return `[REDACTED:${kind}]`;
    });
  }
  text = text.replace(URL_CREDS, (m: string, head: string, pw: string, at: string) => {
    if (PLACEHOLDER.test(pw) || CODE_REF.test(pw)) return m;
    add('url-credentials');
    return `${head}[REDACTED:url-credentials]${at}`;
  });
  text = text.replace(ASSIGN, (m: string, head: string, openQ: string, value: string, closeQ: string) => {
    if (!looksLikeSecretValue(value, Boolean(openQ))) return m;
    add('assigned-secret');
    return `${head}${openQ}[REDACTED:assigned-secret]${closeQ}`;
  });
  text = text.replace(QUOTED_BLOB, (m: string, q: string, s: string) => {
    if (entropy(s) < 4.0 || /^[0-9a-f]{32,}$/.test(s)) return m;
    add('random-string');
    return `${q}[REDACTED:random-string]${q}`;
  });
  return { text, count, kinds };
};

export const PER_FILE_CHARS = 40_000;
export const TOTAL_CHARS = 250_000;

/** Makes a unified diff safe to send. Returns { text, sent: { filesOmitted, redactions, kinds, truncated } }. */
export type Sent = {
  filesOmitted: string[];
  redactions: number;
  kinds: Record<string, number>;
  truncated: boolean;
};

export const filterDiff = (diff: unknown): { text: string; sent: Sent } => {
  const sent: Sent = { filesOmitted: [], redactions: 0, kinds: {}, truncated: false };
  const sections: Array<{ path: string | null; lines: string[] }> = [];
  for (const line of String(diff ?? '').split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) sections.push({ path: m[2] ?? null, lines: [line] });
    else if (sections.length) sections.at(-1)?.lines.push(line);
    else sections.push({ path: null, lines: [line] });
  }
  const out: string[] = [];
  let total = 0;
  for (const { path, lines } of sections) {
    if (path !== null && isSecretPath(path)) {
      sent.filesOmitted.push(path);
      out.push(`diff --git a/${path} b/${path}\n[withheld: ${path} looks like a secret store, so its contents are not sent]`);
      continue;
    }
    const red = redactText(lines.join('\n'));
    sent.redactions += red.count;
    for (const [k, v] of Object.entries(red.kinds)) sent.kinds[k] = (sent.kinds[k] ?? 0) + v;
    let body = red.text;
    if (body.length > PER_FILE_CHARS) {
      body = `${body.slice(0, PER_FILE_CHARS)}\n[truncated: this file's diff is longer than ${PER_FILE_CHARS} characters]`;
      sent.truncated = true;
    }
    if (total + body.length > TOTAL_CHARS) {
      out.push(`[truncated: the rest of the diff is longer than ${TOTAL_CHARS} characters in total]`);
      sent.truncated = true;
      break;
    }
    total += body.length;
    out.push(body);
  }
  return { text: out.join('\n'), sent };
};
