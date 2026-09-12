
## Conventions (read first)

- **Base path:** `/api/v1/`
- **Auth:** session in an **httpOnly cookie** — the frontend sends refresh token, mfa token in cookies , `401` = not logged in, `403` = logged in but not allowed. while access token is send using bearer token.

- **Content-Type:** `application/json`, except file uploads (`multipart/form-data`).
- **Sensitive actions** (seal, delete, export, sign, permission change) require a **step-up** header: `X-Step-Up-Token: <token>` — else `403 { code: "STEP_UP_REQUIRED" }`.
- **Errors:** always `{ error: { code, message, details? } }`. Codes: `UNAUTHENTICATED`, `FORBIDDEN`, `STEP_UP_REQUIRED`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `LEGAL_HOLD`, `INTEGRITY_FAILED`.
- **Lists:** query `?page=1&pageSize=20&sort=-updatedAt` → response `Paginated<T>`.

```ts
type ID = string;         // UUID
type ISODate = string;    // "2026-08-24T14:03:00Z"
interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number; }
interface ApiError { error: { code: string; message: string; details?: unknown; } }
```

## Shared enums & entities

```ts
type Classification   = "PUBLIC" | "RESTRICTED" | "CONFIDENTIAL" | "SECRET";
type CaseStatus       = "OPEN" | "UNDER_INVESTIGATION" | "CHARGESHEETED" | "IN_TRIAL" | "CLOSED" | "ARCHIVED";
type DocType          = "FIR" | "POLICE_REPORT" | "INVESTIGATION_RECORD" | "WITNESS_STATEMENT"
                      | "CHARGE_SHEET" | "COURT_FILING" | "EVIDENCE_RECORD" | "FORENSIC_REPORT"
                      | "LEGAL_NOTICE" | "JUDGMENT" | "OTHER";
type Role             = "INVESTIGATING_OFFICER" | "SUPERVISOR" | "PROSECUTOR" | "JUDGE" | "COURT_CLERK"
                      | "FORENSIC_ANALYST" | "RECORDS_ADMIN" | "SECURITY_ADMIN" | "ORG_ADMIN"
                      | "SYSTEM_ADMIN" | "AUDITOR";
type IntegrityStatus  = "VERIFIED" | "TAMPERED" | "PENDING";
type ProcessingStatus = "SCANNING" | "OCR" | "INDEXING" | "READY" | "FAILED";

interface UserSummary { id: ID; fullName: string; role: Role; org: string; badgeId?: string; }
interface User extends UserSummary {
  email: string; clearance: Classification; jurisdiction: string;
  status: "ACTIVE" | "DISABLED"; mfaEnrolled: boolean;
  createdAt: ISODate; lastLoginAt?: ISODate;

  backup_codes; string; // stringified array of hashed backup codes

  username: string; password: string;

}
interface Me extends User { permissions: string[]; }   // drives the <Can> component

interface CaseSummary {
  id: ID; caseNumber: string; title: string; type: string; status: CaseStatus;
  classification: Classification; jurisdiction: string; documentCount: number; updatedAt: ISODate;
}
interface Case extends CaseSummary {
  description?: string; createdBy: UserSummary; assignedOfficers: (UserSummary & { roleOnCase: string })[];
  legalHold: boolean; createdAt: ISODate;
}

interface DocumentSummary {
  id: ID; caseId: ID; title: string; docType: DocType; classification: Classification;
  currentVersionNo: number; integrityStatus: IntegrityStatus; processingStatus: ProcessingStatus; updatedAt: ISODate;
}
interface Document extends DocumentSummary {
  description?: string; createdBy: UserSummary; currentVersionId: ID;
  versionsCount: number; tags: string[]; sealed: boolean; createdAt: ISODate;
}

interface DocumentVersion {
  id: ID; documentId: ID; versionNo: number; fileName: string; mimeType: string; sizeBytes: number;
  sha256: string; ledgerTxId?: string; signatureCount: number; uploadedBy: UserSummary; note?: string; createdAt: ISODate;
}
interface Signature { id: ID; versionId: ID; signer: UserSummary; algorithm: string; signedAt: ISODate; valid: boolean; }
interface AuditEntry {
  id: ID; actor: UserSummary; action: string; targetType: string; targetId: ID;
  ip: string; timestamp: ISODate; entryHash: string; prevHash: string; details?: Record<string, unknown>;
}
interface AccessGrant {
  id: ID; subjectType: "USER" | "ROLE"; subjectId: ID; resourceType: "CASE" | "DOCUMENT"; resourceId: ID;
  permission: "READ" | "WRITE" | "MANAGE"; grantedBy: UserSummary; grantedAt: ISODate; expiresAt?: ISODate;
}
interface Entity { type: "PERSON" | "LOCATION" | "DATE" | "LEGAL_SECTION" | "VEHICLE" | "ORG"; value: string; documentId: ID; }
interface Notification { id: ID; type: string; message: string; link?: string; read: boolean; createdAt: ISODate; }
```

