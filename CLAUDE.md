# claimcheck

A Python CLI in `src/claimcheck` and Desk, an Electron app in TypeScript, in `app/`.

## Layout
- `src/claimcheck/`: the CLI (init, onboarding, spec conversation, checker, mutation, ledger, hook, redaction, providers).
- `tests/`: Python tests. `tests/fixtures/secret_cases.json` is shared with the Desk tests, so the two redaction filters can't drift.
- `app/`: Desk, with its own tests in `app/test/`.
- `examples/`: sample spec, claims, config and ledger, used as test fixtures.

## Commands
Python 3.11+. Desk needs Node 22 (`.nvmrc`, CI).

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,claude]"
ruff check                       # lint, zero errors
mypy                             # src/ and tests/, zero errors
python -m pytest -q              # about 100 seconds
claimcheck verify-ledger         # CI runs this after the tests

cd app && npm ci
npm run typecheck                # both tsconfigs, zero errors
npm run lint                     # ESLint, zero errors or warnings
npm run build                    # main, preload and renderer into dist/
npm test                         # typecheck, lint, build, then node --test
```

Lint runs beside pytest, never inside it. `claimcheck run` uses pytest to catch planted bugs, and a lint failure would count as a catch.
The lint rules live in `pyproject.toml` (`[tool.ruff]`, `[tool.mypy]`) and `app/eslint.config.ts`. Never turn a rule off to get green; a line where a rule truly cannot apply gets an inline disable with a comment above it saying why. In Python the named-params convention is enforced by ruff's PLR0917 with `max-positional-args = 1`: one positional argument, everything after it keyword-only.

CI runs the Desk tests under `xvfb-run -a` with `ELECTRON_DISABLE_SANDBOX=1`, because one test opens a real Electron window.

## Repo rules
- Every Python file in `src/claimcheck`, plus `README.md` and `pyproject.toml`, keeps its `@author Patrick Finazzo` line. `test_ac30_attribution_everywhere` fails without it.
- Desk is TypeScript only, strict, no `any`. A test fails if hand-written JavaScript appears.
- TypeScript uses `type` aliases, not `interface`. The one exception is global declaration merging (`Window` in `globals.d.ts`).
- `claimcheck run` mutates only the Python side: `app/**` is in the config's `ignore`, and pytest doesn't run the Desk suite.
- Never run `claimcheck init` or a mutation run on a dirty tree you care about. A mutation run edits files while it works and restores them after.
- `.claimcheck/ledger.jsonl` is append-only and hash-chained. Never edit or remove a line; CI checks that it only grew.

<!-- claimcheck:begin (managed by `claimcheck init`; edits inside this block are overwritten) -->
## claimcheck

This repo uses claimcheck. Every change carries frozen acceptance criteria and a list of claims
about the diff, and an independent checker and a planted-bug test run grade them.

Before writing code for a task:
1. Run `claimcheck spec verify`. If `.claimcheck/spec.lock` is missing or does not match
   `.claimcheck/spec.md`, stop and ask the human. Do not edit `spec.md` or `spec.lock` yourself.
   If the human has no spec yet, run `claimcheck spec draft` and let them answer its questions.

With every commit that changes code:
2. Update `.claimcheck/claims.yaml`. One claim per thing you assert about the diff.
3. Give each claim a confidence between 0 and 1 that reflects how sure you actually are.
   Do not round up. Low confidence is useful information.
4. Give each claim a `kill_condition` that would prove it wrong: `test:`, `cmd:` or `obs:`.
   It must be something other than the claim restated.
5. List every changed code file in some claim's `files`, and cite criteria by number.

Before finishing:
6. Run `claimcheck run`. Report any claim that is REFUTED or has a low catch rate. Fix the tests
   or narrow the claim. Never edit the checker, the ledger or the config to make a run pass.
<!-- claimcheck:end -->

# Conventions

Patrick's coding conventions, verbatim from [my-personal-coding-conventions](https://github.com/pfinazzo/my-personal-coding-conventions) CLAUDE.md.

### Naming

- **Code reads like English.** Read each line out loud: it should say exactly what it does to someone who has never seen the codebase, the ticket, or the conversation. If a line needs a comment to explain what it does, rename things until it doesn't. Yes: `if (isEligibleForRefund({ order })) await refundOrder({ order });` No: `if (check(o)) await process(o);`
- **Name what the thing actually is.** Use the full domain concept, not the generic word (`RefundRequest`, not `Request`). If you're about to write a comment explaining what a name represents, make that comment the name.
- **The shape decides the name.** Name a thing after the properties and functions it has, not the screen or flow you were building. An object with `reason`, `requestedAmountCents` and `status` is a `RefundRequest`; one with only `items`, `totalCents` and `shippingAddress` is an `Order`, even if you made it in the refund flow.
- **Function names start with a verb that says what kind of work happens.** The prefix promises the side effects: `toX` pure transform between shapes (`toInvoice({ order })`); `buildX` construct from parts, no IO (`buildImageUrl({ imageId, width })`); `calculateX` pure computation (`calculateOrderTotalCents({ items })`); `isX`/`hasX`/`canX`/`shouldX` return a boolean; `fetchX` reads over IO; `createX`/`updateX`/`saveX`/`deleteX` write over IO; `handleX` responds to an event; `useX` is a React hook. Never vague verbs like `getOrder` (memory or network?), `processOrder` (writes?), or `handleInvoice` with no event.
- **Booleans read as questions.** Prefix with `is`, `has`, `can` or `should`, and state them positively: `isShipped`, `hasPaymentMethod`. Never `shipped`, `flag`, or a negative like `isNotDisabled`.
- **Spell it out.** No abbreviations and no filler nouns: `data`, `info`, `item`, `obj`, `temp`, `result`, `manager`, `helper`, `util`. Callback params get real names (`(order) => …`, not `(o) => …`). The one exception is `acc` in a reducer.
- **Collections are plural, lookups name their key.** `orders`, `ordersById`, `orderIdsByUserId`. Never `orderList` or `orderMap`.
- **Units go in the name.** `timeoutMs`, `totalCents`, `createdAtIso`. Never a bare `timeout` or a dollar float `total = 19.99`.
- **Casing.** camelCase for values and functions. PascalCase for models, types and React components (a lowercase component is treated as an HTML tag). SCREAMING_CASE for constants and lookup tables that never change (`MAX_RETRIES`, `STATUS_LABELS`).

### Style

- **Functional over OOP.** Plain functions and modules. No classes, no inheritance, no `this`, no instance state. Data goes in as arguments and comes out as return values. Shared state is an imported module-level singleton, not a constructed object passed around.
- **Named params, not positional.** Every function takes a single options object with named keys, even single-argument helpers: `updateOrderStatus({ orderId, status })`, never `updateOrderStatus(db, orderId, status)`.
- **Declarative over imperative.** Write key-to-behavior mappings as lookup tables, not if/else or switch ladders. Adding a case should mean adding a row. Same for status maps, plan tiers, provider names, and error code to message. Yes: `const handler = { order_created: handleOrderCreated, order_shipped: handleOrderShipped }[event.type] || DEFAULT_HANDLER; return handler({ event });`
- **Defaults come from `||`, not a branch.** Put the fallback on the same expression as the lookup, never in a following `if (!x)` block: `const label = LABELS[status] || "Unknown";`. A simple fallback value can sit inline. A fallback that is behavior becomes a named constant, and for a handler map that should never miss, make it throw or log. Use `??` when `0` or `""` is a valid result (`config.retries ?? 3`).
- **Code reads downwards, not inwards.** Use guard clauses and early returns, not nested pyramids. Two levels of indentation inside a function is the ceiling; past that, extract a named helper. Keep the happy path running straight down the left edge.
- **One ternary level.** A ternary is fine for one condition. Past one, use a lookup or a named function. Yes: `{ overnight: "Overnight", expedited: "Express" }[shippingSpeed] || "Standard"`. No: `isOvernight ? "Overnight" : isExpedited ? "Express" : "Standard"`.
- **Document functions.** In JavaScript, every exported function and every function longer than one line gets a JSDoc block: one line on what it does, `@param` for each key of the params object, and `@returns`. Name non-obvious side effects (database writes, vendor calls, cache mutation) in the description. In TypeScript, don't restate types as `@param`/`@returns`; keep the one line plus side effects and what the types can't say (units, valid ranges, what a null means, what throws). A one-line internal helper whose name already reads as English gets no block.
- **Imports at the top.** All imports and requires go at the top of the file, always. No lazy require inside a function, no conditional require, no require halfway down.
- **Imports run in one order.** Built-in modules (`node:fs`), then packages, then your own modules by path, then relative paths. When one module supplies both types and values, its `import type` line sits directly above its value line; no inline `type` in a value import.
- **One blank-line rhythm.** One blank line between top-level declarations. A doc comment touches the thing it documents, with no gap. Inside a function, a blank line separates steps, and only when there is more than one step.
- **Every file runs in one order.** Imports, then fixed values, then the types the file shares, then private helpers, each directly above its first caller, then the exports in the order a reader needs them. A lookup table with one reader sits directly above that reader, not at the top.

### Comments and writing

- **Comments sit above what they explain, and say why.** A comment gives the reason, not a restatement of the code. Every file opens with a block that says why it exists (`Why this file exists: all logging goes through here so card numbers are masked once…`, never `// Logger utilities.`). Write for the next reader, never as a changelog ("changed in review", "was X before"). When you change code under a comment, rewrite that comment instead of adding a second one.
- **No comment at the end of a line of code.** Put it on its own line above.
- **Disabled code is the one use of `//`.** Each disabled line starts with `//` so toggle-comment restores it, and a doc above it says what is hidden, why, and how to restore it.
- **Counts in comments go stale.** A count or list in a comment must match the code, or be left out: "the functions it exports", not "these five functions".
- **A comment is understood in one read.** A newcomer reading once at normal speed could explain it. Open with what it is in under about 12 words. One case per paragraph or bullet, each opening with its condition ("Normally: …", "If the request times out: …"); never blend two cases in one sentence. Short sentences, one idea each; split any sentence with more than one "and", "so", "which" or "because"; no parentheses carrying a second idea. Name who did what (the user, their browser, our server, the vendor), never a bare "it". End with what goes wrong without the code, in everyday terms ("Sending again would charge the card twice."). Plain words, never the author's shorthand. Cut what the code already says. The same rules apply to test titles, READMEs, commit messages, PR descriptions and your replies: open with the answer, one point at a time, and say plainly what was done and what wasn't.

### Functional JavaScript

- **Pure by default.** A function takes inputs as arguments and returns a value. It doesn't reach into module state, mutate what it was handed, or do IO in the middle of a transform. Push side effects (database writes, vendor calls, logging) to the edges: `const invoice = toInvoice({ order }); await saveInvoice({ invoice });`
- **Never mutate inputs.** No `push`, `splice`, `sort`, `reverse`, or property assignment on anything a function was passed. Return a new value. Copy before sorting: `[...orders].sort(byCreatedAt)`, `{ ...order, is_paid: true }`.
- **Transform with map, filter, reduce.** Never an empty array plus a loop that pushes. Use `reduce` to fold a list into one value, especially into a lookup table (`users.reduce((acc, user) => ({ ...acc, [user.id]: user }), {})`), then look up by key instead of `find` inside a loop. Same shape for grouping and counting. On genuinely large arrays (tens of thousands of rows), assign onto the accumulator instead of spreading it.
- **`const` always, effectively.** Never `var`. A `let` means a value built up in steps; replace it with `map`/`filter`/`reduce`, a lookup with a `||` default, a ternary, or named functions that return values. The only legitimate `let` is an accumulator in a genuine loop or a value assigned once inside a try/catch, and why must be obvious.
- **Arrow function consts, not `function` declarations.** `const markShipped = async ({ orderId, trackingNumber }) => { … };`
- **Name the steps, don't build one long chain.** Compose small named functions: `subscriptions.filter(isActive).map(toSummary)`. No chains of anonymous multi-condition callbacks.
- **No shared mutable module state.** Module-level constants, lookup tables, config and wrapper singletons are fine. No module-level `let` reassigned by different functions; pass state through arguments and return values.
- **Optional chaining over existence ladders.** `user?.address?.city ?? "Unknown"`, not a nested `if` chain.
- **Transforms take data, not framework objects.** A shaping function takes and returns plain objects, never `req`, `res`, or a database snapshot. Unwrap in the route handler: `createOrder(toOrderPayload({ body: req.body }))`.

### TypeScript

- **Use `type` aliases, not `interface`.** `extends` becomes `&` (`type ShippedOrder = Order & { trackingNumber: string }`). The one exception is a global declaration that only works by merging into a built-in, such as adding a field to `Window`.
- **Primitives, never boxed types.** `number`, `string`, `boolean`. Never `Number`, `String`, `Boolean` or `Object`; for "some object" use `object` or a real type.
- **No `any`. Use `unknown` and narrow.** Never `as any`, `@ts-ignore`, or a `value!` assertion. Assign `response.json()` to `unknown` immediately so a parser must prove its shape: `const json: unknown = await response.json(); const orders = parseOrderListResponse({ json });`
- **Callbacks return `void` and take required parameters.** `type OnOrderChange = (order: Order) => void;`, never `(order?: Order) => any`.
- **No overloads.** Use unions and optional parameters in one signature. No unused generic parameters.
- **String literal unions, not `enum`.** Derive the type from an `as const` array so the type and runtime list can't disagree, and check lookup tables for completeness with `satisfies`: `export const ORDER_STATUSES = ["pending", "shipped"] as const; export type OrderStatus = (typeof ORDER_STATUSES)[number]; const ORDER_STATUS_LABELS = { pending: "Pending", shipped: "Shipped" } satisfies Record<OrderStatus, string>;`
- **Discriminated unions for anything with states.** One `status` field; data that exists in one state lives only in that branch: `{ status: "loading" } | { status: "ready"; orders: readonly Order[] } | { status: "error"; message: string }`. Never `{ isLoading: boolean; orders?: Order[]; error?: string }`.
- **`readonly` on anything that crosses a function boundary.** Arrays and object fields in domain types are `readonly`, so a mutation fails to compile.
- **Types live in one place.** Domain types in one module, raw API types beside the wrapper that receives them. No file declares its own copy of a domain type. Use framework-generated types instead of hand-written ones.
- **Rules that can be config are config.** Keep `strict: true` and add `noUncheckedIndexedAccess`. ESLint: `@typescript-eslint/no-explicit-any` (error), `no-floating-promises`, `no-unnecessary-condition`, `switch-exhaustiveness-check`, `consistent-type-imports`. Prose is only for rules a linter can't check.

### Modules

- **Named exports, not default exports.** The import name matches the definition: `export const toInvoice = …; import { toInvoice } from "../lib/invoices";`. Default exports only where a framework requires them (e.g. Next.js pages).
- **One concern per file, named after it.** Route handlers stay thin: validate, call, respond. The work lives in `lib/`, named by domain (`lib/invoices.js`, `lib/shipping.js`). Env reads and vendor wrappers live in `config/`. Never `utils.js`, `helpers.js` or `common.js`.
- **Don't generalize for two of anything.** Two screens don't justify a generic table component or data-loading abstraction. Write two plain pieces of code.

### Third party services

- **Always go through a wrapper.** Never import a vendor SDK in feature code. Each external service gets one wrapper module (e.g. `config/payments.js`) and everything imports that: `await payments.refund({ chargeId })`. If a service has no wrapper yet, add one.
- **Don't pass shared singletons as params.** A helper that needs the database client requires it itself; never `saveInvoice({ db, invoice })`.

### Database writes

- **Scope every write to the record it changes.** `db.update({ path: \`orders/${orderId}\`, value })`, never a root-level or table-wide multi-path update to change one record. Existing broad writes are not license to add new ones. This applies to one-off scripts too.

### Error handling

- **Throw for broken, return empty for absent.** A missing record returns `null` or `[]`. A broken invariant, failed vendor call or bad input throws. Never return `{ error: "…" }` sentinel objects.
- **Never swallow.** No empty `catch`, no catch that logs and continues. Either recover meaningfully, or add context and rethrow: `throw new Error(\`Failed to refund charge ${chargeId}: ${error.message}\`, { cause: error })`.
- **Catch at the boundary, not everywhere.** Helpers let errors bubble. The route handler is the one try/catch per request path, where an error becomes a status code. A 500 body says what failed in the user's terms ("Could not ship this order"), never `error.message`. A 400 says exactly which field was wrong.
- **Error reporting happens at the boundary too.** Wire Sentry (or equivalent) once at the route and process level. No `captureException` in helpers that rethrow.
- **Error messages name the thing.** Include the id, the operation and the vendor: `Failed to refund charge ch_123 in Stripe`, never `Request failed`. Never put a token, key, cookie value, or full user record in a message.
- **Three kinds of failure, three responses.** Expected (validation, a vendor's 400): 400 naming the field, and keep the user's input. Unexpected (5xx, network, parse): 502 with a plain message that says the outcome is unknown when a write may have happened, logged with the request id. Stale (data changed since load): re-validate on the server against fresh data and return a specific message.
- **Every state the user can land in has a face.** Design loading, empty, error (with a retry), success and partial success.
- **Say what actually happened.** If a vendor says "pending", the user sees "submitted", not "done". Show values from a refetch, not local arithmetic.

### Async

- **`await`, not `.then`.** No mixing the two in one function, no promise chains as control flow, no `.then().catch()` where a try/catch belongs.
- **Run independent work in parallel (technically concurrently).** `const [user, orders] = await Promise.all([fetchUser({ userId }), fetchOrders({ userId })]);`, never sequential awaits that don't depend on each other.
- **Never `await` inside a loop over a collection.** `await Promise.all(orderIds.map((orderId) => fetchOrder({ orderId })))`. For a rate limit, batch in chunks instead of a serial loop. Use `Promise.allSettled` when one failure shouldn't kill the batch, and handle rejected entries explicitly.
- **No floating promises.** Await every promise. Deliberate fire-and-forget says so at the call site and attaches a `.catch` that logs.
- **Timeouts on every network call.** `fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })`.
- **Don't double-submit.** Keep one in-flight flag while a write is pending; the handler returns early while it's set.
- **`async` only if it awaits.** A function that awaits nothing doesn't get the keyword.

### Boundary validation

- **Validate once at the edge, then trust the shape inward.** Route handlers and webhook receivers check and coerce; everything below assumes the right shape and doesn't re-check.
- **Webhook payloads are untrusted input.** Verify the signature or shared secret first (401 if invalid), read only the fields you need, look up the user from a provider id instead of trusting a user id in the body, and never pass a raw webhook body into a write.
- **Coerce at the edge, don't defensively coerce everywhere.** One `Number()`, `String()` or date parse at the boundary (`Number(req.query.limit) || DEFAULT_LIMIT`). Downstream helpers never re-parse.
- **Fail fast and specifically.** Return 400 naming the field: `{ error: "productId is required" }`, `{ error: "items must be an array" }`.
- **Never interpolate unvalidated input into a path or query.** Check the id shape first: `/^[A-Za-z0-9_-]+$/`, 400 on a miss.
- **The server re-validates against fresh data.** Validate on the client for feedback and on the server for truth, with the same function.
- **Read only the fields you need.** Ignore extra fields in a response. A missing required field is an error at the parser.

### Idempotency

- **Webhooks arrive more than once. Dedupe by event id.** Claim the event id before acting (insert if absent), return 200 on a duplicate, and release the claim if handling fails so the retry can run.
- **Writes are safe to run twice.** Set final values instead of incrementing or appending blind. Key records by a natural id: `db.set({ path: \`invoices/${orderId}\`, value })`, never `db.push` or `count + 1`.
- **Pass idempotency keys to vendors that accept them.** Build the key from the operation so a retry sends the same key: `idempotencyKey: \`order-${orderId}-charge\``. Never omit it, never `randomUUID()`.
- **Only retry what's idempotent.** Retry reads and keyed writes. Never retry a call that isn't safe to repeat and has no key (e.g. sending an email).

### Money and numbers

- **Money is integer cents.** Store, compute and send cents, with the unit in the name (`priceCents`). Never floats.
- **Format at display, nowhere else.** Cents stay cents until rendered: `new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100)`. Never `(totalCents / 100).toFixed(2)` mid-pipeline. Pass an explicit locale to every formatter.
- **Amounts travel with their currency.** `{ amountCents: 1999, currency: "USD" }`.
- **Round once, in cents, on purpose.** `Math.round(subtotalCents * DISCOUNT_RATE)`, one rounding step.

### Dates and time

- **UTC everywhere except the screen.** Servers, databases and logs use UTC (`new Date().toISOString()`). Convert to the user's zone only when rendering. Never `toLocaleString()` on the server.
- **Store ISO strings or epoch ms, and name which.** `createdAtIso`, `expiresAtMs`. Never ambiguous formats or seconds.
- **Convert in one place.** One display formatter (e.g. `formatDateForUser({ iso, timeZone })` in `lib/dates`), not date calls scattered through components.
- **Never parse ambiguous strings.** Accept only ISO 8601 at the boundary and reject anything else with a 400. Never `new Date("09/12/2026")`.
- **Calendar boundaries are timezone decisions.** Pick the zone explicitly for "today", "this week" and "this month": `startOfMonth({ date: now, timeZone: "UTC" })`.

### Config and secrets

- **One secrets manager is the source of truth.** Add and change secrets there (Doppler, Vault, whatever the project uses) and sync them to the host. Never set them by hand on the host, commit a `.env` with real values, or put secrets in code.
- **`process.env` is read in `config/` only.** Feature code imports from `config/`.
- **Fail loudly at boot on a missing required secret.** `if (!PAYMENTS_API_KEY) throw new Error("PAYMENTS_API_KEY is not set");` in the wrapper.
- **A value that never changes is a constant, not an env var.** `const DOCS_URL = "https://docs.example.com";`, no fallback chains.
- **Never log or return secrets.** No keys, tokens, service account JSON or cookie values in logs, error messages or API responses.

### React

- **Derive during render, don't sync with an effect.** Compute values from props or state directly; never `useEffect` + `setState` to mirror them.
- **Effects are for side effects.** Subscriptions, timers, the DOM, syncing with something outside React. Responses to user actions go in the handler.
- **Components take named props, like functions take named params.** Destructure in the signature. PascalCase noun components, `onX` event props, `handleX` handlers: `<OrderSummary order={order} onCancel={handleCancelOrder} />`.
- **Lookups over ternaries in JSX.** `STATUS_BADGES[order.status] || <Badge>Unknown</Badge>`, never chained ternaries.
- **Split at the nesting ceiling.** A map inside a map, or conditionals two levels deep, becomes a named component.
- **Keys are stable ids, never the index.** `key={order.id}`.

### Markup and CSS

- **Semantic elements first, `div` last.** `header`, `nav`, `main`, `section` with a heading, `ul`/`li`, `dl` for label-value pairs, `form`, `label`, `button type="submit"`, `dialog`. `div` is for layout only.
- **One heading hierarchy.** One `h1` per view, no skipped levels. Choose the tag for meaning; size it with CSS.
- **Design tokens only.** Every color, spacing, radius and font size comes from the token file (`var(--space-4)`), never raw hex or pixel values.
- **State classes start with `is-`.** `.is-inactive`, `.is-invalid`.
- **Layout with flex or grid plus `gap`.** The parent spaces its children; no per-element margins. Mobile first: the base rule is the phone layout, and a `min-width` media query adds the wide one.
- **Digits line up.** `font-variant-numeric: tabular-nums` wherever numbers stack in a column.
- **Respect `prefers-reduced-motion`.** Skip transitions when it's set.

### Accessibility

- **Every control has a real label.** `<label for>` paired with an `id`. Never a placeholder as the label.
- **Errors are announced and attached.** Field errors sit in an element referenced by the control's `aria-describedby`, and the control gets `aria-invalid="true"`. Messages that appear after submit live in an `aria-live="polite"` region.
- **Everything works from the keyboard.** Buttons are `<button>`, links are `<a href>`, no clickable divs. A dialog traps focus while open, closes on Escape, and returns focus to what opened it. A not-ready button uses `aria-disabled="true"` plus a click guard, not `disabled`, so keyboard users can reach it and hear why.
- **Visible focus, always.** Never `outline: none` without a `:focus-visible` replacement at least as visible.
- **Status is never color alone.** Pair color with text or a sign (a "Paused" pill, a minus sign on negative amounts). Decorative icons get `aria-hidden="true"`.
- **Text meets WCAG AA contrast.** 4.5:1 for normal text, 3:1 only for large text, measured against the actual background.
- **Run the checkers.** Treat accessibility lint warnings as errors, and run an automated checker such as axe on every view.

### Testing

- **Pure functions get plain tests.** Input in, assert the output, no mocks or setup.
- **Side effects get tested by stubbing the wrapper.** `jest.mock("../config/payments")`, never the vendor SDK (`jest.mock("stripe")`).
- **Test behavior, not implementation.** Assert outputs or writes, not which internal helper ran (`toHaveBeenCalledTimes` on your own function).
- **Don't mock your own modules.** Mock the edges (`../config/db`), run your own code (`../lib/invoices`) for real.
- **Test names read like English.** `"skips a webhook event it has already processed"`, never `"webhook test 2"`.
- **One command verifies everything.** Typecheck, lint and every test suite run from one script, green before every commit.

### Scope of changes

- **Change only what the task requires.** No refactoring adjacent code, hoisting variables, tidying nearby lines, or fixing pre-existing bugs found along the way. An additive change shows zero removed lines in `git diff --stat`. Report a real bug next door as its own task.
- **Simplest thing that works.** A value that never changes is a hardcoded constant (`DEFAULT_PAGE_SIZE = 50`). No env fallback chains, request-derived plumbing, or new params to thread it through. Add abstraction when the value actually varies.
- **"Remove this button" means comment it out.** Comment out the JSX with a short "uncomment to restore" note, and keep the handlers, state, prop plumbing, CSS and imports. Delete supporting code only when explicitly asked.
- **Add a dependency only when it replaces more code than it adds.** Nothing the platform already covers: `Intl` for formatting, `<dialog>` for modals, `fetch` with `AbortSignal` for timeouts.

### Commits and docs

- **Commits read like a changelog.** Small, one concern each, imperative subject under 72 characters, a body that says why when it isn't obvious.
- **Docs change in the same pull request as the code.** A PR that changes behavior while the README describes the old behavior isn't finished.
- **Record decisions with their reasons.** What was chosen, what else was considered, why this one, and what would change the answer. Link each to the line of code that carries it out; with no line to link, it hasn't reached the code.
- **Arrange a README from the outside in.** What it does, how to run it (prerequisites with exact versions), how it works, where the code is, why it's built this way, then quality (security, accessibility, testing). Write for someone who has never seen the repo.
- **One diagram per mechanism, each followed by how to read it.** Plain-English labels, code names in parentheses only where they help. Number the steps so the walkthrough can point at one. Explain only the parts that take thought.
- **Keep diagrams readable.** Flow left to right with a few words per box. Sentences go in a table under the chart, matched to the box. Split a tangled chart into two.
- **Collapse reference material, never diagrams.** Long tables and rule lists go in a `<details>` toggle with a one-line summary. Diagrams and anything a quick reader must see stay visible.
- **Restructuring moves text, it doesn't remove it.** Removing a detail is its own named change.
- **Render every diagram before pushing.** In Mermaid, keep semicolons out of labels, even inside quotes.
- **Every claim in the prose matches the picture.** If a sentence doesn't fit every arrow in the diagram, cut the sentence.
- **Run the plain-English pass after every edit.** Before the PR, check changed sections for stacked fragments, tacked-on negations, and flourishes in place of plain words.
