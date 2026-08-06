# Dead-code and repository cleanup

## Removed production code

- `formatIdentifier()` — no callers.
- `sawServerHelloDone` — assigned during TLS 1.2 negotiation but never read.
- Unused Promise executor parameter in the TLS timeout path.
- Two unused regex callback parameters.
- Large multilingual comments that asserted the code was safe but provided no
  executable behavior, documentation value or maintenance value.
- Module-scoped `config_JSON` — replaced by request-local variables to prevent
  cross-request state contamination.
- Sticky runtime flag updates (`value || previousValue`) — replaced with
  deterministic environment-derived assignments.

## Removed duplicate automation

- Manual Wrangler dry-run workflow — covered by the validation workflow.
- Separate secret-presence workflow — covered by the deployment workflow.
- Separate smoke-test workflow — covered by deployment health verification.
- Automatic upstream fork sync — unsafe after substantial local divergence and
  permanently skipped when the repository is not a GitHub fork.
- Empty `.gitkeep` in the populated workflow directory.
- Temporary architecture snapshot workflow used during this audit.

## Removed stale documents

The fragmented deployment-status, checklist and workflow-directory notes were
removed. Current behavior is documented in `README.md`, `PRODUCTION.md` and this
`docs/` directory.

## Preventing regression

`scripts/check-architecture.mjs` fails CI when it finds:

- a restored legacy monolith;
- a missing relative module;
- a circular module dependency;
- an oversized source module;
- the removed anti-analysis comment block;
- the removed dead function;
- request configuration stored at module scope outside the two request-local
  implementation files.