---

## 1. Auth & session

```ts
POST /auth/login
  Req: { username: string; password: string }
  Res 200: { mfaRequired: boolean; }        // sets pre-auth cookie if mfaRequired

POST /auth/mfa/verify
  Req: { code: string }
  Res 200: { user: Me, accessToken }                                // sets full session cookie

POST /auth/logout            Res 204
GET  /auth/me                Res 200: Me               // current user + permissions

// First login / MFA enrollment

// user can change password till he/she has not setup mfa or login once.
POST /auth/change-password          Req: { currentPassword?: string; newPassword: string }   Res 204
POST /auth/mfa/enroll/start  Res 200: { secret: string; otpauthUrl: string; qrDataUrl: string }
POST /auth/mfa/enroll/verify Req: { code: string }     Res 200: { backupCodes: string[], user: Me, accessToken }

// Step-up for sensitive actions
POST /auth/step-up           Req: { code: string }     Res 200: { stepUpToken: string; expiresAt: ISODate }

POST /auth/refresh cookie: refresh_token and Bearer Access-Token Res 200: { accessToken }

```

## 2. Cases

### Note : pagination is 1 based indexing.

```ts
GET  /cases?status=&q=&assignedToMe=&page=&pageSize=   Res 200: Paginated<CaseSummary>
POST /cases
  Req: { caseNumber: string; title: string; type: string; classification: Classification;
         jurisdiction: string; description?: string }
  Res 201: Case
GET   /cases/:id                                        Res 200: Case
PATCH /cases/:id   Req: Partial<{ title; status; classification; description }>   Res 200: Case
POST  /cases/:id/officers     Req: { userId: ID; roleOnCase: string }   Res 200: Case
DELETE /cases/:id/officers/:userId                      Res 200: Case
POST  /cases/:id/legal-hold   Req: { reason: string }   Res 200: Case     // step-up
DELETE /cases/:id/legal-hold                            Res 200: Case     // step-up
```

## 3. Documents

```ts
GET /cases/:id/documents?docType=&classification=&page=   Res 200: Paginated<DocumentSummary>

POST /cases/:id/documents        // multipart/form-data
  Fields: file=<binary>, metadata={ title, docType, classification, description?, tags? } (JSON string)
  Res 202: Document               // processingStatus = "SCANNING"; poll GET /documents/:id

GET   /documents/:id             Res 200: Document
PATCH /documents/:id  Req: Partial<{ title; classification; description; tags }>   Res 200: Document
POST  /documents/:id/seal        Res 200: Document        // step-up
DELETE /documents/:id            Res 204                  // step-up; 409 LEGAL_HOLD if on hold
GET   /documents/:id/entities    Res 200: { items: Entity[] }   // NER results
```

## 4. Versions, download, integrity & signatures

