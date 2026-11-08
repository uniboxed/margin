# Margin's fit check

Every night the top 10 000 sites (Tranco's list) are loaded through Margin's page box (the extension's own code, shrinking each page into the space beside the sidebar) and loaded plain, and the two are compared. This branch holds the results only; the tool is `tools/fit-check/` on main.

- [summary.md](tools/fit-check/data/summary.md): every site at its latest, and what got worse or better since the round before.
- [all-sites.csv](tools/fit-check/data/all-sites.csv): a row per site.
- `tools/fit-check/data/sites/<domain>.json`: one site, every round.
- `tools/fit-check/data/rounds/NNNN/`: each round as it was crawled (pictures: only each flagged or failed site's latest).
