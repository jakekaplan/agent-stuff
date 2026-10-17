# Python

Read `core.md` first. This file says how its rules look in Python.

Default stack: uv, ruff, ty, pytest with pytest-asyncio, Pydantic v2 and pydantic-settings, httpx, cyclopts. Use the repository's tools when they differ. Use the newest syntax the project's `requires-python` allows: `X | None`, built-in generics (`list[str]`), `match`, `StrEnum`, `assert_never`, `Self`, `@override`, and the `type` statement on 3.12+.

## What we're fighting

This is the shape agents produce by default. Every line of it breaks a rule:

```python
def process_user_data(data: dict[str, Any], validate: bool = True) -> dict[str, Any] | None:
    """Process user data.

    Args:
        data: The user data.
        validate: Whether to validate the data.

    Returns:
        The processed user data, or None if processing failed.
    """
    try:
        # Validate the input data
        if validate:
            if not data or not isinstance(data, dict):
                return None
            if "email" not in data:
                logger.warning("Missing email")
                return None
        # Normalize the email
        email = data.get("email", "")
        if email:
            email = email.strip().lower()
        name = getattr(data, "name", None) or data.get("name") or "Unknown"
        return {"email": email, "name": name, "active": data.get("active", True)}
    except Exception as e:
        logger.error(f"Error processing user data: {e}")
        return None
```

The same behavior, parsed once at the boundary:

```python
Email = Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, pattern=r"^[^@\s]+@[^@\s]+$")]


class Signup(BaseModel, frozen=True):
    email: Email
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
```

A FastAPI route that takes `signup: Signup` gets a parsed value or returns a 422 on its own. What went away: the mode flag, dict in and dict out, the `isinstance` and `getattr` probing, the `"Unknown"` sentinel, the silent `active=True` default, the swallowed exception that turned every bug into `None`, the narrating comments, and the docstring that repeated the signature.

## Types

- Annotate every function's parameters and return type. Locals only when the checker can't infer them.
- No `Any`. Untrusted input is `object` or the raw type (`bytes`, `str`) until it's parsed. `dict[str, Any]`, `dict[str, object]`, and `Mapping[str, Any]` stop at the parse.
- Use a Pydantic model where data crosses a boundary: request bodies, API responses you consume, queue messages, files, settings. Once parsed, the model is a domain value. Don't copy it into a parallel dataclass unless the internal shape really differs.
- Use `@dataclass(frozen=True, slots=True)` for internal values that never need parsing.
- Use `TypedDict` only for a wire format you must pass through unchanged, never as a domain type.
- Use `NewType` for IDs and units that are easy to mix up: `UserId = NewType("UserId", str)`.
- Use `Literal[...]` or `StrEnum` for modes and statuses, never free strings.
- Model states as a union of dataclasses, each with only its own fields, and handle them with `match` plus `assert_never` so a new state fails the type check:

```python
@dataclass(frozen=True, slots=True)
class Queued:
    queued_at: datetime

@dataclass(frozen=True, slots=True)
class Running:
    started_at: datetime
    worker: WorkerId

@dataclass(frozen=True, slots=True)
class Failed:
    finished_at: datetime
    error: str

type BuildState = Queued | Running | Failed


def describe(state: BuildState) -> str:
    match state:
        case Queued():
            return "waiting for a worker"
        case Running(worker=worker):
            return f"running on {worker}"
        case Failed(error=error):
            return f"failed: {error}"
        case _:
            assert_never(state)
```

- Return the most specific type you can. Accept the least specific type you need (`Sequence`, `Mapping`, `Iterable`) only for public APIs that callers pass different collections into.
- `cast()` and `# type: ignore` follow the escape-hatch rule in `core.md`: a `SAFETY:` comment, and suppressions name the rule (`# ty: ignore[invalid-argument-type]`).

## No duck typing on typed values

- No `hasattr`, `getattr` with a string literal, or `isinstance` checks on parameters that already have a type. If the type allows several shapes, make it a union and `match` on it.
- `getattr(obj, "x", None)` means the type is wrong. Fix the type.
- `dict.get("key", default)` on a parsed value means it was never parsed. Parse it into a model with that field.
- `isinstance` belongs at the boundary while parsing, and in `match` over a union you own.

## Errors

Python's mechanism for expected failures is exceptions. Don't import a `Result` type.

- Define specific exception classes that carry the identifiers needed to act on them. Group a module's failures under one base class only when callers catch the group.

```python
class InvoiceNotFound(Exception):
    def __init__(self, invoice_id: InvoiceId) -> None:
        super().__init__(f"invoice {invoice_id} not found")
        self.invoice_id = invoice_id
```

- Raise the specific exception where the failure is detected. Translate it once, at the boundary:

```python
@router.get("/invoices/{invoice_id}")
async def get_invoice(invoice_id: InvoiceId, invoices: InvoiceStore = Depends(invoice_store)) -> Invoice:
    try:
        return await invoices.get(invoice_id)
    except InvoiceNotFound:
        raise HTTPException(status_code=404) from None
```