```ts
GET  /documents/:id/versions                             Res 200: { items: DocumentVersion[] }
POST /documents/:id/versions     // multipart: file + note?  -> creates new immutable version
  Res 202: DocumentVersion
GET  /documents/:id/versions/:vid                        Res 200: DocumentVersion
POST /documents/:id/versions/:vid/restore                Res 200: Document   // creates new version from old

// Download → short-lived signed URL to object storage (don't stream big files through the API)
GET /documents/:id/versions/:vid/download?watermark=true Res 200: { url: string; expiresAt: ISODate }

// Integrity — the demo money-shot
GET /documents/:id/integrity
  Res 200: { status: IntegrityStatus; sha256: string; ledgerTxId: string; ledgerHash: string;
             matches: boolean; signatures: Signature[]; lastCheckedAt: ISODate }

// Chain of custody
GET /documents/:id/custody
  Res 200: { events: { timestamp: ISODate; actor: UserSummary; action: string; versionNo?: number; ledgerTxId?: string; hash: string }[] }

// Sign a version
POST /documents/:id/versions/:vid/sign                   Res 201: Signature   // step-up

// Evidence bundle (async job)
POST /cases/:id/export
  Req: { documentIds?: ID[]; includeCustody: boolean; format: "PDF" | "ZIP" }
  Res 202: { jobId: ID }                                 // step-up
GET /exports/:jobId
  Res 200: { status: "PENDING" | "READY" | "FAILED"; downloadUrl?: string; expiresAt?: ISODate }
```

## 5. Search

```ts
GET /search?q=&docType=&classification=&caseId=&entity=&dateFrom=&dateTo=&page=&pageSize=
  Res 200: {
    items: (DocumentSummary & { snippet: string; score: number })[];
    facets: { docType: Record<DocType, number>; classification: Record<Classification, number> };
    total: number; page: number; pageSize: number;
  }
```

## 6. Access / sharing

```ts
GET  /documents/:id/access                               Res 200: { items: AccessGrant[] }
POST /documents/:id/access
  Req: { subjectType: "USER" | "ROLE"; subjectId: ID; permission: "READ" | "WRITE" | "MANAGE"; expiresAt?: ISODate }
  Res 201: AccessGrant                                   // step-up; 403 if grantee clearance < classification
DELETE /access/:grantId                                  Res 204   // step-up
```

## 7. Users & admin (Org/Security admin)

```ts
GET  /users?role=&org=&status=&q=&page=                  Res 200: Paginated<User>
POST /users                                              // provision — NO public registration
  Req: { fullName; email; role: Role; clearance: Classification; jurisdiction: string; org: string; badgeId?: string }
  Res 201: { user: User; activationToken: string }
GET   /users/:id                                         Res 200: User
PATCH /users/:id   Req: Partial<{ role; clearance; jurisdiction; status }>   Res 200: User   // step-up
POST  /users/:id/deactivate                              Res 200: User       // revokes cert + kills sessions
POST  /users/:id/reset-mfa                               Res 204

// Active sessions
GET    /users/:id/sessions    Res 200: { items: { id: ID; ip: string; device: string; createdAt: ISODate; lastSeenAt: ISODate }[] }
DELETE /sessions/:sessionId   Res 204
```

## 8. Audit (Auditor)

```ts
GET /audit?actorId=&action=&targetType=&targetId=&dateFrom=&dateTo=&page=   Res 200: Paginated<AuditEntry>
POST /audit/export   Req: { filters: {...}; format: "CSV" | "PDF" }   Res 202: { jobId: ID }
```

## 9. Collaboration & notifications

```ts
GET  /documents/:id/comments   Res 200: { items: { id; author: UserSummary; body; createdAt }[] }
POST /documents/:id/comments   Req: { body: string }   Res 201: Comment

GET  /cases/:id/tasks          Res 200: { items: Task[] }
POST /cases/:id/tasks          Req: { title; assigneeId: ID; dueAt?: ISODate }   Res 201: Task
PATCH /tasks/:id               Req: Partial<{ status; assigneeId; dueAt }>        Res 200: Task

GET  /notifications            Res 200: Paginated<Notification>
POST /notifications/:id/read   Res 204
POST /notifications/read-all   Res 204
```

## 10. Reference (dropdowns)

```ts
GET /reference/enums
  Res 200: { classifications: Classification[]; docTypes: DocType[]; roles: Role[]; caseStatuses: CaseStatus[]; caseTypes: string[] }
```

---

