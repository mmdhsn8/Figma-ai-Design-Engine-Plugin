# Evidence and privacy

FW-5 transports an in-memory PNG typed array via the existing plugin/UI channel. Both ends verify request identity and bounded length and dimensions. PNG validation checks the signature, header, chunk bounds, image data and final marker. It does not decode pixels or validate chunk CRCs. FNV-1a serves as a correlation checksum only. The checkpoint stores receipt metadata and structured findings. Images stay out of History and Companion's text route.

| Limit | Value |
|---|---:|
| PNG payload | 4 MiB |
| Long edge | 2,048 px |
| Pixel count | 4,194,304 |
| Export and bridge budgets | 12 s and 15 s |
| Active exports and active repairs | One of either |
| Attempts per fresh root | One original PNG and at most one linked post-repair PNG |
| Reviewer budget | One call per authorized receipt, up to two per screen |
| Context | Up to 80 native nodes, bounded program summary and no raw layer copy in structured context |

Figma documents PNG export as `Uint8Array`. The transport still needs Desktop verification for actual structured clone copies and host memory ceilings. The UI clears its review buffer on completion or failure where it retains control of the array. A plugin host or external adapter can have its own copies, so zeroing the UI buffer cannot erase those. Each external call requires a matching receipt grant. The App currently configures neither reviewer nor grant. [Figma exportAsync](https://developers.figma.com/docs/plugins/api/properties/nodes-exportasync/).
