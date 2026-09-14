# IntelliSense performance benchmark

Run `npm run benchmark` from the repository root. It compiles the extension and exercises the actual PHP index and completion provider against an in-memory VS Code API. No PHP installation or external project is needed.

The fixture contains 1,500 dependency files with 24 methods each (37,500 dependency symbols). A separate 251-method controller with 40 local variables exercises scope lookup. Each timed operation has five warm-up iterations followed by 30 samples; the report includes median and p95 elapsed milliseconds. Completion counts are checked so missing results cannot silently appear as a speed improvement.

Sample results on the same development machine, before and after the incremental-index optimization:

| Operation | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Update one small file | 24.880 ms | 0.030 ms | 41.801 ms | 0.042 ms |
| Global type completion | 102.068 ms | 0.453 ms | 106.064 ms | 0.721 ms |
| Member completion in a large file | 1.357 ms | 0.530 ms | 1.626 ms | 0.623 ms |
| Local-variable completion in a large file | 6.571 ms | 0.622 ms | 9.103 ms | 1.308 ms |

These are synthetic CPU measurements, not end-to-end editor latency guarantees. They exclude filesystem discovery/I/O, extension-host communication, suggestion rendering, and other installed extensions. Completion timings use already indexed documents; file-update cost is measured separately. Cold indexing is reported as a single sample, including parsing and lookup construction, so it should not be treated as a stable comparison. Different projects, hardware, Node.js versions, and garbage collection will change the results.

The optimization removes workspace-wide rebuilds after each edit, avoids scanning every declaration for each auto-import, and replaces repeated full-file scope searches with binary lookup and per-scope token caches. Regression tests cover name replacement, file deletion, dependency changes, duplicate declarations, prefix lookup, and document-version cache invalidation. Benchmarks intentionally have no wall-clock pass/fail thresholds.
