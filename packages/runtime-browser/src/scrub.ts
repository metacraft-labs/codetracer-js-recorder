/**
 * The scrubbing of a boundary log that does not depend on what the visitor
 * typed (CodeTracer's JS-Boundary-Recording specification §11.3.5): the
 * credential headers of a response, the query and fragment values of every
 * URL the log holds that a site lists or that look like a credential, and
 * the message of a page error, reduced to a template. Pure string functions,
 * with no DOM, shared by the record side (which scrubs before a frame is
 * encoded), the replay side (which compares a replayed request's URL with
 * the scrubbed one it recorded, {@link urlMatches}, and a replayed error's
 * message with the recorded template, {@link templateErrorMessage}) and the
 * browser error reporter (`error-report.ts`), which scrubs its reports by
 * the same rules. It lives in this package, below the shim, so that the
 * reporter can use it; the shim re-exports it.
 *
 * The holes a sensitive value leaves (§5.2.1) are `sensitive.ts`'s.
 */

/** What replaces a scrubbed query or fragment value (§11.3.5). */
export const SCRUBBED = "<scrubbed>";

/**
 * The response headers removed from every `NetResponse.headers` whatever
 * the site lists (§11.3.5): the credentials a response can carry, and every
 * `Proxy-*` header. Lowercase; header names compare case-insensitively
 * (RFC 9110 §5.1).
 */
export const CREDENTIAL_HEADERS: readonly string[] = [
  "authorization",
  "cookie",
  "set-cookie",
];

/** The site's scrub lists, from the ingest's `config` (Boundary-Ingest §3). */
export interface ScrubLists {
  /** Response header names to remove, besides {@link CREDENTIAL_HEADERS}. */
  headers: readonly string[];
  /** Query (and fragment) keys whose values are scrubbed. */
  queryKeys: readonly string[];
}

/** No site lists: only the built-in rules apply. */
export const NO_SCRUB_LISTS: ScrubLists = { headers: [], queryKeys: [] };

/** The longest a site list may be, and the longest name in one. */
const MAX_LIST = 256;
const MAX_NAME = 256;

/**
 * Read a site list from the `config` answer: an array of strings, each
 * trimmed and lowercased, empty and over-long names dropped, at most
 * {@link MAX_LIST} of them. Anything else is no list (the ingest's lists are
 * additions to the built-in rules, so a malformed one removes nothing the
 * recorder would otherwise scrub).
 */
export function readScrubList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = x.trim().toLowerCase();
    if (s.length > 0 && s.length <= MAX_NAME) out.add(s);
    if (out.size >= MAX_LIST) break;
  }
  return [...out];
}

/** Two sets of lists joined (the bootstrap's and the ingest's). */
export function joinScrubLists(a: ScrubLists, b: ScrubLists): ScrubLists {
  return {
    headers: [...new Set([...a.headers, ...b.headers])],
    queryKeys: [...new Set([...a.queryKeys, ...b.queryKeys])],
  };
}

/** Whether `b` lists something `a` does not. */
export function addsToScrubLists(a: ScrubLists, b: ScrubLists): boolean {
  return (
    b.headers.some((h) => !a.headers.includes(h)) ||
    b.queryKeys.some((k) => !a.queryKeys.includes(k))
  );
}

/** A JSON Web Token (RFC 7519 §3: three base64url parts; its header is JSON, so `eyJ`). */
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
/** The characters a URL-borne token is made of. */
const TOKEN_CHARS = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Whether a (decoded) query value has a credential's shape (§11.3.5): a
 * JWT, or a long high-entropy token: at least 24 token characters holding
 * both letters and digits with at least 3 bits of Shannon entropy per
 * character (a random token of 24 base64 characters has about 4.3; a word,
 * a date, a version or a path has less, or is not made of token characters
 * at all).
 */
export function credentialShaped(value: string): boolean {
  if (JWT.test(value)) return true;
  if (value.length < 24 || !TOKEN_CHARS.test(value)) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits >= 3;
}

/** `application/x-www-form-urlencoded` decoding of one key or value. */
function formDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * One `&`-separated part list (a query or a fragment) with every value the
 * site lists by key, or that has a credential's shape, replaced by
 * {@link SCRUBBED}. Keys and the separators stay as written, so the rest of
 * the URL is byte-identical.
 */
function scrubPairs(text: string, keys: readonly string[]): string {
  if (!text.includes("=")) return text;
  return text
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 0) return part;
      const key = formDecode(part.slice(0, eq)).toLowerCase();
      const raw = part.slice(eq + 1);
      if (raw === SCRUBBED) return part;
      const value = formDecode(raw);
      return keys.includes(key) || credentialShaped(value)
        ? `${part.slice(0, eq)}=${SCRUBBED}`
        : part;
    })
    .join("&");
}

/** A URL cut into the part before its query, its query and its fragment. */
function splitUrl(url: string): {
  base: string;
  query: string | undefined;
  fragment: string | undefined;
} {
  const hash = url.indexOf("#");
  const beforeHash = hash < 0 ? url : url.slice(0, hash);
  const fragment = hash < 0 ? undefined : url.slice(hash + 1);
  const q = beforeHash.indexOf("?");
  return {
    base: q < 0 ? beforeHash : beforeHash.slice(0, q),
    query: q < 0 ? undefined : beforeHash.slice(q + 1),
    fragment,
  };
}

