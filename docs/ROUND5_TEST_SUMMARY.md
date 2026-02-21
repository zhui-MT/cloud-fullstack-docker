# Round 5 Test Summary

- Generated at: 2026-02-21T15:43:29.235Z
- Regression status: **PASS**

## Regression Coverage
- Same config_rev returns deterministic PCA/correlation data
- Different config_rev changes analysis output
- CSV download includes artifact metadata and config_rev traceability
- PNG payload endpoint returns config_rev metadata for frontend rendering

## Performance Snapshot
- Analysis API samples: 40
- Download API samples: 60
- Analysis latency (ms): p50=2.64, p95=4.11, max=7.02
- Download latency (ms): p50=0.46, p95=0.9, max=1.13

## Notes
- Performance results are from local Node process loopback benchmarks (non-containerized).
- For release gate, compare against your deployment environment baseline and keep deltas within agreed threshold.
