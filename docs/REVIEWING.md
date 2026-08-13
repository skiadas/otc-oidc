# Code review checklist

A repeatable rubric for reviewing this codebase. Use it for every pass so
nothing is left to habit. Categories are ordered roughly by how often they
surface issues here.

Sources this is distilled from: _Clean Code_ (Robert C. Martin), _Effective
TypeScript_ (Dan Vanderkam), _The Art of Readable Code_ (Boswell & Foucher),
the [Google Code Review Developer Guide], and OWASP guidance for web/auth
systems.

[Google Code Review Developer Guide]: https://google.github.io/eng-practices/review/

## Tooling pass

Run the tools before finishing any pass — they are the enforcement layer for
several of the items below: `npm run format && npm run lint && npm run
typecheck`, plus the test suite. Prettier normalizes formatting; ESLint runs the
`recommended` rules plus `curly: multi-line` (brace-less single-statement
`if`/loop bodies only when they fit on one line).

## Readability and intent

- **Naming says what the thing is**: units and scale in the name
  (`expiresAtMs`, not `expiresAt`), no vague words (`max` → `maxRequests`),
  names that a reader can trust without reading the body.
- **Single responsibility ("one thing")**: a function is describable in one
  sentence without "and", and reads at a single level of abstraction. Extract a
  step when it is independently meaningful, reused, or at a different
  abstraction level — but do **not** fragment for its own sake; a handler with
  early-return guards is still one thing.
- **Comments explain _why_, not _what_**: non-obvious behavior and security
  intent get comments; self-evident code stays bare. No stale or misleading
  comments.
- **No dead code**: unused exports, unreachable branches, parameters, and
  locals are removed (`noUnusedLocals`/`noUnusedParameters` catch most).
- **No duplicated logic or copy-paste**: the same derivation, string, or guard
  in two places is extracted to one source (e.g. `minutesFromSeconds`,
  `parseEmail`, `LOCKED_MESSAGE`).
- **Control flow is easy to scan**: early returns, guard clauses, no deep
  nesting; analogous code looks analogous (same error style, same config shape).
- **Conditions read as questions**: an opaque boolean expression gets a named
  predicate (`recordIsLocked(record)`, `isExpired(entry)`) when its meaning
  isn't obvious from the tokens. Don't name comparisons that already say what
  they mean (`length > 0`).

## TypeScript leverage

This project runs `strict` with `verbatimModuleSyntax`, `erasableSyntaxOnly`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`,
`noUnusedParameters`, and `noImplicitOverride`. Reviews should also ask what
_language features_ simplify the code:

- **Discriminated unions** for result/state types; no stringly-typed values
  where a union fits.
- **Exhaustiveness**: maps keyed by a union type (`Record<Reason, string>`),
  or `switch` with a `never` default — never an untyped `Record<string, ...>`
  indexed by a union.
- **Type predicates / `instanceof`** at untyped boundaries (library errors,
  JSON, env): prefer the real runtime binding (`instanceof errors.SessionNotFound`)
  over structural guessing — but verify the runtime export actually exists
  before relying on it.
- **`unknown` over `any`**, narrowed deliberately.
- **`satisfies`, `as const`, `Readonly`** where they encode an invariant
  (e.g. `Readonly<Config>`).
- **Destructuring** at the point of use to strip repeated `obj.field` noise —
  e.g. `const { audit, config, otc } = ctx;`, `const { params, prompt } = details;`,
  `const { db, model } = this;` in methods. Apply when a field is read more than
  once and it stays obvious which object the value came from; don't destructure a
  single-use field or when it obscures the source.
- **`import type` hygiene**; type-only imports never imported as values.
- **Untyped boundaries are deliberate**: casts are justified or validated, not
  shrugged off.

## Correctness and safety (auth service)

- **Fail fast** on misconfiguration; required values enforced in
  `loadConfig`, never silently defaulted in production.
- **No secrets** committed, logged, or echoed in responses.
- **Enumeration resistance**: responses don't reveal whether a record exists
  (e.g. missing OTC code ≡ wrong code).
- **Constant-time comparison** for secrets/codes; values hashed at rest.
- **Rate limiting, lockout, and TTL** enforced and bounded; units consistent.
- **Trust boundaries**: `X-Forwarded-For`/`trust proxy` narrowed to the real
  proxy; redirect URIs exact-match; PKCE required; cookies
  `httpOnly`/`SameSite`.
- **Input validated, output escaped** (XSS): user-supplied strings are escaped
  before entering HTML; client-supplied values are never trusted.

## Tests

- Cover the invariants that matter, not just happy paths: single-use,
  lockout/expiry, adapter index semantics, escaping, error mapping, config
  fail-fast.
- Test behavior with real artifacts where possible (e.g. real
  `errors.SessionNotFound` instances), not hand-mocked approximations.
- Tests assert behavior, not implementation.

## Operations and robustness

- Async rejection and error paths handled; nothing crashes the process on bad
  input.
- Resources cleaned up: streams, timers (`unref`), file modes for secrets.
- Restart semantics documented (in-memory state is lost by design).
