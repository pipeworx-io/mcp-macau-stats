interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * Macau Statistics MCP — DSEC (Direcção dos Serviços de Estatística e Censos
 * 澳門統計暨普查局 / Serviços de Estatística e Censos de Macau) key indicators.
 *
 * Why this exists: Pipeworx had zero Macau coverage. DSEC publishes a public
 * SOAP web service, `TimeSeriesDatabase.asmx` (WSDL:
 * https://www.dsec.gov.mo/TimeSeriesDatabase.asmx?WSDL), that is old-school
 * ASP.NET ASMX — every SOAP operation also answers a plain HTTP GET
 * (the framework's HttpGet binding), so no SOAP envelope, no registration and
 * no key are needed despite the `/zh-MO/Service/WebService` page framing this
 * as a "contact us" widget product (that copy describes the styled embed
 * widget, not the raw data call used here). Confirmed live with a browser
 * network tab (fleet #1311) and re-verified directly (fleet #1338).
 *
 * `getKeyIndicatorList` returns 143 named headline indicators (population,
 * visitor arrivals, CPI, unemployment, gaming tax, gross revenue of games of
 * chance, etc.) each with a `KeyIndicatorID`. `getKeyIndicatorValue` returns
 * the latest published value for one of those 143 — this is the SAME monthly
 * gross-gaming-revenue figure DICJ (the gaming regulator) publishes as an
 * HTML table, sourced here as clean XML with no scrape needed. This
 * supersedes any DICJ HTML-table pack — none is built.
 *
 * IMPORTANT ID-SPACE TRAP: the 143 curated `KeyIndicatorID`s are a SEPARATE,
 * disjoint numbering from the general `IndicatorID` space used by
 * `getIndicatorLatestNValues`/`getIndicatorValue` (DSEC's full statistics
 * database, tens of thousands of series). `getIndicatorByID(15)` returns an
 * EMPTY result — KeyIndicatorID 15 is not IndicatorID 15. There is no
 * documented mapping between the two spaces. `getIndicatorID` does an
 * upstream keyword/substring search over general-catalog descriptions; when
 * a key indicator's own description matches EXACTLY ONE general-catalog
 * series (e.g. "Live births" -> IndicatorID 9014, confirmed live), this pack
 * uses that unique match to also pull a real historical series via
 * `getIndicatorLatestNValues`. When the search is ambiguous (multiple hits)
 * or empty (no hits — true for "Gross revenue of games of chance", which
 * turns out to exist ONLY in the curated key-indicator set, not the general
 * catalog), the tool still returns the correct current value from
 * `getKeyIndicatorValue`, with `history: null` and a `history_note`
 * explaining why — never a silently wrong series from a mismatched id.
 *
 * Source: Macao Statistics and Census Service (DSEC), dsec.gov.mo.
 */


const UA = 'pipeworx-mcp-macau-stats/1.0 (+https://pipeworx.io)';
const BASE = 'https://www.dsec.gov.mo/TimeSeriesDatabase.asmx';
const UPSTREAM = 'DSEC TimeSeriesDatabase';

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, UPSTREAM);
}

// ── Tiny hand-rolled XML reader ─────────────────────────────────────────
// The upstream is old ASP.NET ASMX SOAP/GET and answers XML, not JSON — no
// namespaces or attributes worth parsing, just flat/nested tags with plain
// text or numeric content, so a couple of regexes cover it without pulling
// in an XML dependency (this pack must stay a single self-contained file —
// publish-pack.sh cannot inline sibling modules).

/** First occurrence of <tag>...</tag> content, or null. Handles self-closing
 *  empty tags (<tag />) by returning null too. */
function xmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

/** Every top-level occurrence of a repeated <wrapperTag><itemTag>...</itemTag>
 *  ...</wrapperTag> block's inner content, as raw (un-decoded) XML fragments
 *  ready for a further xmlTag() call each. */
function xmlBlocks(xml: string, itemTag: string): string[] {
  const re = new RegExp(`<${itemTag}>([\\s\\S]*?)</${itemTag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function xmlStatusCode(xml: string): number | null {
  const s = xmlTag(xml, 'StatusCode');
  return s === null ? null : Number(s);
}

// ── Upstream shapes ──────────────────────────────────────────────────────

type Language = 'English' | 'TraditionalChinese' | 'SimplifiedChinese' | 'Portuguese';

interface KeyIndicator {
  id: number;
  description: string;
  frequency: string;
}

interface IndicatorValue {
  reference_period: string;
  unit: string | null;
  year: number;
  period_id: number;
  value: number | null;
  remark: string | null;
}

const FREQUENCY_LABEL: Record<string, string> = {
  Yearly: 'yearly',
  Monthly: 'monthly',
  Quarterly: 'quarterly',
  ThreeConsecutiveMonths: 'rolling 3-month',
  SchoolTerm: 'school term',
  TwoConsecutiveYears: 'rolling 2-year',
  ThreeConsecutiveYears: 'rolling 3-year',
  FourConsecutiveYears: 'rolling 4-year',
};

function freqLabel(dataPeriod: string): string {
  return FREQUENCY_LABEL[dataPeriod] ?? dataPeriod;
}

async function fetchKeyIndicatorList(lang: Language): Promise<KeyIndicator[]> {
  const url = `${BASE}/getKeyIndicatorList?vLanguageType=${lang}`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const xml = await res.text();
  const status = xmlStatusCode(xml);
  if (status !== 0) {
    throw new Error(`${UPSTREAM}: getKeyIndicatorList returned StatusCode ${status ?? 'unknown'} for ${lang}`);
  }
  return xmlBlocks(xml, 'DSECKeyIndicator')
    .filter((b) => b.includes('<KeyIndicatorID>'))
    .map((b) => ({
      id: Number(xmlTag(b, 'KeyIndicatorID')),
      description: xmlTag(b, 'Description') ?? '',
      frequency: xmlTag(b, 'DataPeriod') ?? '',
    }));
}

// In-isolate cache — the 143-row catalogue changes rarely and is fetched in
// up to 3 languages per call; no reason to refetch per request.
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1h
let catalogCache: { rows: TriIndicator[]; expiresAt: number } | null = null;

interface TriIndicator {
  id: number;
  frequency: string;
  en: string;
  zh: string | null;
  pt: string | null;
}

async function keyIndicatorCatalog(): Promise<TriIndicator[]> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.rows;
  const [en, zh, pt] = await Promise.all([
    fetchKeyIndicatorList('English'),
    fetchKeyIndicatorList('TraditionalChinese'),
    fetchKeyIndicatorList('Portuguese'),
  ]);
  const zhById = new Map(zh.map((r) => [r.id, r.description]));
  const ptById = new Map(pt.map((r) => [r.id, r.description]));
  const rows: TriIndicator[] = en.map((r) => ({
    id: r.id,
    frequency: freqLabel(r.frequency),
    en: r.description,
    zh: zhById.get(r.id) ?? null,
    pt: ptById.get(r.id) ?? null,
  }));
  catalogCache = { rows, expiresAt: Date.now() + CATALOG_TTL_MS };
  return rows;
}

async function fetchKeyIndicatorValue(id: number, lang: Language = 'English'): Promise<IndicatorValue | null> {
  const url = `${BASE}/getKeyIndicatorValue?iKeyIndicatorID=${id}&vLanguageType=${lang}`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const xml = await res.text();
  const status = xmlStatusCode(xml);
  if (status !== 0) {
    throw new Error(`${UPSTREAM}: getKeyIndicatorValue returned StatusCode ${status ?? 'unknown'} for id ${id}`);
  }
  const block = xmlBlocks(xml, 'DSECIndicatorWSData')[0];
  if (!block) return null;
  const valueRaw = xmlTag(block, 'IndicatorValue');
  return {
    reference_period: xmlTag(block, 'ReferencePeriod') ?? '',
    unit: xmlTag(block, 'UnitLabel'),
    year: Number(xmlTag(block, 'Year') ?? 0),
    period_id: Number(xmlTag(block, 'PeriodID') ?? 0),
    value: valueRaw === null || valueRaw === '' ? null : Number(valueRaw),
    remark: xmlTag(block, 'RemarkDescription') || null,
  };
}

interface GeneralIndicatorMatch {
  indicator_id: number;
  description: string;
  available_periods: string[];
}

/** Search DSEC's general (non-curated) indicator catalog by description
 *  substring. Returns a match ONLY when the search resolves to exactly one
 *  series — an ambiguous or empty search is deliberately treated as "no
 *  reliable mapping" rather than guessing, since KeyIndicatorID and
 *  IndicatorID are disjoint id spaces and a wrong guess would silently
 *  attach the wrong history to the wrong headline number. */
async function findUniqueGeneralIndicator(description: string): Promise<GeneralIndicatorMatch | null> {
  const url = `${BASE}/getIndicatorID?strIndicatorDescription=${encodeURIComponent(description)}&vLanguageType=English`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const xml = await res.text();
  if (xmlStatusCode(xml) !== 0) return null;
  const blocks = xmlBlocks(xml, 'DSECIndicator').filter((b) => b.includes('<IndicatorID>'));
  const exact = blocks.filter((b) => (xmlTag(b, 'Description') ?? '').trim().toLowerCase() === description.trim().toLowerCase());
  const candidates = exact.length === 1 ? exact : blocks.length === 1 ? blocks : [];
  if (candidates.length !== 1) return null;
  const b = candidates[0];
  const periods = xmlBlocks(b, 'DataPeriod');
  return {
    indicator_id: Number(xmlTag(b, 'IndicatorID')),
    description: xmlTag(b, 'Description') ?? description,
    available_periods: periods.length ? periods.map((p) => p.trim()) : [],
  };
}

async function fetchIndicatorHistory(
  indicatorId: number,
  dataPeriod: string,
  n: number,
): Promise<IndicatorValue[]> {
  const url =
    `${BASE}/getIndicatorLatestNValues?iIndicatorID=${indicatorId}&vLanguageType=English` +
    `&vFunctionType=VAL&vDataPeriodType=${dataPeriod}&iLatestNRecords=${n}`;
  const res = await pwFetch(url);
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const xml = await res.text();
  if (xmlStatusCode(xml) !== 0) return [];
  return xmlBlocks(xml, 'DSECIndicatorWSData').map((b) => {
    const valueRaw = xmlTag(b, 'IndicatorValue');
    return {
      reference_period: xmlTag(b, 'ReferencePeriod') ?? '',
      unit: xmlTag(b, 'UnitLabel'),
      year: Number(xmlTag(b, 'Year') ?? 0),
      period_id: Number(xmlTag(b, 'PeriodID') ?? 0),
      value: valueRaw === null || valueRaw === '' ? null : Number(valueRaw),
      remark: xmlTag(b, 'RemarkDescription') || null,
    };
  });
}

/** Resolve a caller-supplied id-or-name against the 143-row catalogue. */
async function resolveIndicator(idOrName: string | number | undefined, catalog: TriIndicator[]): Promise<TriIndicator | null> {
  if (idOrName === undefined || idOrName === '') return null;
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    const id = Number(idOrName);
    return catalog.find((r) => r.id === id) ?? null;
  }
  const q = String(idOrName).trim().toLowerCase();
  const exact = catalog.find((r) => r.en.toLowerCase() === q || r.zh === idOrName || r.pt?.toLowerCase() === q);
  if (exact) return exact;
  const contains = catalog.filter(
    (r) => r.en.toLowerCase().includes(q) || (r.zh && String(idOrName).includes(r.zh)) || r.pt?.toLowerCase().includes(q),
  );
  return contains[0] ?? null;
}

async function buildIndicatorResult(row: TriIndicator, periods: number) {
  const latest = await fetchKeyIndicatorValue(row.id);
  const result: Record<string, unknown> = {
    key_indicator_id: row.id,
    description: { en: row.en, zh: row.zh, pt: row.pt },
    frequency: row.frequency,
    latest,
    history: null,
    history_note:
      'DSEC\'s curated key-indicator service (getKeyIndicatorValue) returns only the latest published value per indicator, ' +
      'not a series. This tool separately searches DSEC\'s general statistics catalog for a description match to pull real ' +
      'history via getIndicatorLatestNValues; that search found no single unambiguous match for this indicator, so only the ' +
      'latest value is returned.',
  };
  if (periods > 1) {
    const match = await findUniqueGeneralIndicator(row.en);
    if (match) {
      const dataPeriod = match.available_periods.includes('Monthly')
        ? 'Monthly'
        : match.available_periods.includes('Quarterly')
        ? 'Quarterly'
        : match.available_periods.includes('Yearly')
        ? 'Yearly'
        : match.available_periods[0];
      if (dataPeriod) {
        const history = await fetchIndicatorHistory(match.indicator_id, dataPeriod, periods);
        if (history.length) {
          result.history = history;
          result.history_note = `Historical series (${history.length} periods, ${freqLabel(dataPeriod)}) from DSEC's general statistics catalog, matched by description to "${match.description}" (IndicatorID ${match.indicator_id}).`;
        }
      }
    }
  }
  return result;
}

