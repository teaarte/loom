---
tags: [ui, flutter, dart, material, cupertino, responsive, mobile]
stack_signals:
  - language: [dart]
  - project_type: [mobile, frontend-app]
summary: |
  Flutter UI consistency — Material/Cupertino choice, Theme.of usage over
  hardcoded values, MediaQuery / LayoutBuilder responsive layouts, SafeArea,
  text scaling, overflow handling.
when_to_load: |
  Task touches Flutter UI widgets, styling, layout, or design-system
  adherence on a mobile/Flutter stack. Diff in *.dart with widget trees,
  theme usage, or layout containers.
agent_hints: [ui-consistency, logic-reviewer, style-reviewer]
---

# UI Consistency: Flutter

## Material / Cupertino Consistency
- Using correct design language for target platform (Material 3 vs Cupertino)?
- Not mixing Material and Cupertino widgets in same screen?
- Using `Theme.of(context)` for colors/text styles, not hardcoded values?
- Custom widgets extend the theme, not override it?

## Layout & Responsive
- Using `MediaQuery` / `LayoutBuilder` for responsive layouts, not fixed sizes?
- `SafeArea` applied where needed (notch, status bar, bottom bar)?
- Handles landscape orientation if applicable?
- Text scales with `MediaQuery.of(context).textScaler` (not the deprecated `textScaleFactor`)?
- Text overflow handled (`TextOverflow.ellipsis`, `maxLines`) on dynamic content?

## State Management
- Consistent pattern across screens (all Riverpod, or all BLoC — not mixed)?
- State scoped correctly (not global when local would suffice)?

## Navigation
- Consistent navigation pattern (GoRouter / auto_route / Navigator 2.0)?
- Back button behavior correct on Android?
- Deep linking supported if applicable?

## Assets & Images
- Using `CachedNetworkImage` for remote images (not raw `Image.network`)?
- Placeholder and error builders on network images?
- Consistent icon usage from single icon set?

## Accessibility
- `Semantics` widgets on custom components?
- `excludeFromSemantics` on decorative images?
- Sufficient color contrast?
- Touch targets at least 48x48 dp?

## Patterns
- Loading/error/empty states use consistent shared widgets?
- Form validation follows project patterns (`FormField`, validators)?
- No hardcoded strings — using localization (`AppLocalizations` / `easy_localization`)?
- Animation durations and curves consistent with project defaults?
