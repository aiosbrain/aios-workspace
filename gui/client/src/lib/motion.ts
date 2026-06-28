/**
 * Honor the user's reduced-motion preference for JS-driven motion (e.g. smooth scroll).
 * CSS handles declarative animations via a `@media (prefers-reduced-motion: reduce)` block
 * in app.css; this helper is for the imperative cases.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** ScrollIntoView behavior that collapses to an instant jump when motion is reduced. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
