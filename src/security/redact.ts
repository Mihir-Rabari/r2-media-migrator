/** Secret redaction. Applied to every log line, error message, report and config dump. */

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /(secret|password|passwd|token|apikey|api_key|accesskey|access_key|authorization|credential|private|uri$|url$)/i;
// keys whose names look sensitive but are only the *name of an env var* are safe to show
const SAFE_KEY = /(env|envvar|envname)$/i;
// "url"/"uri" keys are only sensitive when the value embeds credentials; handled by pattern below.
const URLISH_KEY = /(uri|url)$/i;

const PATTERNS: Array<[RegExp, string]> = [
  [/(mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|https?):\/\/([^\s:@/]+):([^\s@/]+)@/gi, '$1://$2:' + REDACTED + '@'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ' + REDACTED],
  [/((?:secret|password|passwd|token|api[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;}]{4,})/gi, '$1' + REDACTED],
];

export class Redactor {
  private readonly secrets: string[] = [];

  /** Register literal secret values (e.g. resolved env var contents). Short values are ignored to avoid noise. */
  addSecret(value: string | undefined | null): void {
    if (value && value.length >= 6 && !this.secrets.includes(value)) {
      this.secrets.push(value);
      this.secrets.sort((a, b) => b.length - a.length);
    }
  }

  string(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join(REDACTED);
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  }

  deep<T>(value: T): T {
    return this.walk(value, '') as T;
  }

  private walk(value: unknown, key: string): unknown {
    if (typeof value === 'string') {
      if (key && SENSITIVE_KEY.test(key) && !SAFE_KEY.test(key) && !URLISH_KEY.test(key)) return REDACTED;
      return this.string(value);
    }
    if (Array.isArray(value)) return value.map((v) => this.walk(v, key));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.walk(v, k);
      return out;
    }
    return value;
  }
}

/** Process-wide redactor; the config loader registers resolved secrets here. */
export const globalRedactor = new Redactor();
export const redact = (s: string): string => globalRedactor.string(s);
