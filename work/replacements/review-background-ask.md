# Re-review of installed local replacements

Fresh review identified six concrete issues in the previous forks: unsafe Ask fallback, invalid sandbox policy fallback/falsey opt-out, stale prepared wrappers, cancelled/expired watch execution, parent-denial/descendant-grant overlap, and stale watch confinement notices. Regressions reproduced these before fixes. The updated implementations were installed as local.2/bridge.2/carderne.2.

Independent targeted source re-review found no concrete remaining defect in those six paths. Strict credential mode validation was also corrected after the reviewer identified a coercion error in the new validation. The review is scoped and is not a repository-wide security certification. Operational evidence is recorded separately in the test summary and logs.
