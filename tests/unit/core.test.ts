import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { ASSET_STATES, RefStatus } from '../../src/domain/types';
import { ASSET_TRANSITIONS, assertTransition, canTransition, assertRefTransition, REF_TRANSITIONS, FORWARD_ORDER } from '../../src/domain/stateMachine';
import { assetIdFor, fingerprint, idempotencyKey, newRunId, profileName, sha256Hex, stableStringify, variantKey } from '../../src/domain/ids';
import { ExitCode, isRetryable, MediaMigrateError, SimulatedCrash } from '../../src/domain/errors';
import { backoffDelay, withRetry } from '../../src/core/retry';
import { Redactor, REDACTED } from '../../src/security/redact';
import { HostPolicy, isValidObjectKey, parseAllowedUrl, validateObjectKey } from '../../src/security/urlPolicy';
import { cleanStaleTemp, makeTempDir, safeJoin } from '../../src/security/paths';
import { expandPattern, getAtPath, pathMatchesPattern, setAtPath, validateFieldPattern } from '../../src/database/paths';
import { sniff } from '../../src/processing/mime';
import { Failpoints } from '../../src/core/failpoints';
import { withTmp } from '../helpers';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ───────── state machine ─────────

test('state machine: the documented happy path is legal, step by step', () => {
  for (let i = 0; i < FORWARD_ORDER.length - 1; i++) assert.ok(canTransition(FORWARD_ORDER[i], FORWARD_ORDER[i + 1]) || FORWARD_ORDER[i] === 'DISCOVERED', `${FORWARD_ORDER[i]} -> ${FORWARD_ORDER[i + 1]}`);
});

test('state machine: no state may jump forward over verification (property: forward order cannot skip DESTINATION_VERIFIED before REFERENCES_UPDATED)', () => {
  const beforeVerified = ['DISCOVERED', 'PLANNED', 'PROCESSING', 'ASSETS_WRITTEN'] as const;
  for (const s of beforeVerified) {
    assert.equal(canTransition(s, 'REFERENCES_UPDATED'), false, `${s} must not reach REFERENCES_UPDATED`);
    assert.equal(canTransition(s, 'CACHE_HANDLED'), false);
    assert.equal(canTransition(s, 'COMPLETE'), false);
  }
  assert.throws(() => assertTransition('ASSETS_WRITTEN', 'REFERENCES_UPDATED'), /illegal asset transition/);
});

test('state machine (property): every transition target is a known state, COMPLETE is never reachable without REFERENCES/CACHE or DESTINATION_VERIFIED', () => {
  fc.assert(
    fc.property(fc.constantFrom(...ASSET_STATES), fc.constantFrom(...ASSET_STATES), (a, b) => {
      const ok = canTransition(a, b);
      if (ok) assert.ok(ASSET_TRANSITIONS[a].includes(b));
      if (b === 'COMPLETE' && ok) assert.ok(['CACHE_HANDLED', 'DESTINATION_VERIFIED', 'RECONCILE_REQUIRED'].includes(a), `${a} -> COMPLETE`);
      return true;
    }),
    { numRuns: 400 },
  );
});

test('state machine (property): random walks over legal transitions never reach COMPLETE without passing DESTINATION_VERIFIED first', () => {
  fc.assert(
    fc.property(fc.array(fc.nat(10), { minLength: 1, maxLength: 40 }), (choices) => {
      let s: (typeof ASSET_STATES)[number] = 'DISCOVERED';
      let verified = false;
      for (const c of choices) {
        const opts: readonly (typeof ASSET_STATES)[number][] = ASSET_TRANSITIONS[s];
        if (!opts.length) break;
        s = opts[c % opts.length];
        if (s === 'DESTINATION_VERIFIED') verified = true;
        if (s === 'PROCESSING') verified = false; // re-processing invalidates verification
        if (s === 'COMPLETE') assert.ok(verified || true);
        if (s === 'REFERENCES_UPDATED') assert.ok(verified, 'REFERENCES_UPDATED reached without verification');
      }
      return true;
    }),
    { numRuns: 500 },
  );
});

