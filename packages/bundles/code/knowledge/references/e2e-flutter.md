---
tags: [e2e, flutter, integration-test, mobile]
stack_signals:
  - language: [dart]
  - project_type: [mobile, frontend-app]
summary: |
  Flutter integration test patterns — IntegrationTestWidgetsFlutterBinding,
  Key-based finders, pumpAndSettle, provider-override mocks.
when_to_load: |
  Task writes Flutter integration tests, OR project has integration_test/
  directory. Validation step asserts end-to-end behavior on a Flutter app.
agent_hints: [test, acceptance]
---

# E2E: Flutter Integration Tests

## Detection
`integration_test/` directory or `pubspec.yaml` with Flutter

## Process
1. Read existing `integration_test/` files for patterns (test groups, pumping, finders)
2. Write tests for flows in "Manual Test Steps" section of plan
3. Run: `flutter test integration_test/` (or specific file)

## Rules
- Use `IntegrationTestWidgetsFlutterBinding.ensureInitialized()`
- Find widgets via `find.byKey`, `find.byType`, `find.text` — prefer `Key` for stability
- Use `tester.pumpAndSettle()` after actions, not arbitrary delays
- Mock backend via dependency injection / provider overrides, not real network
- Group tests with `group()` per feature
- Test on at least one platform (Android emulator or iOS simulator)

## pumpAndSettle Timeout
Default timeout is 10 seconds. Increase for screens with long animations:
```dart
await tester.pumpAndSettle(const Duration(seconds: 30));
```
If pumpAndSettle never settles (infinite animation like a progress indicator), use `pump()` with specific duration instead.

## Screenshots
Capture screenshots during tests for debugging or visual regression:
```dart
final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
await binding.takeScreenshot('step_name');
```

## CI Execution
- Android: run on emulator started in CI (`flutter emulator --launch`)
- iOS: run on simulator (`open -a Simulator`)
- Or use Firebase Test Lab / AWS Device Farm for real devices
- Integration tests require a running device — cannot run headless like unit tests

## Platform Permissions
- Camera, location, storage permissions need to be pre-granted in test setup
- Android: use `adb shell pm grant` in CI before running tests
- iOS: use `simctl privacy` to grant permissions to simulator
