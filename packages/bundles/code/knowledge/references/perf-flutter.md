---
tags: [performance, flutter, dart, widget-rebuild, mobile]
stack_signals:
  - language: [dart]
  - project_type: [mobile, frontend-app]
summary: |
  Flutter / Dart performance checklist — const constructors, build() scope,
  setState() placement, list virtualization, image caching.
when_to_load: |
  Task touches Flutter widgets, Dart code with perf concerns, or mobile-app
  scale targets. Diff in *.dart with widget tree changes, setState() calls,
  or list/scroll views.
agent_hints: [performance, logic-reviewer, ui-consistency]
---

# Performance: Flutter / Dart

## Widget Rebuilds
- Missing `const` constructors on stateless widgets and static children
- Large `build()` methods that should be split into smaller widgets
- `setState()` at too high a level (rebuilds entire subtree instead of targeted widget)
- Missing `const` keyword on widget constructors with no dynamic params
- Heavy computation inside `build()` — move to `initState()` or compute outside

## Lists & Scrolling
- `ListView(children: [...])` with 20+ items — use `ListView.builder` instead
- Missing `itemExtent` or `prototypeItem` on large uniform lists
- `SingleChildScrollView` wrapping a `Column` with many children — use `ListView`
- Missing `cacheExtent` tuning for heavy list items
- `IntrinsicWidth`/`IntrinsicHeight` in lists — causes expensive two-pass layout

## Animation & Painting
- Missing `RepaintBoundary` to isolate frequently repainting regions
- Using `Opacity` widget — use `FadeTransition` or `AnimatedOpacity` instead (Opacity forces offscreen buffer via saveLayer)
- `ShaderMask`, `ColorFilter`, `ClipPath` with non-default clipBehavior trigger expensive saveLayer calls
- First-run shader compilation jank — consider Impeller (default on iOS) or `--bundle-sksl-path` for Skia

## Images & Assets
- No `cacheWidth`/`cacheHeight` on large images (decode full resolution for small display)
- Missing `CachedNetworkImage` — raw `Image.network` without caching
- Large images loaded without resize — use `ResizeImage` or server-side thumbnails
- SVG assets that could be compiled to code via `flutter_svg` or replaced with icons

## State Management
- Riverpod/BLoC/Provider at too high a scope (rebuilds unrelated widgets)
- Missing `select()` / `Selector` — listening to entire state when only one field needed
- `FutureBuilder` / `StreamBuilder` recreating Future/Stream on every build (store in variable or initState)
- Missing `GlobalKey` cleanup — excessive GlobalKeys kept alive unnecessarily

## Async & Resources
- Missing `dispose()` for controllers, streams, animation controllers
- `Timer.periodic` without cancel in `dispose()`
- Heavy work on main isolate (image processing, JSON parsing of large payloads) — use `compute()` or `Isolate.run()`
- Network request deduplication — multiple widgets triggering same fetch without caching

## Platform & Size
- Unused packages in `pubspec.yaml` (inflates app size)
- Tree-shaking for icon fonts is default in release mode — verify not disabled
- Platform channels called in hot path without caching result

## Profiling Note
Always profile in **profile or release mode** — debug mode has vastly different performance characteristics. Use DevTools Performance tab or `flutter run --profile`.