// ── Tools ────────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'macau_indicators',
    description:
      'Catalogue of Macau\'s 143 official key statistical indicators (population, visitor arrivals, gaming revenue, CPI, unemployment, crime, births/deaths, and more) from DSEC (Macao Statistics and Census Service / 澳門統計暨普查局). Returns each indicator\'s id, name in English, 中文 (Traditional Chinese) and Portuguese, and reporting frequency. Pass `query` to filter by keyword (matches any language); omit it to list all 143. Use this to find the right id/name for `macau_indicator`. Answers "what economic indicators does Macau publish", "find Macau\'s tourism statistics".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Optional keyword to filter indicators by name, in English, 中文 or Portuguese, e.g. "gaming", "population", "turismo".',
        },
      },
    },
  },
  {
    name: 'macau_indicator',
    description:
      'Latest published value (and, when a reliable match exists, recent history) for one of Macau\'s 143 DSEC key indicators. Pass either the numeric `id` from `macau_indicators`, or a `name` keyword (English, 中文 or Portuguese, e.g. "gross revenue of games of chance", "population", "turismo"). Always returns the current value with its reference period and unit; `periods` (default 24) additionally attempts a historical series by matching the indicator against DSEC\'s general statistics database — this succeeds for many series but not all (some key indicators, notably gaming revenue, exist only as a curated latest-value widget with no general-catalog counterpart), in which case `history` is null and `history_note` explains why. Sourced from DSEC\'s public TimeSeriesDatabase.asmx web service.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Numeric KeyIndicatorID from macau_indicators, e.g. 15 for "Gross revenue of games of chance".' },
        name: { type: 'string', description: 'Indicator name or keyword, English/中文/Portuguese, e.g. "gaming revenue", "population".' },
        periods: { type: 'number', description: 'How many historical periods to attempt to fetch when a general-catalog match is found (default 24).' },
      },
    },
  },
  {
    name: 'macau_gaming_revenue',
    description:
      'Macau\'s monthly gross revenue of games of chance (澳門博彩毛收入 / receita bruta dos jogos de fortuna ou azar) — the headline casino-gaming-revenue figure, in million MOP, from DSEC. This is the SAME monthly number the gaming regulator DICJ publishes as an HTML table, sourced here as clean structured data. Answers "what was Macau\'s gaming revenue in August 2026", "Macau casino revenue this month".',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'macau_population',
    description:
      "Macau's total resident population (澳門總人口 / população total de Macau), quarterly, from DSEC. Answers \"what is Macau's population\".",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'macau_tourism',
    description:
      'Macau visitor arrivals (訪澳旅客人數 / chegadas de visitantes a Macau), monthly, from DSEC — the headline tourism-volume figure. Answers "how many tourists visited Macau", "Macau visitor arrivals this month".',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'macau_employment',
    description:
      "Macau's labour-market snapshot from DSEC: overall unemployment rate, total employment and overall median monthly employment earnings (each on its own DSEC reporting cycle — unemployment/employment are rolling 3-month, earnings quarterly). Answers \"what is Macau's unemployment rate\", \"Macau employment statistics\".",
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// ── Convenience-tool ids, resolved against the live catalogue (not
// hardcoded blind) so a description change upstream can't silently point
// at the wrong series — each is verified by exact-description match below. ──
const GAMING_REVENUE_DESC = 'Gross revenue of games of chance';
const POPULATION_DESC = 'Total Population';
const VISITOR_ARRIVALS_DESC = 'Visitor arrivals';
const UNEMPLOYMENT_DESC = 'Overall unemployment rate';
const EMPLOYMENT_DESC = 'Total employment';
const EARNINGS_DESC = 'Overall median monthly employment earnings';

async function findByExactEn(catalog: TriIndicator[], desc: string): Promise<TriIndicator | null> {
  return catalog.find((r) => r.en === desc) ?? null;
}

// ── Implementations ────────────────────────────────────────────────────

async function toolIndicators(args: Record<string, unknown>) {
  const catalog = await keyIndicatorCatalog();
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const rows = query
    ? catalog.filter(
        (r) => r.en.toLowerCase().includes(query) || (r.zh && r.zh.includes(args.query as string)) || r.pt?.toLowerCase().includes(query),
      )
    : catalog;
  return {
    total: catalog.length,
    matched: rows.length,
    query: query || null,
    indicators: rows.map((r) => ({
      id: r.id,
      frequency: r.frequency,
      name: { en: r.en, zh: r.zh, pt: r.pt },
    })),
    source: 'DSEC (Macao Statistics and Census Service) TimeSeriesDatabase.asmx getKeyIndicatorList',
  };
}

async function toolIndicator(args: Record<string, unknown>) {
  const catalog = await keyIndicatorCatalog();
  const idArg = typeof args.id === 'number' ? args.id : typeof args.id === 'string' ? args.id : undefined;
  const nameArg = typeof args.name === 'string' ? args.name : undefined;
  const row = await resolveIndicator(idArg ?? nameArg, catalog);
  if (!row) {
    return {
      found: false,
      reason: 'indicator_not_recognized',
      queried: idArg ?? nameArg ?? null,
      hint: 'Call macau_indicators (optionally with a `query` keyword) to find a valid id or name from DSEC\'s 143 published key indicators.',
    };
  }
  const periods = typeof args.periods === 'number' && args.periods > 0 ? Math.floor(args.periods) : 24;
  return { found: true, ...(await buildIndicatorResult(row, periods)) };
}

async function toolGamingRevenue() {
  const catalog = await keyIndicatorCatalog();
  const row = await findByExactEn(catalog, GAMING_REVENUE_DESC);
  if (!row) throw new Error(`${UPSTREAM}: expected key indicator "${GAMING_REVENUE_DESC}" was not found in the current catalogue`);
  return buildIndicatorResult(row, 1);
}

async function toolPopulation() {
  const catalog = await keyIndicatorCatalog();
  const row = await findByExactEn(catalog, POPULATION_DESC);
  if (!row) throw new Error(`${UPSTREAM}: expected key indicator "${POPULATION_DESC}" was not found in the current catalogue`);
  return buildIndicatorResult(row, 8);
}

async function toolTourism() {
  const catalog = await keyIndicatorCatalog();
  const row = await findByExactEn(catalog, VISITOR_ARRIVALS_DESC);
  if (!row) throw new Error(`${UPSTREAM}: expected key indicator "${VISITOR_ARRIVALS_DESC}" was not found in the current catalogue`);
  return buildIndicatorResult(row, 24);
}

async function toolEmployment() {
  const catalog = await keyIndicatorCatalog();
  const [unemployment, employment, earnings] = await Promise.all(
    [UNEMPLOYMENT_DESC, EMPLOYMENT_DESC, EARNINGS_DESC].map(async (desc) => {
      const row = await findByExactEn(catalog, desc);
      if (!row) return { description: desc, found: false };
      const latest = await fetchKeyIndicatorValue(row.id);
      return { key_indicator_id: row.id, description: { en: row.en, zh: row.zh, pt: row.pt }, frequency: row.frequency, latest, found: true };
    }),
  );
  return {
    unemployment_rate: unemployment,
    total_employment: employment,
    median_monthly_earnings: earnings,
    source: 'DSEC (Macao Statistics and Census Service) TimeSeriesDatabase.asmx',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'macau_indicators':
      return toolIndicators(args);
    case 'macau_indicator':
      return toolIndicator(args);
    case 'macau_gaming_revenue':
      return toolGamingRevenue();
    case 'macau_population':
      return toolPopulation();
    case 'macau_tourism':
      return toolTourism();
    case 'macau_employment':
      return toolEmployment();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
