import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { comments } from "../db/schema/index.js";

class CommentsRepository {
  async create(values, tx = db) {
    const [row] = await tx.insert(comments).values(values).returning();
    return row;
  }

  async findById(id, tx = db) {
    const [row] = await tx.select().from(comments).where(eq(comments.id, id)).limit(1);
    return row ?? null;
  }

  // documentId omitted => case-level thread only (document_id IS NULL).
  async listForCase(caseId, { documentId } = {}) {
    const conditions = [eq(comments.caseId, caseId), isNull(comments.deletedAt)];
    conditions.push(documentId ? eq(comments.documentId, documentId) : isNull(comments.documentId));
    return db
      .select()
      .from(comments)
      .where(and(...conditions))
      .orderBy(asc(comments.createdAt));
  }

  // Document-scoped thread, independent of caseId (comments.case_id is
  // denormalized onto the row, so document_id alone is sufficient here).
  async listForDocument(documentId) {
    return db
      .select()
      .from(comments)
      .where(and(eq(comments.documentId, documentId), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt));
  }

  async update(id, values, tx = db) {
    const [row] = await tx.update(comments).set(values).where(eq(comments.id, id)).returning();
    return row ?? null;
  }

  async softDelete(id, tx = db) {
    return this.update(id, { deletedAt: new Date() }, tx);
  }
}

export default new CommentsRepository();
