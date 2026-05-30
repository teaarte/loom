---
tags: [ui, design-system, accessibility, react, nextjs, vue, frontend]
stack_signals:
  - language: [typescript, javascript]
  - project_type: [frontend-app, monorepo]
summary: |
  Web UI consistency — design tokens over magic numbers, shared component
  library use, theme adherence, accessibility checks, responsive layout.
when_to_load: |
  Task touches user-visible UI components (React/Next/Vue), styling,
  spacing/typography/theme, or accessibility. Reviewer fan-out includes
  ui-consistency on a web frontend stack. Diff in *.tsx/jsx/vue/svelte/css/scss.
agent_hints: [ui-consistency, logic-reviewer, style-reviewer]
---

# UI Consistency: Web (React / Next.js / Vue)

## Design System
- Colors from CSS variables / design tokens, not hardcoded hex values?
- Spacing from consistent scale (Tailwind classes, CSS vars), not magic numbers?
- Typography using theme-defined sizes/weights, not arbitrary values?
- Border radius, shadows consistent with design system?
- Z-index using defined layers, not arbitrary large numbers?

## Component Patterns
- Using shared components from component library, not one-off implementations?
- Form elements (inputs, selects, buttons) from shared form system?
- Loading states using shared skeleton/spinner components?
- Error states using shared error boundary/display components?
- Empty states using shared empty state component?
- Modal/dialog following established overlay patterns?
- Icon usage from consistent icon library (Lucide, Heroicons, etc.)?

## Accessibility
- Semantic HTML used correctly (nav, main, section, article, button vs div)?
- ARIA labels on interactive elements without visible text?
- Keyboard navigation works (Tab order, Enter/Space activation, Escape to close)?
- Focus management correct (focus trap in modals, focus restore on close)?
- Color contrast meets WCAG AA (4.5:1 for text, 3:1 for large text)?
- Images have descriptive alt text (or empty alt for decorative)?

## Responsive
- Same breakpoint patterns as rest of app?
- Mobile behavior consistent (touch targets 44x44px minimum)?
- No horizontal scroll on mobile viewports?
- Text readable without zoom on all screen sizes?

## Framework-Specific
- **React:** key props on list items, React.Fragment vs unnecessary divs
- **Next.js:** using `next/image`, `next/link`, `next/font` where applicable
- **i18n:** all user-visible text via translation function, no hardcoded strings
