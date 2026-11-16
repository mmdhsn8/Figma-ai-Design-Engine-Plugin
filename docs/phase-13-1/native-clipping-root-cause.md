# Native clipping

MOCK. For an axis-aligned parent at (510, 6889), subtracting the parent translation gives child x coordinates −155, −4 and −20. Their right edges are 195, 306 and 330, within the 390 px right boundary. The test independently supplies parent and child absolute transforms and expects the three left clips. The supplied incident contains no transform matrices, so this confirms the reported axis-aligned geometry rather than proving the exact live transforms.

SOURCE. The executor interprets child creation x/y as parent-local values. Before creating a child with explicit coordinates in a task-owned, clipped, manually laid out vertical-scroll frame, the executor rejects horizontal overflow with a 0.001 px tolerance. Text uses its normalized width and the freshly resolved parent. Existing clipped nodes remain subject to native QA.