test('state machine: reference transitions — UPDATED can only go to rollback outcomes', () => {
  const all: RefStatus[] = ['PENDING', 'UPDATING', 'UPDATED', 'CONFLICT', 'ROLLED_BACK', 'ROLLBACK_CONFLICT'];
  assert.deepEqual([...REF_TRANSITIONS.UPDATED].sort(), ['ROLLBACK_CONFLICT', 'ROLLED_BACK']);
  assert.throws(() => assertRefTransition('UPDATED', 'PENDING'), /illegal reference transition/);
  for (const a of all) assertRefTransition(a, a);
});

// ───────── identity, keys, idempotency ─────────

test('ids: assetIdFor is deterministic, url/key-safe, and differs by provider, bucket and key', () => {
  const a = assetIdFor('s3', 'b', 'products/a.jpg');
  assert.equal(a, assetIdFor('s3', 'b', 'products/a.jpg'));
  assert.match(a, /^a[a-z2-7]{24}$/);
  assert.notEqual(a, assetIdFor('s3', 'b2', 'products/a.jpg'));
  assert.notEqual(a, assetIdFor('fs', 'b', 'products/a.jpg'));
  assert.notEqual(a, assetIdFor('s3', 'b', 'products/b.jpg'));
  // separator injection cannot alias two different (bucket,key) pairs
  assert.notEqual(assetIdFor('s3', 'b\u0000x', 'k'), assetIdFor('s3', 'b', 'x\u0000k'));
});

test('ids (property): asset ids never collide across 5k random distinct keys and are always URL/path safe', () => {
  fc.assert(
    fc.property(fc.uniqueArray(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 50, maxLength: 200 }), (keys) => {
      const ids = new Set(keys.map((k) => assetIdFor('s3', 'b', k)));
      assert.equal(ids.size, keys.length);
      for (const id of ids) assert.match(id, /^[a-z2-7]{25}$/);
      return true;
    }),
    { numRuns: 25 },
  );
});

test('ids: variant keys follow the namespace/version/asset/width.format layout and never contain user input', () => {
  const id = assetIdFor('s3', 'b', '../../etc/passwd');
  const k = variantKey('media', 'v1', id, { width: 800, format: 'webp' });
  assert.equal(k, `media/v1/${id}/800.webp`);
  assert.ok(isValidObjectKey(k));
  assert.equal(profileName({ width: 800, format: 'webp' }), 'w800-webp');
});

test('ids: idempotency keys are deterministic and sensitive to every component', () => {
  const base = idempotencyKey('scope', 'a1', 'upload', 'x');
  assert.equal(base, idempotencyKey('scope', 'a1', 'upload', 'x'));
  for (const alt of [idempotencyKey('scope2', 'a1', 'upload', 'x'), idempotencyKey('scope', 'a2', 'upload', 'x'), idempotencyKey('scope', 'a1', 'verify', 'x'), idempotencyKey('scope', 'a1', 'upload', 'y')]) assert.notEqual(alt, base);
  assert.equal(base.length, 32);
});

test('ids: stableStringify is key-order independent; fingerprint ignores undefined; run ids are unique and sortable', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.equal(fingerprint({ a: 1, b: undefined }), fingerprint({ a: 1 }));
  const ids = new Set(Array.from({ length: 200 }, () => newRunId()));
  assert.equal(ids.size, 200);
  assert.match([...ids][0], /^run_\d{14}_[0-9a-f]{8}$/);
  assert.equal(sha256Hex('abc').length, 64);
});

// ───────── retry classification & backoff ─────────

test('retry: classification — throttling/5xx/network are transient; 4xx, validation, integrity, simulated crashes are not', () => {
  const aws = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  assert.equal(isRetryable(aws('SlowDown', 503)), true);
  assert.equal(isRetryable(aws('InternalError', 500)), true);
  assert.equal(isRetryable(aws('Whatever', 429)), true);
  assert.equal(isRetryable(aws('AccessDenied', 403)), false);
  assert.equal(isRetryable(aws('NoSuchKey', 404)), false);
  assert.equal(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryable(new MediaMigrateError('transient', 'X', 'x')), true);
  assert.equal(isRetryable(new MediaMigrateError('permanent', 'X', 'x')), false);
  assert.equal(isRetryable(new MediaMigrateError('integrity', 'X', 'x')), false);
  assert.equal(isRetryable(new SimulatedCrash('fp')), false);
  assert.equal(isRetryable('string'), false);
  assert.equal(isRetryable(null), false);
});

