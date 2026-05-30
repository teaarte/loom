---
tags: [testing, flutter, dart, widget-test, mobile]
stack_signals:
  - language: [dart]
  - project_type: [mobile, frontend-app]
summary: |
  Flutter / Dart testing — widget tests for logic-bearing widgets, naming
  conventions, do-not-test rules for pure layout.
when_to_load: |
  Task writes or changes tests for a Flutter codebase, OR review of test
  code in a Flutter project. pubspec.yaml with flutter_test in
  dev_dependencies.
agent_hints: [test, acceptance, logic-reviewer]
---

# Testing: Flutter / Dart

## Framework Detection
- `pubspec.yaml` with `flutter_test` in dev_dependencies → `flutter test`
- `test/` directory with `*_test.dart` files → match existing patterns
- `integration_test/` → integration tests (run separately)

## What to Test
**Widgets — only if they contain logic:**
- Widget renders correctly with given parameters
- User interaction (tap, swipe) → expected state change
- Conditional rendering based on state
- Do NOT test: pure layout widgets, theme styling, static text

## File Naming
`*_test.dart` in `test/` directory (mirroring `lib/` structure)

## Finder Priority
Prefer in this order:
1. `find.byKey` (most stable, immune to text/type changes)
2. `find.byType` (good for unique widgets)
3. `find.text` (for verifying visible content)

## pump vs pumpAndSettle
- `tester.pump()` — advance one frame. Use when you need precise frame control.
- `tester.pumpAndSettle()` — pump until no more frames scheduled. Use after actions that trigger animations/transitions. Default timeout is 10 seconds — pass custom `Duration` for slow screens.
- After `tester.tap()` / `tester.enterText()` → always pump or pumpAndSettle.

## Mocking
- `mocktail` or `mockito` for dependencies
- `ProviderScope.overrides` for Riverpod state
- `BlocProvider` with mock blocs for BLoC pattern
- `pumpWidget()` with required providers and `MaterialApp` wrapper

## Golden (Screenshot) Testing
- Use `matchesGoldenFile('goldens/widget_name.png')` for visual regression
- Run `flutter test --update-goldens` to generate/update baselines
- Store goldens in version control
- Goldens are platform-sensitive — generate on CI or use `alchemist` for platform-agnostic goldens

## Async Testing
- `expectLater` with `emitsInOrder` for Stream assertions
- `tester.runAsync(() async { ... })` for real async operations in widget tests
- Wrap Future assertions in `expectLater` not `expect`

## Do NOT
- Test implementation details (internal state variables)
- Test third-party package widgets
- Use arbitrary `Future.delayed` — use pump/pumpAndSettle
- Forget to `addTearDown` for controllers/subscriptions created in tests
