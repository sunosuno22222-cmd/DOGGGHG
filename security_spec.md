# Security Specification — Aph Bot Manager Firestore

## 1. Data Invariants
1. Every document under `/users/{userId}` belongs strictly to the authenticated, email-verified user (`request.auth.uid == userId && request.auth.token.email_verified == true`).
2. Every `guildConfigs/{guildId}` document requires an existing parent `/users/{userId}` document (`exists(...)`), strictly matches `ownerId == request.auth.uid`, validates all keys and string lengths, and binds `createdAt == request.time` on creation and `updatedAt == request.time` on update.
3. Every `assets/{assetId}` document under `guildConfigs/{guildId}` enforces Master Gate ownership against the parent `guildConfigs/{guildId}` document (`get(...).data.ownerId == request.auth.uid`), restricts `assetId` to `'welcome'` or `'leave'`, and caps `dataUrl` size at 900,000 bytes.
4. No unauthenticated or cross-user reads, lists, creates, updates, or deletes are permitted anywhere.

## 2. Adversarial ("Dirty Dozen") Payloads
1. Unauthenticated read/write to `/users/{uid}/guildConfigs/{guildId}` -> `PERMISSION_DENIED`.
2. Unverified email user (`email_verified: false`) writing to `/users/{uid}` -> `PERMISSION_DENIED`.
3. Cross-user read/list (`uidA` reading `uidB`'s `guildConfigs`) -> `PERMISSION_DENIED`.
4. Spoofed `ownerId` (`uidA` creating config with `ownerId: uidB`) -> `PERMISSION_DENIED`.
5. Shadow field injection (`extraAdminFlag: true` on `guildConfigs` or inside `welcome` map) -> `PERMISSION_DENIED`.
6. Oversized document ID (`guildId` > 128 chars or invalid regex characters) -> `PERMISSION_DENIED`.
7. Oversized string field (`title` > 60 chars, `message` > 300 chars, or `dataUrl` > 900,000 chars) -> `PERMISSION_DENIED`.
8. Client-forged `createdAt` or `updatedAt` timestamp != `request.time` -> `PERMISSION_DENIED`.
9. Mutating immutable fields (`ownerId`, `guildId`, `createdAt`) during `update` -> `PERMISSION_DENIED`.
10. Orphaned `guildConfigs` creation without parent `/users/{userId}` document -> `PERMISSION_DENIED`.
11. Orphaned `assets` creation without parent `/users/{userId}/guildConfigs/{guildId}` document -> `PERMISSION_DENIED`.
12. Invalid `assetId` (anything other than `'welcome'` or `'leave'`) -> `PERMISSION_DENIED`.