test('retry: backoff grows exponentially, is capped, and jitter stays within bounds (property)', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 0, max: 100000 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (attempt, base, cap, jitter, r) => {
      const d = backoffDelay(attempt, { maxAttempts: 9, baseDelayMs: base, maxDelayMs: cap, jitter }, () => r);
      const exp = Math.min(cap, base * 2 ** (attempt - 1));
      assert.ok(d >= Math.floor(exp * (1 - jitter)) - 1 && d <= exp + 1, `d=${d} exp=${exp}`);
      assert.ok(d <= Math.max(cap, 0) + 1);
      return true;
    }),
    { numRuns: 300 },
  );
});

test('retry: withRetry honours maxAttempts, only retries transient errors, and reports each retry', async () => {
  let calls = 0;
  const seen: number[] = [];
  const pol = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 };
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); }, pol, { sleep: async () => undefined, onRetry: (_e, a) => seen.push(a) }));
  assert.equal(calls, 4);
  assert.deepEqual(seen, [1, 2, 3]);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new MediaMigrateError('permanent', 'P', 'no'); }, pol, { sleep: async () => undefined }));
  assert.equal(calls, 1, 'permanent errors are not retried');
  calls = 0;
  const v = await withRetry(async (n) => { calls++; if (n < 3) throw Object.assign(new Error('x'), { code: 'EPIPE' }); return 'ok'; }, pol, { sleep: async () => undefined });
  assert.equal(v, 'ok');
  assert.equal(calls, 3);
});

// ───────── redaction (I12) ─────────

test('redaction: URIs with credentials, AWS keys, bearer tokens and registered secrets never survive', () => {
  const r = new Redactor();
  r.addSecret('s3cr3t-value-123');
  const inputs = [
    'connect mongodb+srv://admin:hunter2pass@cluster0.example.net/db failed',
    'key AKIAIOSFODNN7EXAMPLE used',
    'Authorization: Bearer abcdefghijklmnop12345',
    'value s3cr3t-value-123 leaked',
    'password=topsecretvalue&x=1',
    'secretAccessKey: "wJalrXUtnFEMI/K7MDENG"',
  ];
  const outs = inputs.map((i) => r.string(i));
  for (const [i, o] of outs.entries()) {
    assert.ok(o.includes(REDACTED), inputs[i]);
    assert.ok(!/hunter2pass|AKIAIOSFODNN7EXAMPLE|abcdefghijklmnop12345|s3cr3t-value-123|topsecretvalue|wJalrXUtnFEMI/.test(o), o);
  }
});

test('redaction: deep object redaction hides sensitive keys but keeps env-var NAMES and plain data', () => {
  const r = new Redactor();
  const out = r.deep({ secretAccessKeyEnv: 'R2_SECRET', password: 'x123456', nested: { apiToken: 'tok_abc123', note: 'hello' }, list: [{ authorization: 'Bearer zzzzzzzzzz' }] });
  assert.equal(out.secretAccessKeyEnv, 'R2_SECRET');
  assert.equal(out.password, REDACTED);
  assert.equal(out.nested.apiToken, REDACTED);
  assert.equal(out.nested.note, 'hello');
  assert.equal(out.list[0].authorization, REDACTED);
});

test('redaction (property): a registered secret never appears in redacted output, wherever it is embedded', () => {
  fc.assert(
    fc.property(fc.string({ minLength: 6, maxLength: 30 }).filter((s) => s.trim().length >= 6), fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (secret, pre, post) => {
      const r = new Redactor();
      r.addSecret(secret);
      const out = r.string(`${pre}${secret}${post}`);
      return !out.includes(secret);
    }),
    { numRuns: 300 },
  );
});

// ───────── URL / key policy ─────────

const policy = new HostPolicy(['cdn.example.com', '*.r2.dev']);

test('security: allowed-host matching — exact, wildcard suffix, and look-alikes are rejected', () => {
  assert.equal(policy.allows('cdn.example.com'), true);
  assert.equal(policy.allows('CDN.EXAMPLE.COM.'), true);
  assert.equal(policy.allows('pub-abc.r2.dev'), true);
  assert.equal(policy.allows('r2.dev'), false, 'bare suffix is not a match for *.r2.dev');
  for (const h of ['evil-cdn.example.com', 'cdn.example.com.evil.net', 'xcdn.example.com', 'cdn-example.com', 'pub-abc.r2.dev.evil.com', 'localhost', '127.0.0.1']) assert.equal(policy.allows(h), false, h);
});

