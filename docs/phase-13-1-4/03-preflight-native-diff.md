# Preflight and native evidence

| Property | Reported native | Synthetic parent-local |
|---|---|---|
| Parent rectangle | 2639,6926 • 210×44 | 0,0 • 210×44 |
| Child rectangle | 2641,6959 • 206×17 | 2,33 • 206×17 |
| Lower edge | 6976 vs 6970 | 50 vs 44 |

The fixture supplies synthetic translation matrices and demonstrates a 44→50 recovery with zero bottom padding, rejection against a too-small section budget, rejection for an unrelated semantic ID, repeat safety, and rollback to 44. Native verification is rerun after any proposed adjustment. Per-node design-intent positions are not emitted where the model schema omits them. Desktop convergence and real renderer adjustments remain unmeasured.
