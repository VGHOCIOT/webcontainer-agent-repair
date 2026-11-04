# webcontainer-agent-repair
Self-healing autonomous micro-SaaS builder that has its own runtime as an agent that detects and patches breaks without a backend

## Known limitations

- **Custom specs run on unqualified graders.** The preset specs and the built-in corpus have hand-written reference apps that the model-authored validator and interaction driver must pass (and must fail when the app is deliberately broken) before they are allowed to score anything. A spec you write yourself has no reference, so its graders are unverified; in testing, fewer than half of freshly authored graders qualified on the first try. The app flags this in the batch results and the export, and marks any check that fails in every attempt as a possible grader defect. Treat results on a custom spec as indicative, not as findings. This is an accepted trade-off, see `CLAUDE.md`.
