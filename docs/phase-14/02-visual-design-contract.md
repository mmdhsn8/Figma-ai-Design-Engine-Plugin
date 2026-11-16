# Visual design contract

The existing optional `professionalVisualVersion: 1` profile selects the role coverage and disclosure rules for Persian mobile high-fidelity apparel. New eligible sample storefront drafts additionally persist `storefrontLayoutVersion: 1`. The layout version is pinned alongside the request and survives reopening. Existing unversioned and earlier profile-only drafts retain their original generation and verification behavior.

The role layouts consume the same sample catalog. Home and detail share unit prices with cart, which adds quantity, shipping and discount. Amounts are validated and calculated as safe nonnegative integer toman and formatted with Persian digits. Product and section IDs continue to use the existing request and transaction identity rules. Overrides to explicit catalog values stay on the existing model-driven path.

The existing brief carries audience, brand direction, pinned Brand Kit and Skills. Pinned style resolution and contrast checks remain in the pipeline. A Skill requiring a pattern absent from the local layouts uses model-driven section composition, which retains its original pattern validation.