- When you translate a third-party exception, catch the narrowest type and chain it: `raise StoreUnavailable(...) from err`.
- Keep `try` blocks to the one call that can raise the exception you're catching. Put the code that uses the result after the block or in `else`.
- No bare `except:`. `except Exception` is allowed only at a top-level boundary (a request handler's error middleware, a worker loop, a CLI entrypoint) that logs with the traceback and translates. Everywhere else, let it propagate.
- Don't return `None` to signal failure when the caller needs to know why. Raise.
- `assert` is for invariants in tests and development. Don't use it for runtime checks that must hold in production; raise instead.

## Functions

- Make parameters after the first one or two keyword-only (`*`), and always for booleans and optional settings. This replaces most "options object" patterns.
- No boolean parameters that switch behavior. Two functions, or a `Literal` the caller must name.
- No `*args`/`**kwargs` pass-through. Spell out the parameters you forward.
- No mutable default arguments.
- Return early. Don't use `else` after `return`, `raise`, `continue`, or `break`.
- Use a comprehension for a simple map or filter. A comprehension with nested loops or more than one condition becomes a `for` loop.
- Use `pathlib.Path`, not `os.path`. Use timezone-aware datetimes (`datetime.now(UTC)`).

## Classes

- Don't write a class for what is a function. A class with only `__init__` and one method, or with only static methods, becomes a function or a module.
- Use a class when it owns state or holds dependencies that several methods share: a client, a store, a service constructed with its collaborators.
- Don't inherit to reuse code. Compose instead. Inherit only to plug into a framework (`BaseModel`, `Exception`) or a real type hierarchy.
- Don't define a `Protocol` just to make something testable. Take the concrete class and use `create_autospec(Concrete, instance=True)` in tests. Add a `Protocol` when two real implementations exist.
- No getters or setters. Use `@property` only for values computed from other fields.
- Mark overrides with `@override`.

## Modules and imports

- Absolute imports. Import from the module that defines the thing.
- `__init__.py` is empty or holds the package's real public interface. No `__all__` lists whose job is forwarding names, and no logic.
- No work at import time: no clients, connections, env reads, or registration side effects at module level. Constants and pure lookup tables are fine.
- Read settings once with pydantic-settings at the entrypoint and pass them in. No `os.environ` or `os.getenv` outside the settings module.
- Get loggers with `logging.getLogger(__name__)`. Pass values as structured fields (`extra=`) or `%`-style arguments, not f-strings. No `print` outside CLI output.

## Async

- Don't block the event loop while other work is running on it. Use the async client (httpx `AsyncClient`, aioboto3), or `asyncio.to_thread` for unavoidable blocking calls. A quick read at startup, before anything runs concurrently, needs neither.
- Annotate an `@asynccontextmanager` function as returning `AsyncGenerator[T]`, not `AsyncIterator[T]`.
- Run independent awaits concurrently with `asyncio.TaskGroup`. Don't create a task you don't own and await.
- Create long-lived clients once and close them with `async with` at the entrypoint or the framework's lifespan hook, not per call.

## Tests

- Plain pytest functions, not test classes. Fixtures for setup, `@pytest.mark.parametrize` for cases.
- Never `mock.patch` a module path. If a test needs to replace something, make it a parameter or a constructor argument and pass the double in.
- Doubles come from `create_autospec(Real, instance=True)` so a wrong call fails. Write a fake class only when it needs real behavior, such as an in-memory store.
- Assert on returned values, raised exceptions, and persisted state. `pytest.raises(SpecificError, match=...)`, never a bare `pytest.raises(Exception)`.
- Use Hypothesis for parsers, normalization, and round-trips.
- Name the test for the behavior: `test_expired_token_is_rejected`, not `test_validate_token_2`.

## Enforcement later

Candidates for the linter pass, not yet tested on a real codebase:

| Rule | Tool |
| --- | --- |
| No `Any` | ruff `ANN401`, ty |
| Annotate signatures | ruff `ANN` |
| No bare or blind except, no `try`/`except`/`pass` | ruff `E722`, `BLE001`, `S110`, `TRY` |
| No boolean positional parameters | ruff `FBT` |
| Nesting, branches, arguments, length | ruff `C901`, `PLR0911`, `PLR0912`, `PLR0913`, `PLR0915` |
| No commented-out code, TODOs need links | ruff `ERA001`, `TD003` |
| No `else` after `return`, simpler returns | ruff `RET`, `SIM`, `PIE` |
| No f-strings in log calls, no `print` | ruff `G004`, `T20` |
| `pathlib`, aware datetimes | ruff `PTH`, `DTZ` |
| Scoped suppressions only | ruff `PGH003`, `RUF100` |
| No `mock.patch`, no `os.environ` outside settings | ruff `TID251` (banned-api) |
| No `hasattr`/`getattr` probing, `cast` without `SAFETY:`, `dict[str, Any]` past the boundary, forwarding `__all__`, forbidden name suffixes | custom AST check (ruff has no plugins) |
