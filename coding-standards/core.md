# Coding standards

How I want code written in Python, TypeScript, and Rust. Read this file, then the file for the language you are touching (`python.md`, `typescript.md`, `rust.md`). Review the finished diff against both before calling the work done.

## Priority

When rules pull in different directions:

1. Correctness, safety, and debuggability.
2. The repository's own rules: its `AGENTS.md`, lint config, and type-checker settings.
3. These standards, for all new code and for the full behavior you refactor.
4. Surrounding conventions, when they don't contradict these standards.
5. Leave unrelated code alone. Contain an incompatible old pattern at the nearest boundary instead of copying it into new code or rewriting the system around it.

## The goal: code a reader can follow

Readability is the work a reader must do to understand the code. Measure it on two axes:

- **Layers to trace:** how many hops between the question ("where does this value come from?") and the answer.
- **State to hold:** how much hidden or mutable context the reader keeps in their head while reading.

The test: can a new reader answer "where does X come from?" and "what can change X?" in under 30 seconds? If not, cut layers or cut state. Line count, cyclomatic complexity, and "clean architecture" are proxies for this. Reader load is the thing that matters.

Code should read top to bottom like the explanation you would give a teammate.

## Design vocabulary

Use these established terms when planning or reviewing, so a quality has a name and a body of practice behind it. They are tools, not doctrine. A pattern name describes a design that emerged; it is never a requirement to manufacture that design.

| Desired quality | Established terminology |
| --- | --- |
| Main functions read almost like English | Composed Method, intention-revealing interface, use-case orchestration |
| Orchestrators call well-named operations | Application Service, Use Case Interactor, Transaction Script |
| Ugly mechanics stay below a clean interface | Information hiding, deep modules, complexity pulled downward |
| Domain logic contains no process or network code | Functional Core / Imperative Shell, Ports and Adapters |
| Code is organized around user behavior | Vertical Slice Architecture, use-case-driven architecture, Screaming Architecture |
| Types enforce invariants | Type-driven design, making illegal states unrepresentable |
| Boundary checks produce trusted values | Parse, Don't Validate, smart constructors, refinement types |
| Constructors and assertions enforce contracts | Design by Contract, preconditions, postconditions, invariants |
| Invalid conditions leave before the normal flow | Guard clauses, fail-fast design |
| Imagined requirements do not create code | YAGNI, evolutionary design, avoid speculative generality |
| Reuse follows real repetition | Rule of Three, semantic compression, AHA (avoid hasty abstractions) |
| Helpers hide meaningful complexity | Deep rather than shallow modules, locality of behavior |
| State and behavior have one owner | Encapsulation, Tell Don't Ask, Information Expert |
| Defenses move upstream to the decision that caused them | Root-cause fix, redesign from first principles |
| Records get generated IDs | Surrogate keys, identity independent of attributes |

## Happy path first

If the normal flow is 95% of what the code does at runtime, it should be about 95% of what the reader sees.

- A top-level function reads like the use case: a short sequence of well-named steps. Parsing, process plumbing, protocol details, and retry mechanics live below it, inside the operation that owns them.

```
version = Version.parse(raw)
server.stop()
cli.install(version)
cli.require_version(version)
server.start()
```

- Don't split one operation into shallow steps (`prepare_update`, `do_update`, `finish_update`) that the reader has to reassemble. Keep related simple code together, or extract one deep operation that hides real complexity.

## Write less code

- Make the smallest change that solves the problem. Deleting code is the best outcome.
- Do not add options, parameters, config, modes, or extension points that no current caller needs.
- Add a helper only when a second real caller exists or the helper owns an invariant of its own. Apply the deletion test: if inlining it makes complexity disappear, it was waste; if inlining it spreads complexity across callers, it earns its keep.
- Do not write wrappers that forward to another function with the same arguments.
- A zero-argument function that returns a literal, a template string, or a settings lookup is a constant or a default. Make it one.
- When you replace an internal API, migrate every caller and delete the old one in the same change. No compatibility shims, aliases, or deprecated paths for internal code.
- Prefer the standard library and the repository's existing utilities over new helpers or new dependencies.

## Evidence before complexity

- Don't write code for edge cases nobody has observed. "Could," "might," and "what if" are not reasons by themselves. Name the observed failure: a log, a reproduction, a bug report, or persisted state.
- When evidence shows up, fix the smallest real failure in the code that owns it. Don't build a general defense system around one incident.
- If the fix for a rare case needs substantial machinery, write down the observed failure, how often it happens, and what the machinery costs before adding it.
- This is not permission to skip parsing untrusted input, authorization, or security controls. Those boundaries are known hazards, not speculative ones.

## Straight-line control flow

