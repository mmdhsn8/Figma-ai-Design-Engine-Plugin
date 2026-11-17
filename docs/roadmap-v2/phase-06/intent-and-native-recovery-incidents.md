# Universal intent and native recovery incidents

## A. A greeting reached the Canvas planner

Chat used the selected engine for each new message. Universal Engine then exposed the Canvas classifier even when the message had no Canvas request. The runner accepted its `create` result as authorization to plan. The planner prompt allowed the model to choose one to ten screens when the user gave no count. That combination let a greeting become a brief and allowed the model to propose Welcome. The renderer itself had no hard-coded Welcome screen. It prefixed the planned screen label with its sequence number.

The runner now answers common greetings locally and sends general discussion through a provider request with Canvas tools disabled. An explicit Canvas request is required before the Universal planner can run. The runner also blocks a misrouted saved greeting while retaining its checkpoint and any native layers. Ambiguous requests can be restated as direct Canvas instructions.

## B. The renderer could remove the frame it had just displayed

The source path that reproduces the symptom is:

1. The UI saved the one-screen program and its fingerprint, marked the screen as rendering, and dispatched the controller request.
2. The renderer called `figma.createFrame()`, which attached a frame to the current page. It added task, batch, screen, and fingerprint metadata, named the frame `01 — Welcome`, built the editable descendants, and marked the frame as built.
3. The synchronous geometry check ran before the renderer marked the root complete and before the executor adopted the root. When the geometry check threw, the shared renderer caught the error and called the per-screen tracker's cleanup. That tracker called `remove()` in reverse creation order on the new descendants and the new frame. The visible frame was therefore **deleted by automatic rollback** in this path. It was already attached when it was removed.
4. The controller returned `native_geometry_failed`. The UI retained the program and reported failure. The fresh, post-adoption readback stage was never reached in this path.

The same error code can also come from the local component check after the root has been built or from the final readback in Chat. Those paths do not remove the root. The pre-adoption rollback is a deterministic explanation for the reported appearance and disappearance, but no Figma trace from the original run identifies its exact node ID, geometry finding, or branch.

## Recovery and cleanup audit

| Boundary | Result after the fix |
| --- | --- |
| Program, font, or scope rejection before frame creation | Report the preflight or render failure. No frame is acknowledged. |
| Native construction fails during the build | Retain attached nodes. A partially built owned root blocks automatic replacement and is available for inspection. |
| Geometry check fails on a built root | Retain the root, its parent, position, descendants, and shared assets. Resume rechecks the same root. |
| Adoption fails or its acknowledgement arrives late | Preserve the frame. Adoption stores scoped references and idempotent operation IDs. Its rollback restores metadata if persistence fails. Subsequent attempts use a new message correlation ID and the same program identity. |
| Cancellation or render acknowledgement timeout | Stop subsequent work. An in-progress controller render may settle. Resume uses the root identity already recorded on the page or finds the matching tagged root from an older build. |
| Post-adoption verification fails or times out | Keep the adopted root and its ID. Retry performs native readback again. |
| Readback finds a moved, missing, or explicitly removed root | Report that state separately and refuse replacement. A missing API lookup leaves deletion unconfirmed. |
| Existing pending root in the shared renderer | Resume requires a recovery match. Pending roots are preserved when recovery cannot be confirmed. |
| Standalone imports and section transactions | The shared tracker can still roll back nodes created by that specific attempt. The Universal render opts out of that rollback. The explicit delete tool remains behind its separate scoped consent path and is unavailable to the Universal planner and conversational requests. |

## Desktop verification in an authorized disposable file

1. Restart Companion from the rebuilt output and reload the development plugin. Open the Figma development console and filter for `[FAD_NATIVE_PROGRAM]`.
2. Send `hi`, `hello`, and `سلام` separately, then send a design advice question. Verify the layer tree is unchanged and no native program events appear. Send one explicit design request and verify that it creates an editable screen.
3. Correlate `root_created` and `root_built` with the root's actual node ID, parent ID, position, and child mapping. Join `adoption_acknowledged` and `final_readback` by task ID, fingerprint, and native IDs. The readback should identify the same root and descendants.
4. For a failed geometry check on a disposable fixture, capture `geometry_rejected` with its finding codes. The frame should remain attached. If the failure can be corrected on that fixture, close and reopen the plugin and Resume. Verify the original root ID, parent, and position, with no duplicate.
5. Stop or close the plugin while a disposable render acknowledgement is pending. Relaunch and Resume the saved task. A matching root should be reused. A missing root should be reported as missing unless Figma supplies explicit removal evidence.
