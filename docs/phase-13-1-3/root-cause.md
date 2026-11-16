# Root cause

The incident reported 4.06:1 on #FAF8F5 in identity preflight, after a bounded model repair. The original foreground, opacity, font and raw section are unavailable. The synthetic fixture uses #7B7B69 at full opacity on #FAF8F5, an inherited solid page, with Persian price text and the muted role. It reproduces the rounded ratio and is not the provider payload.

Before: bounded model output → geometry normalization → palette resolution and native mapping → existing visual audit rejects low contrast → bounded model repair.

After: bounded model output → same geometry normalization → resolve the section palette and repair eligible text roles locally → same mapped visual audit and section validation → save → native render and readback. Unresolved findings enter the existing bounded failure/repair path.

The geometry incidents were distinct: undersized touch targets and section packing before save, and horizontal clipping during native QA. Existing regression tests still exercise those paths.
