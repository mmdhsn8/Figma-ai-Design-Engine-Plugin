# Visual quality and accessibility

The existing gate reports missing or duplicate product titles, image counts, missing cart steppers and incomplete variant selection. The local layout makes these fields explicit for each role. Editable artwork disclosure does not count as merchandise content.

Preflight measures bounded section geometry and text contrast. The offline renderer checks controls against the 44 px minimum and verifies 390×844 scroll-enabled roots. Existing native clipping checks remain in force. Fresh native readback also validates artwork ownership, vector children and actual fill. The regression suite rejects an instance whose master is missing.

Human review remains pending. Check the expected text wrap, Persian shaping, visual hierarchy, focus of each section, artwork balance and actual scroll at 100% in Figma Desktop.
