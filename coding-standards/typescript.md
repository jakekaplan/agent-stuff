# TypeScript

Read `core.md` first. This file says how its rules look in TypeScript.

Default stack: strict TypeScript, oxlint with the `anti-slop` plugin, vitest, zod, and TanStack Query for server state in React. Use the repository's tools when they differ. No Effect.

## What we're fighting

```ts
export async function getUserName(userId: any, options?: { fallback?: boolean }): Promise<string | undefined> {
  try {
    // Fetch the user from the API
    const response = await fetch(`/api/users/${userId}`);
    const data = (await response.json()) as any;
    if (data && typeof data === "object" && "name" in data) {
      return data.name ?? (options?.fallback ? "Unknown" : undefined);
    }
    return options?.fallback ? "Unknown" : undefined;
  } catch (error) {
    console.error("Failed to get user", error);
    return undefined;
  }
}
```

A caller can't tell "no such user" from "the API is down" from "the code has a bug." All three come back as `undefined`, or as `"Unknown"` if someone passed the flag. Parsed once, with the failures in the type:

```ts
const User = z.object({ id: UserId, name: z.string().min(1) });
type User = z.infer<typeof User>;

type UserLookupError =
  | { kind: "not-found"; userId: UserId }
  | { kind: "unavailable"; cause: unknown };

export async function fetchUser(userId: UserId): Promise<Result<User, UserLookupError>> {
  let response: Response;
  try {
    response = await fetch(`/api/users/${userId}`);
  } catch (cause) {
    return err({ kind: "unavailable", cause });
  }
  if (response.status === 404) return err({ kind: "not-found", userId });
  if (!response.ok) return err({ kind: "unavailable", cause: response.status });
  // Our own API returning the wrong shape is a bug, so a parse failure throws.
  return ok(User.parse(await response.json()));
}
```

The UI decides what to render for `not-found` versus `unavailable`. No `any`, no probing, no fallback flag, and nothing swallowed.

## Compiler settings

Turn on `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, and `verbatimModuleSyntax` where the project allows it.

## Errors

- Return expected failures as values. Use the repository's result type if it has one (`better-result`, `neverthrow`). Otherwise use this one, kept in one small module:

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <const E>(error: E): Result<never, E> => ({ ok: false, error });
```

- Make errors plain tagged objects with a `kind` and the fields a caller needs to act on them. Keep error unions specific at module boundaries (`UserNotFound | StoreUnavailable`), not a catch-all `AppError`.
- Only functions with expected failures return `Result`. A function that can only fail because of a bug returns its value directly.
- `throw` only for bugs: broken invariants, impossible branches, our own API breaking its contract.
- `fetch`, SDK calls, and other third-party code throw and reject for known failures. Catch those where the call is made, keep the original as `cause`, and return it as an error value. Don't let them travel up as rejections.
- Translate errors into HTTP responses, UI states, or exit codes in one place at the boundary.
- A rejected promise counts as a throw. Never leave a promise floating, and never `.catch(() => {})`.

## Types

- No `any`. Untrusted data is `unknown` until a zod schema (or the repository's schema library) parses it.
- `Record<string, unknown>` and broad `object` parameters stop at the parse. Inner functions take named types.
- Defining the schema and inferring the type from it (`z.infer`) is fine. Don't hand-write a second interface for the same data.
- Model variants as discriminated unions on `kind`. No bags of optional fields and booleans that must agree. No `Partial<T>` as a function input unless partial really is the concept.
- Handle unions exhaustively. Use the repository's helper if it has one, otherwise:

```ts
export function casesHandled(unexpected: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(unexpected)}`);
}
```

- Brand IDs and units that are easy to mix up: `type UserId = string & { readonly __brand: "UserId" }`. Create them only in a parser or a zod `.brand()`.
- No `as` except `as const`. Use `satisfies` to check a value without widening it. The rare real cast gets a `SAFETY:` comment. No non-null `!`. Narrow, parse, or restructure instead.
- Let TypeScript infer literal types. Don't annotate a known value with a wider type and then assert it back.
- No `enum`. Use string literal unions or `as const` objects.
- Mark inputs `readonly` and use `ReadonlyArray<T>` for arrays a function doesn't mutate.
- Narrow in this order: discriminant `switch`, then `in`, then `typeof`/`instanceof`, then a type guard. A type guard must actually check what it claims.

## Functions

- A function that takes more than two parameters, or any boolean or optional ones, takes one named object type and destructures it in the signature.
- No boolean parameters that switch behavior. Two functions, or a literal union the caller must name.
- Use `function` declarations for exported functions and arrow functions for callbacks.
- No `async` without `await`. Run independent work with `Promise.all`. Don't `await` inside a loop over independent items.
- Don't write a class for stateless logic. Use a class when it holds dependencies or state that several methods share, and pass those dependencies in through the constructor.

## Modules

- Named exports. Default exports only where a framework requires them.
- Import from the defining file. No barrel `index.ts` files that re-export.
- `import type` for type-only imports.
- File names in kebab-case, named for the concept they own.
- No `process.env` outside the config module. Parse the environment with zod once at startup.
- No top-level side effects outside entrypoints.
- No `console.log` in shipped code. Use the project's structured logger.

## React

- Derive values during render. Don't copy props or other state into `useState` and sync it with `useEffect`.
- Use `useEffect` only to synchronize with something outside React. Respond to user events in the event handler. Compute values in render.
- Server data lives in TanStack Query. Don't mirror it into local state.
- Return early for loading, empty, and error states. No nested ternaries in JSX.
- Don't add `useMemo` or `useCallback` by default. Add them when a measurement or a dependency array needs a stable reference.
- When a component's JSX gets hard to scan, extract a named subcomponent rather than adding comments.

## Tests

- Never `vi.mock` a module. Make the dependency a parameter or a constructor argument and pass a double.
- Type doubles against the real interface so a wrong call fails to compile.
- For UI, render with Testing Library and assert what the user sees. Use MSW for HTTP at the network boundary.
- Assert returned values, rendered output, and persisted state. Use `toHaveBeenCalledWith` only when the call itself is the behavior.
- Use fast-check for parsers and round-trips.

## Enforcement later

Start from strict, type-aware oxlint plus Dillon Mulroy's [`anti-slop`](https://github.com/dmmulroy/anti-slop) plugin: type-aware rules, `no-explicit-any`, `no-non-null-assertion`, `no-floating-promises`, cognitive complexity at 15, and the anti-slop rules for casts, widening, `unknown` signatures, dictionary types, `Reflect`, `typeof` probing, and module mocking. Gaps to close when building a portable kit (rule names to confirm against current oxlint):

| Rule | Tool |
| --- | --- |
| Casts without validation | `typescript/no-unsafe-type-assertion` |
| Exhaustive switches | `typescript/switch-exhaustiveness-check` |
| Nesting, ternaries, parameter count | `max-depth`, `no-nested-ternary`, `max-params` |
| No default exports | `import/no-default-export` |
| No `enum` | restricted syntax on enum declarations |
| `SAFETY:` comment on casts | `anti-slop/require-safety-comment-for-type-assertion` |
| File size | `loq` |