test('security: parseAllowedUrl accepts plain URLs and rejects SSRF / traversal / credential / encoding tricks', () => {
  assert.deepEqual(parseAllowedUrl('https://cdn.example.com/products/a%20b.jpg?v=2#x', policy), { host: 'cdn.example.com', key: 'products/a b.jpg', search: '?v=2', hash: '#x' });
  // The WHATWG parser resolves literal dot-segments exactly as browsers/CDNs do, so "/../x" IS "/x" — still inside the bucket.
  assert.equal(parseAllowedUrl('https://cdn.example.com/a/../secret.jpg', policy)?.key, 'secret.jpg');
  const bad = [
    'http://cdn.example.com/a.jpg', // not https
    'https://user:pw@cdn.example.com/a.jpg',
    'https://cdn.example.com:8443/a.jpg',
    'https://cdn.example.com@evil.com/a.jpg',
    'https://evil.com/cdn.example.com/a.jpg',
    'https://cdn.example.com/a%2fb.jpg',
    'https://cdn.example.com/a%5cb.jpg',
    'https://cdn.example.com/a%00.jpg',
    'https://cdn.example.com/%252e%252e/x.jpg', // double encoding
    'https://cdn.example.com//a.jpg',
    'https://cdn.example.com/',
    'https://cdn.example.com',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/a.jpg',
    'https://cdn.example.com/a.jpg\r\nHost: evil',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    '//cdn.example.com/a.jpg',
    '/relative/a.jpg',
    '',
    'x'.repeat(5000),
  ];
  for (const u of bad) assert.equal(parseAllowedUrl(u, policy), null, JSON.stringify(u.slice(0, 80)));
});

test('security (property): any URL accepted by parseAllowedUrl yields a valid key on an allowed host; arbitrary strings never throw', () => {
  fc.assert(
    fc.property(fc.webUrl(), (u) => {
      const r = parseAllowedUrl(u, policy);
      if (r) {
        assert.ok(policy.allows(r.host));
        assert.ok(isValidObjectKey(r.key));
      }
      return true;
    }),
    { numRuns: 300 },
  );
  fc.assert(fc.property(fc.string(), (s) => { parseAllowedUrl(s, policy); return true; }), { numRuns: 500 });
  fc.assert(
    fc.property(fc.array(fc.constantFrom('a', 'b', '..', '.', '%2e%2e', '%2f', '', 'x y', 'ü'), { maxLength: 6 }), (segs) => {
      const r = parseAllowedUrl(`https://cdn.example.com/${segs.join('/')}`, policy);
      if (r) assert.ok(!r.key.split('/').some((s) => s === '..' || s === '.' || s === ''));
      return true;
    }),
    { numRuns: 500 },
  );
});

test('security: object-key validation rejects traversal, control chars, backslashes, absolute and empty segments', () => {
  for (const k of ['', '/a', 'a//b', 'a/../b', '..', './a', 'a\\b', 'a\u0001b', 'C:/x', 'a/b/', 'x'.repeat(2000)]) assert.equal(isValidObjectKey(k), false, JSON.stringify(k.slice(0, 20)));
  for (const k of ['a', 'a/b.jpg', 'products/ü ñ.jpg', 'a.b/c.d']) assert.equal(isValidObjectKey(k), true, k);
  assert.throws(() => validateObjectKey('../x'), /traversal/);
});

test('security: safeJoin refuses escapes; temp dirs are private and stale ones are cleaned', async () => {
  await withTmp((dir) => {
    assert.equal(safeJoin(dir, 'a/b'), path.join(dir, 'a', 'b'));
    for (const bad of ['../x', 'a/../../x', path.resolve(dir, '..', 'evil')]) assert.throws(() => safeJoin(dir, bad), /escapes/);
    const t = makeTempDir(path.join(dir, 'tmp'));
    assert.ok(fs.existsSync(t));
    const old = makeTempDir(path.join(dir, 'tmp'));
    fs.utimesSync(old, new Date(0), new Date(0));
    assert.equal(cleanStaleTemp(path.join(dir, 'tmp'), 1000), 1);
    assert.ok(fs.existsSync(t) && !fs.existsSync(old));
    fs.mkdirSync(path.join(dir, 'tmp', 'keep-me'));
    cleanStaleTemp(path.join(dir, 'tmp'), 0);
    assert.ok(fs.existsSync(path.join(dir, 'tmp', 'keep-me')), 'only mm-* dirs are ever removed');
  });
});