function joinUrl(p: ReturnType<typeof splitUrl>): string {
  return (
    p.base +
    (p.query === undefined ? "" : `?${p.query}`) +
    (p.fragment === undefined ? "" : `#${p.fragment}`)
  );
}

/**
 * `url` with the values of its query, and of a fragment written as
 * `key=value` pairs (an OAuth implicit grant's `#access_token=…`), scrubbed
 * (§11.3.5). Works on the text, never through `URL`, so nothing else of the
 * URL is normalised.
 */
export function scrubUrl(
  url: string,
  lists: ScrubLists = NO_SCRUB_LISTS,
): string {
  if (url === "" || (!url.includes("?") && !url.includes("#"))) return url;
  const p = splitUrl(url);
  if (p.query !== undefined) p.query = scrubPairs(p.query, lists.queryKeys);
  if (p.fragment !== undefined)
    p.fragment = scrubPairs(p.fragment, lists.queryKeys);
  return joinUrl(p);
}

/**
 * Whether a URL the replayed page used matches the scrubbed one the log
 * holds (§7.1, §11.3.5): the same text, except that a value the log holds as
 * {@link SCRUBBED} matches any value under the same key, so replay needs
 * neither the site's lists nor the value the visitor's page used. Holes
 * (§5.2.1) are already in both: the replay holes its own requests.
 */
export function urlMatches(recorded: string, actual: string): boolean {
  if (recorded === actual) return true;
  if (!recorded.includes(SCRUBBED)) return false;
  const r = splitUrl(recorded);
  const a = splitUrl(actual);
  return (
    r.base === a.base &&
    pairsMatch(r.query, a.query) &&
    pairsMatch(r.fragment, a.fragment)
  );
}

function pairsMatch(r: string | undefined, a: string | undefined): boolean {
  if (r === a) return true;
  if (r === undefined || a === undefined) return false;
  const rs = r.split("&");
  const as = a.split("&");
  if (rs.length !== as.length) return false;
  return rs.every((part, i) => {
    if (part === as[i]) return true;
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(eq + 1) !== SCRUBBED) return false;
    const other = as[i];
    return (
      other.indexOf("=") === eq && other.slice(0, eq) === part.slice(0, eq)
    );
  });
}

/**
 * A response's headers (`NetResponse.headers`, a JSON array of `[name,
 * value]`) without the credential headers, the `Proxy-*` headers and the
 * headers the site lists (§11.3.5). A value that is not such an array is
 * replaced by `[]`: the recorder never uploads headers it could not read.
 */
export function scrubHeaders(
  json: string,
  lists: ScrubLists = NO_SCRUB_LISTS,
): string {
  let pairs: unknown;
  try {
    pairs = JSON.parse(json);
  } catch {
    return "[]";
  }
  if (!Array.isArray(pairs)) return "[]";
  const kept = pairs.filter((p): p is [string, string] => {
    if (!Array.isArray(p) || typeof p[0] !== "string") return false;
    const name = p[0].toLowerCase();
    return (
      !CREDENTIAL_HEADERS.includes(name) &&
      !name.startsWith("proxy-") &&
      !lists.headers.includes(name)
    );
  });
  return kept.length === pairs.length ? json : JSON.stringify(kept);
}

// ── Error templates ────────────────────────────────────────────────────

/**
 * The words that make a key secret-named (`password=…`, `api_key: …`), as
 * CodeTracer's ingest templates the exception messages of the spans it
 * receives with them, matched in any case.
 */
const SECRET_WORDS = [
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "api[_\\-]?key",
  "access[_\\-]?key",
  "auth",
  "credential",
  "private[_\\-]?key",
  "session[_\\-]?id",
  "cookie",
  "signature",
];

/**
 * One left-to-right scan; at each position the first rule that matches
 * wins, in the order and with the placeholders of the exception templating
 * CodeTracer's ingest applies to spans, so a page error and a server span
 * read the same:
 * a URL, a quoted run, the value of a secret-named key or after `Bearer` /
 * `Basic`, a credential-shaped token, a UUID, an e-mail address, a
 * file-system path, a hexadecimal token, any other long mixed token, a
 * number. Every alternative is linear in its input (no nested quantifier
 * can backtrack over the same text twice).
 */