- Handle edge cases with early returns at the top. Keep the main path unindented.
- More than two levels of nesting means something wants to be extracted, inverted, or modeled.
- When a block needs a comment to explain what it does, extract it into a function whose name says that.
- No boolean or mode parameters that switch a function's behavior. Write two functions, or take a literal or enum the caller has to name.
- When a new case grows an `if`/`elif` chain by another branch, or adds a second flag that must stay in sync with the first, stop and model it: a lookup table, a tagged union or enum with an exhaustive `match`/`switch`, or a state machine.
- A function does one thing at one level of abstraction. If it doesn't fit on a screen, look again.
- Run independent work concurrently. Do not serialize it for no reason.

## Boundaries: parse once, then trust the types

Boundaries are where data enters from outside the code you control: HTTP requests and responses, CLI args, environment and config files, database rows, queue messages, files, and third-party SDK return values.

- At a boundary, parse untrusted data into a typed domain value. Parsing means you get back a value whose type proves the check passed; validating and then throwing the information away is not parsing.
- Inside the system, trust the types. No re-validation, no defensive `None`/`null` checks on values the type says are present, no runtime type checks (`isinstance`, `typeof`, `hasattr`) on parameters that already have a type, and no `try` blocks "just in case."
- Do not pass raw dicts, JSON blobs, ORM rows, or SDK objects inward. Translate them at the edge.
- Parse configuration and environment once at startup into a typed settings object and pass it in. Do not read the environment in the middle of the code.
- Name functions for what they return: `parse_x` turns untrusted input into an `X` or fails; `is_x` is a true predicate; avoid `validate_x` for something that returns a refined value.

## Model the domain in types

- Make illegal states unrepresentable. A lifecycle is a tagged union or enum of states, each carrying only the fields valid in that state, not a bag of booleans and optional fields that must agree.
- Identity is assigned, not derived. Give records a generated ID (UUIDv7). Never build an ID from a name or any other field that can change or collide.
- Give IDs and units their own types (NewType, brand, newtype) when mixing them up is a realistic mistake: `UserId` versus `OrgId`, cents versus dollars, seconds versus milliseconds.
- Push optionality outward. A function that needs a value takes the value, not an optional it then checks. Branch or parse before calling.
- Represent absence with `None`/`null`/`Option`, never with a sentinel string, `-1`, or an empty object.
- Represent modes with literal unions or enums, not free strings.
- When a schema, migration, OpenAPI spec, or protobuf owns a type, derive from it instead of hand-writing a parallel one.
- Do not force an abstraction. If the current shape is clear, local, and unlikely to grow, plain code is the right answer.

## Fix the cause

When code grows to defend against a consequence of an earlier decision (collisions, ordering, keeping two copies in sync), change the decision instead of adding the defense. A comment that explains what the code protects against is the signal to stop and look upstream.

When debugging, trace the symptom back to the first place the system went wrong and fix it there. A guard is a fix only when the state it handles is legitimate.

## Errors

Separate **expected failures** from **bugs**.

- **Expected failures** (not found, invalid input, permission denied, upstream unavailable, conflict) are part of the function's contract. Give them specific types, carry the context needed to act on them, and handle them at one boundary that turns them into an HTTP response, an exit code, a retry, or a user message. Each language file says what mechanism to use.
- **Bugs** (violated invariants, impossible branches) should fail loudly and immediately. Do not catch them.
- Catch narrowly, as close as possible to the call that can fail in a known way, and translate the failure into your own error type with the original as its cause.
- Never swallow an error: no catch-and-continue, no catch-log-and-return-default, no catch-all that returns `None`/`null`. If you can't name what you're catching and why recovery is correct, don't catch it.
- Error messages say what operation failed and with which identifiers. Never put secrets or tokens in errors or logs.

## Escape hatches need a written reason

`Any`/`any`, casts (`cast`, `as`), non-null assertions (`!`), `unwrap`/`expect`, `unsafe`, and suppressions (`# type: ignore`, `# noqa`, `// @ts-expect-error`, `// oxlint-disable`, `#[allow]`) are allowed only when the type system truly cannot express a true invariant. Each one gets a comment that starts with `SAFETY:` and says why it holds, or a suppression scoped to one rule and one line with a reason. Never use one to make a type error or lint go away.

## Names

Follow the Naming rules in the global `AGENTS.md`. In code, also:

- Name files and modules for the concept they own. No `utils`, `helpers`, `common`, `misc`, or `types` grab-bags.
- No structural suffixes that don't distinguish two real concepts: `Manager`, `Helper`, `Processor`, `Handler`, `Service`, `Data`, `Info`, `Record`, `Result`, `Config`, `Dto`, `Shape`.
- Do not repeat the context the module supplies: `users.create`, not `users.create_user`; a file in `billing/` is `invoice.py`, not `billing_invoice.py`.
- Predicates read as questions: `is_expired`, `has_permission`, `can_retry`.
- One term per concept across code, tests, logs, and events. If the product says "workspace," the code doesn't also say "project" and "space."

## Comments

