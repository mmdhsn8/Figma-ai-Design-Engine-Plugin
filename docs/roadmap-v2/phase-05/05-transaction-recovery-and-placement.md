# Recovery and placement

Universal checkpoints save the program and fingerprint before dispatch. The coordinator also records each provider attempt before sending it. A lost planning response can be requested again within the existing budget, and a saved response is consumed without another model call. A changed program body or incomplete ownership evidence stops resume before a canvas write.

Renderer markers distinguish pending, built and complete roots. A built pending root can finish in place only with matching page, task and program identity, no adoption marker and successful native verification. Partial styles already persisted on that root are preserved. A pending root can be discarded only when its page and identity match, it has no adoption marker, and it has no children. An unverified, populated root without a built marker requires inspection. Native requests are capped at three dispatches per screen.

Completed roots are reused without moving them. The scoped executor registers logical refs and acknowledges operations using its existing ledger. Fresh readback checks ownership and receipt before the UI marks the checkpoint verified. Registration recovery and acknowledgement loss use idempotent effects. Native writes and persisted UI state do not form an atomic transaction.

Placement retains the configured planner, 6000 px wrap and 120 px gap. Immediately before placing a new root the renderer can recheck occupied canvas bounds and replan. Page scope is revalidated after fonts, before construction and before adoption. Universal generation preserves the current selection.
