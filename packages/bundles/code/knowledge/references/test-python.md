---
tags: [testing, python, pytest, unittest, backend]
stack_signals:
  - language: [python]
  - project_type: [backend, monorepo]
summary: |
  Python testing patterns — pytest vs unittest detection, API/service
  testing, fixtures, mocking external calls.
when_to_load: |
  Task writes or changes tests for a Python codebase, OR review of test code
  in a Python project. pytest.ini / pyproject.toml [tool.pytest] / conftest.py
  present.
agent_hints: [test, acceptance, logic-reviewer]
---

# Testing: Python

## Framework Detection
- `pytest.ini`, `pyproject.toml [tool.pytest]`, `conftest.py` → pytest
- `unittest` imports in existing code → unittest
- Neither → recommend pytest

## What to Test
**API Endpoints:**
- Request validation (missing fields, wrong types)
- Success response shape
- Error responses (401, 403, 404, 422)
- Auth guard behavior

**Services / Business Logic:**
- Input → output mapping
- Edge cases (empty, null, boundary values)
- Error handling paths

## File Naming
`test_*.py` in `tests/` directory

## Fixtures
- Use `conftest.py` for shared fixtures
- Scope correctly: `function` (default), `module`, `session`
- Compose fixtures — small focused fixtures combined in tests
- Factory fixtures for creating test data with overrides

## Parametrize
Use `@pytest.mark.parametrize` for testing multiple inputs:
```python
@pytest.mark.parametrize("input,expected", [
    ("valid", True),
    ("", False),
    (None, False),
])
def test_validate(input, expected):
    assert validate(input) == expected
```

## Async Testing
- `@pytest.mark.asyncio` for async test functions
- `AsyncMock` for mocking async dependencies
- `pytest-asyncio` plugin with `asyncio_mode = "auto"` in config

## FastAPI-Specific
- `httpx.AsyncClient` with `ASGITransport(app=app)` for async endpoint tests
- Override dependencies via `app.dependency_overrides[get_db] = mock_db`
- Test lifespan events separately if they have side effects

## Mocking
- `unittest.mock.AsyncMock` / `MagicMock` for dependencies
- `pytest` fixtures for DB/connection setup
- `monkeypatch` for env vars and simple attribute patches
- `pytest.raises(ExceptionType)` for exception assertions

## Do NOT
- Use `mock.patch` on the thing being tested
- Hardcode dates — use `freezegun` or fixture
- Rely on test execution order
- Leave real network calls in unit tests
