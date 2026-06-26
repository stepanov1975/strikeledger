# Devvit Template Notes

This project started from a Devvit mod-tool template, but the active app is now StrikeLedger. The original template's Mop bulk-comment workflow is not part of this project.

Use the active project documents instead:

- [README.md](./README.md): public app-page content and moderator user manual.
- [MVP.md](./MVP.md): authoritative product and implementation contract.
- [PROJECT_README.md](./PROJECT_README.md): developer-facing project summary.
- [PLAYTEST.md](./PLAYTEST.md): manual Devvit and Reddit validation checklist.

Current StrikeLedger behavior:

- Moderator menu actions record warning ledger entries for posts and comments.
- Configurable points, decay, templates, and side-effect toggles are stored through Devvit settings and Redis-backed Admin rules.
- The dashboard custom post renders a non-scrolling inline launcher or compact Profile preview; full moderator History, Reversal, and Admin workflows load in expanded mode.
- Logged-in non-moderators who launch the expanded dashboard see only their own active total and compact warning history.
- Public comments never expose point totals or active totals and avoid claiming side-effect outcomes; private notices and native mod notes may include point details, and private notices can explain confirmed action outcomes.
