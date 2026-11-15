# Phase 12 multi-screen contract

The version 1 contract is declared in [chat-generation.ts](../../src/shared/chat-generation.ts). It is a deterministic typed translation of the existing Chat plan into the structured renderer's request shape; it is not prose passed directly to native code.

## Request and plan

The validated request contains:

- `schemaVersion: 1`, bounded `taskId`, `generationId`, page-scoped `documentId`, and the exact selected `model` ID.
- A `DesignGenerationRequest` plus locale (`fa-IR` or `en-US`) and matching direction (`rtl` or `ltr`). “Both” targets are rejected; each task is one device family.
- An ordered list of 1–10 uniquely named screens with deterministic IDs, purpose, priority, navigation targets, dependencies, required `identity → primary → supporting` sections, content placeholders, shared component opportunities, viewport, and empty/validated component references.
- Shared domain, audience, tone, hierarchy, typography, spacing, semantic palette, asset policy, interaction priorities, and any pinned Brand Kit and Skills revisions.
- Existing placement policy: preserve existing roots, 120 px gap, 6000 px row width. It never reads unrelated canvas data to fill a brief.

The builder uses `createDesignPlan` as the source of screen identities and renderer dimensions. This route supports 390×844 mobile and 1440×900 desktop screens. Persian language plans require RTL. Unsupported document component references fail before generation; no unapproved document context is sent to a provider.

Example intent and abbreviated plan shape:

```json
{
  "schemaVersion": 1,
  "taskId": "chat-task-001",
  "generationId": "generation-chat-task-001",
  "model": "provider/model-exact",
  "locale": "fa-IR",
  "direction": "rtl",
  "screens": [
    {
      "id": "health-screen-1",
      "name": "Appointments",
      "order": 0,
      "purpose": "Book and manage appointments",
      "requiredSections": ["identity", "primary", "supporting"],
      "width": 390,
      "height": 844
    }
  ],
  "placement": { "gap": 120, "maxRowWidth": 6000, "preserveExistingRoots": true }
}
```

The example is abbreviated for readability; the runtime schema is strict and requires all plan fields.

## Bounds and rejection rules

| Limit | Value |
|---|---:|
| Screens per task | 1–10 |
| Required sections per screen | 3, sequential |
| Request payload | 256 KiB |
| Generation prompt | 12,000 characters |
| Section response/data | 1 MiB and 250 nodes |
| Screen data | 8 MiB |
| Project data | 64 MiB |
| Generated native nodes | 100,000 |
| Chat task checkpoint | 512 KiB |
| Pinned Skills | 3 |

The contract rejects count mismatch, duplicate IDs/names, invalid dimensions, mismatched locale/direction, unknown or self dependencies, dependency cycles, oversized prompt/payload, unsupported component references, and unsupported multi-device requests. The plan fingerprint is `p12-` plus a deterministic 64-bit hexadecimal digest of the ordered request contents. Resume uses that fingerprint to detect changed plans.

Asset policy is Brand-Kit-only when a kit is pinned; otherwise the design uses native placeholders. No raw account state, credentials, arbitrary executable code or unrelated canvas text is included in the contract.