const MESSAGE_TOKENS = new RegExp(
  [
    String.raw`(?<url>(?<![A-Za-z0-9+.\-])[A-Za-z][A-Za-z0-9+.\-]{0,31}:\/\/[^\s"'\x60<>]+)`,
    String.raw`(?<str>"[^"\n]*(?:"|(?=\n)|$)|(?<!\w)'[^'\n]*(?:'|(?=\n)|$)|\x60[^\x60\n]*(?:\x60|(?=\n)|$))`,
    String.raw`(?<skey>(?<![A-Za-z0-9_.\-])[A-Za-z0-9_.\-]{0,64}?(?:${SECRET_WORDS.join("|")})[A-Za-z0-9_\-]{0,64})(?<ssep>[\t ]{0,16}[=:][\t ]{0,16})(?<sval>"[^"\n]*"?|'[^'\n]*'?|(?:(?:bearer|basic)[\t ]+)?[^\s,;&)\]}]+)`,
    String.raw`(?<bkey>(?<![A-Za-z0-9_])(?:bearer|basic))(?<bsep>[\t ]+)(?<bval>(?=[A-Za-z0-9._~+/=\-]*[0-9._~+/=\-])[A-Za-z0-9._~+/=\-]{8,})`,
    String.raw`(?<tok1>(?<![A-Za-z0-9_\-])eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*|eyJ[A-Za-z0-9_\-]{8,}(?:\.[A-Za-z0-9_\-]+){0,2}|\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bxox[abposr]-[A-Za-z0-9\-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bglpat-[A-Za-z0-9_\-]{16,}|\bct_ci_[A-Za-z0-9_\-]{8,}|\bAIza[A-Za-z0-9_\-]{30,})`,
    String.raw`(?<uuid>\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b)`,
    String.raw`(?<email>(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,255}\.[A-Za-z]{2,63})`,
    String.raw`(?<path>(?<![\w.:/~\\\-])(?:~|\/[\w.\-~@+%=$]+)(?:\/[\w.\-~@+%=$]+)+\/?|\b[A-Za-z]:[\\/][\w.\-~@+%=$]+(?:[\\/][\w.\-~@+%=$]+)*[\\/]?|(?<![\w\\])\\\\[\w.\-$]+(?:\\[\w.\-~@+%=$]+)+)`,
    String.raw`(?<hex>\b0[xX][0-9A-Fa-f]+\b|\b(?=[0-9A-Fa-f]*[0-9])(?=[0-9A-Fa-f]*[A-Fa-f])[0-9A-Fa-f]{8,}\b)`,
    String.raw`(?<tok2>(?<![A-Za-z0-9+/_\-])(?=[A-Za-z0-9+/_\-]*[0-9])(?=[A-Za-z0-9+/_\-]*[A-Za-z])[A-Za-z0-9+/_\-]{24,}={0,2}(?![A-Za-z0-9+/_\-]))`,
    String.raw`(?<num>(?<![\w.])[0-9]+(?:\.[0-9]+)*\b)`,
  ].join("|"),
  // `i` only matters for the secret words and Bearer/Basic: every other
  // class spells both cases already, except the fixed prefixes, which a
  // case-insensitive match over-redacts at worst (the safe side).
  "gi",
);

/** The most of a message that is read, and the longest template kept. */
const MAX_MESSAGE_INPUT = 4096;
const MAX_TEMPLATE = 1024;

/**
 * `Error.message` reduced to a template with typed placeholders (§11.3.5):
 * `<url>`, `<str>`, `<secret>` (the key and separator kept), `<token>`,
 * `<uuid>`, `<email>`, `<path>`, `<hex>`, `<num>`, the placeholders of the
 * exception templating CodeTracer's ingest applies to spans. Whitespace runs collapse to
 * one space and the template is cut at 1024 characters. Deterministic, so a
 * replay compares the template of the error it raised with the recorded one
 * (§7.2 `ErrorMismatch`).
 */
export function templateErrorMessage(message: string): string {
  const input =
    message.length > MAX_MESSAGE_INPUT
      ? message.slice(0, MAX_MESSAGE_INPUT)
      : message;
  const out = input.replace(MESSAGE_TOKENS, (...args: unknown[]): string => {
    const g = args[args.length - 1] as Record<string, string | undefined>;
    if (g.url !== undefined) return "<url>";
    if (g.str !== undefined) return "<str>";
    if (g.skey !== undefined) return `${g.skey}${g.ssep}<secret>`;
    if (g.bkey !== undefined) return `${g.bkey}${g.bsep}<secret>`;
    if (g.tok1 !== undefined || g.tok2 !== undefined) return "<token>";
    if (g.uuid !== undefined) return "<uuid>";
    if (g.email !== undefined) return "<email>";
    if (g.path !== undefined) return "<path>";
    if (g.hex !== undefined) return "<hex>";
    return "<num>";
  });
  const collapsed = out.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_TEMPLATE
    ? collapsed.slice(0, MAX_TEMPLATE)
    : collapsed;
}

/**
 * The URL among `logged` (URLs a log holds, scrubbed) that `actual` (one
 * the replayed page uses) is: `actual` itself when the log holds it as it
 * is, else the first logged URL it {@link urlMatches}, else `actual`. Used
 * where replay looks a URL up by the log's spelling of it (a held script
 * or resource, `DocTask.src`).
 */
export function resolveLoggedUrl(
  logged: Iterable<string>,
  actual: string,
): string {
  let candidates: string[] | undefined;
  for (const u of logged) {
    if (u === actual) return u;
    if (u.includes(SCRUBBED)) (candidates ??= []).push(u);
  }
  return candidates?.find((u) => urlMatches(u, actual)) ?? actual;
}
