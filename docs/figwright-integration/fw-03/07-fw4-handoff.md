# FW-4 handoff — Layout & Geometry

FW-4 should begin from the existing canonical `DesignProgramV1`, preflight and native geometry receipt. The safe FW-3 findings to carry forward are: keep mutation scoped to one screen root; preserve deterministic child order; distinguish assigned layout properties from observed native geometry; use actual parent and bounds/layout readback; retain incomplete attached roots; and keep one checkpoint owner.

The FW-3 planning subset supports container layout metadata and fixed/hug/fill intent only. It does not execute Auto Layout in Figma, prove Hug/Fill resolution, or measure actual geometry. Existing native renderer and QA remain authoritative. FW-2 local styles/components/tokens/reuse are explicitly delegated to their original revalidation logic.

Still unverified: a batch execution and receipt route; real Figma computed geometry; batch timeout and partial-apply behavior; operation replay after restart; bridge ack delay/reordering; checkpoint failure; Stop during pending preparation; safe font loading on the proposed executor; and any real dispatch or latency benefit. FW-4 must not treat the planner as a renderer or reduce geometry/contrast/RTL/typography gates to compensate for unsupported operations.