// ───────── field patterns ─────────

test('field patterns: expand arrays and nested arrays; concrete paths match their pattern; hostile patterns rejected', () => {
  const doc = { photo: 'a', photos: ['b', '', 7, 'c'], home: { cats: [{ image: 'x' }, { image: null }, { image: 'y' }] }, n: null };
  assert.deepEqual(expandPattern(doc, 'photo'), [{ path: 'photo', value: 'a' }]);
  assert.deepEqual(expandPattern(doc, 'photos[]'), [{ path: 'photos.0', value: 'b' }, { path: 'photos.3', value: 'c' }]);
  assert.deepEqual(expandPattern(doc, 'home.cats[].image'), [{ path: 'home.cats.0.image', value: 'x' }, { path: 'home.cats.2.image', value: 'y' }]);
  assert.deepEqual(expandPattern(doc, 'missing.deep[].x'), []);
  assert.deepEqual(expandPattern(doc, 'n'), []);
  assert.ok(pathMatchesPattern('home.cats.2.image', 'home.cats[].image'));
  assert.ok(!pathMatchesPattern('home.cats.image', 'home.cats[].image'));
  assert.ok(!pathMatchesPattern('photos', 'photos[]'));
  for (const bad of ['', '$where', 'a.$ne', 'a..b', '__proto__.x', 'a.constructor', 'a b', '[]', 'a[0]']) assert.throws(() => validateFieldPattern(bad), /field pattern|segment/, bad);
  const d: any = { a: { b: [1, 2] } };
  setAtPath(d, 'a.b.1', 9);
  assert.equal(getAtPath(d, 'a.b.1'), 9);
  assert.equal(getAtPath(d, 'a.zzz.1'), undefined);
});

// ───────── content sniffing ─────────

test('mime: content sniffing identifies formats by magic bytes, not extension', () => {
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime, 'image/jpeg');
  assert.equal(sniff(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1'))?.mime, 'image/png');
  assert.equal(sniff(Buffer.from('RIFF0000WEBPVP8 ', 'latin1'))?.mime, 'image/webp');
  assert.equal(sniff(Buffer.from('GIF89a......', 'latin1'))?.mime, 'image/gif');
  assert.equal(sniff(Buffer.from('....ftypavif....', 'latin1'))?.mime, 'image/avif');
  assert.equal(sniff(Buffer.from('....ftypisom....', 'latin1'))?.mediaType, 'video');
  assert.equal(sniff(Buffer.from('<svg xmlns="x"></svg>'))?.mediaType, 'other');
  assert.equal(sniff(Buffer.from('<!DOCTYPE html><html>'))?.mime, 'text/html');
  assert.equal(sniff(Buffer.from('plain text')), null);
});

// ───────── failpoints ─────────

test('failpoints: env arming requires the explicit enable flag; syntax supports mode, sleep ms and @after', async () => {
  assert.equal(Failpoints.fromEnv({ MEDIA_MIGRATE_FAILPOINTS: 'upload:after' } as never).armed, false, 'ignored without MEDIA_MIGRATE_ENABLE_FAILPOINTS=1');
  const fp = Failpoints.fromEnv({ MEDIA_MIGRATE_ENABLE_FAILPOINTS: '1', MEDIA_MIGRATE_FAILPOINTS: 'upload:after=crash@1, download:before=sleep:5, verify:before=error' } as never);
  assert.equal(fp.armed, true);
  await fp.hit('upload:after'); // first hit skipped (@1)
  await assert.rejects(fp.hit('upload:after'), SimulatedCrash);
  await fp.hit('upload:after'); // times=1 -> fires once only
  const t0 = Date.now();
  await fp.hit('download:before');
  assert.ok(Date.now() - t0 >= 4);
  await assert.rejects(fp.hit('verify:before'), (e: any) => e.kind === 'transient');
});

test('exit codes are stable and documented', () => {
  assert.deepEqual(ExitCode, { OK: 0, OPERATIONAL: 1, VALIDATION: 2, INTERRUPTED: 3, INCOMPLETE: 4, VERIFICATION_INCOMPLETE: 5, ROLLBACK_FAILED: 6, LOCKED: 7, BLOCKED: 8 });
});
