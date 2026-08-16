<!-- week: 0000-00 -->
# Weekly Edge — pending first run

The first real report will appear after the next Sunday 20:00 HKT once `EDGE_HMAC_KEY` is configured in both Vercel and GitHub Secrets.

The publish workflow reads the `<!-- week: YYYY-WW -->` header comment on line 1 of this file; the `0000-00` stub is intentionally skipped by the workflow so no partial publish fires from the bootstrap PR merge.