Make names and structure explain the code. Before adding a comment, try a clearer name, a smaller function, or a named intermediate value.

Write a comment only for what code cannot express:

- a constraint imposed by an external system
- a required ordering or timing rule
- a workaround for a dependency bug, with a link
- the reason for a non-obvious choice, with a link to the issue or incident
- a `SAFETY:` justification

Never write comments that narrate the next line, restate the function name, label steps (`# Step 1`), draw section banners, or record history ("changed to X because Y"; that belongs in the commit). Delete commented-out code. A `TODO` needs a ticket link.

Docstrings belong on the public interface of a package or library, and only when the name and signature don't already say it. Never write a docstring that repeats the parameter list (`Args: user_id: the user id`).

## State and side effects

- Keep decisions and calculations in pure functions. Keep I/O at the edges, in the code that calls them.
- Pass dependencies in (clients, stores, clocks, settings). Do not reach for globals or import-time singletons.
- Importing a module must not do work: no connections, no network calls, no env reads, no registration with side effects.
- Prefer returning new values to mutating arguments. Keep mutable state as local as possible: locals over fields, fields over module state, never mutable globals.
- Tell, don't ask. Put state and its invariants behind one owner and call its domain operation (`session.promote(message)`) instead of reading its state and changing it from outside.
- Derive values instead of storing a copy and keeping it in sync.
- Make operations that may be retried idempotent: an idempotency key, a unique constraint, or a state-transition guard.

## Modules and files

- A module hides real complexity behind a small interface. If the interface is as big as the implementation, the module isn't earning its keep.
- Every layer, interface, and file must pay for itself: it owns an invariant, hides real complexity, has more than one real implementation, or removes stable duplication. No `controller -> service -> repository` chains that pass the same call through. Start with the direct implementation and extract when the code shows a natural cut point.
- Duplication is cheaper than the wrong abstraction. Extract shared code when the callers share meaning, not when the lines merely look alike.
- Organize by feature or use case (`invoices/pay.py`), not by layer (`controllers/`, `services/`, `repositories/`).
- One concept per file. Split a file when it has two unrelated reasons to change, or when it passes about 500 lines.
- Import from the module that defines a thing. No barrel files, re-export hubs, or `__init__`/`index` files whose job is forwarding names.
- Export only what callers use. Do not export internals so tests can reach them.
- Put logic in the layer and package that owns the concept, not in a shared path behind a feature check.

## Tests

- Test behavior through the public interface: inputs in, observable outcomes out (return values, raised errors, persisted state, responses, emitted events).
- Never patch modules (`mock.patch("pkg.mod.thing")`, `vi.mock`). Make the dependency a parameter and pass a test double in.
- For a test double, use the test library's mock with the real interface's spec. Write a fake by hand only when it needs real behavior, such as an in-memory store. Use a real local database when SQL, constraints, or transactions matter.
- Assert outcomes, not calls. `assert_called_with` is the main assertion only when the call itself is the only observable behavior.
- One behavior per test, and the test name states it. A failing test name should tell you what broke.
- Use property tests for parsers, round-trips, and normalization (Hypothesis, fast-check, proptest).
- Tests construct values through the same parsers and constructors as production code. They don't bypass invariants.

## Red flags

If any of these show up in a diff, fix them before calling it done:

- code justified by "could," "might," or "what if" with no observed failure
- a layer that passes the same call through to the next one
- a helper whose comment explains what earlier decision it defends against
- `try`/`except` or `try`/`catch` around code that has no known failure mode
- `except Exception`, bare `except`, or `catch (e)` that logs and continues
- a `None`/`null` check on a value whose type says it's present
- runtime type checks or `hasattr`/`getattr`/`in` probing on already-typed values
- `Any`, `any`, `dict[str, Any]`, `Record<string, unknown>` past the boundary
- casts and non-null assertions without a `SAFETY:` comment
- a boolean parameter that changes what a function does
- an `if` chain that grew by one more branch for the new case
- a wrapper or helper with one caller that adds no meaning
- a class that is a function in disguise (only `__init__` and one method, or only static methods)
- comments that narrate code, and docstrings that repeat the signature
- a new `utils`/`helpers` file, or a name ending in `Manager`/`Helper`/`Data`/`Info`
- compatibility shims, aliases, or "legacy" paths for internal code
- tests that patch modules or only assert that mocks were called

## Before you say done

1. Re-read the whole diff as a reviewer who has never seen it.
2. Delete everything the change doesn't need.
3. Check the red flags above and the language file's rules.
4. Run the repository's focused checks for the files you changed.

## Sources

Adapted from Dillon Mulroy's `coding-standards` skill (github.com/dmmulroy/skills), Lauren Tan's pstack principles (github.com/cursor/plugins/tree/main/pstack), and Hona's "Code like Luke" (gist.github.com/Hona/53142c07c9decb735392f132ace34003).
