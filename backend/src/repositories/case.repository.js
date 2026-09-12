
import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { caseOfficers, cases, documents } from "../db/schema/index.js";

class CaseRepository {
	async create(values, tx = db) {
		const [row] = await tx.insert(cases).values(values).returning();
		return row;
	}

	async findById(id, tx = db) {
		const [row] = await tx.select().from(cases).where(eq(cases.id, id)).limit(1);
		return row ?? null;
	}

	async list({ status, q, assignedToMe, userId, userRole, userClearance, jurisdictionId, page, pageSize }) {
		const conditions = [];
		if (status) conditions.push(eq(cases.status, status));
		if (q) {
			conditions.push(
				or(
					ilike(cases.caseNumber, `%${q}%`),
					ilike(cases.title, `%${q}%`),
					ilike(cases.type, `%${q}%`),
				),
			);
		}
		if (assignedToMe) {
			conditions.push(
				inArray(
					cases.id,
					db
						.select({ caseId: caseOfficers.caseId })
						.from(caseOfficers)
						.where(eq(caseOfficers.userId, userId)),
				),
			);
		}
		if (jurisdictionId) conditions.push(eq(cases.jurisdictionId, jurisdictionId));
		const clearanceValues = ["PUBLIC", "RESTRICTED", "CONFIDENTIAL", "SECRET"];
		const clearanceIndex = clearanceValues.indexOf(userClearance);
		if (clearanceIndex < 0) {
			conditions.push(eq(cases.id, "00000000-0000-0000-0000-000000000000"));
		} else {
			conditions.push(inArray(cases.classification, clearanceValues.slice(0, clearanceIndex + 1)));
		}
		if (!["SUPERVISOR", "ORG_ADMIN", "SYSTEM_ADMIN"].includes(userRole)) {
			conditions.push(
				or(
					eq(cases.createdBy, userId),
					inArray(
						cases.id,
						db.select({ caseId: caseOfficers.caseId })
							.from(caseOfficers)
							.where(eq(caseOfficers.userId, userId)),
					),
				),
			);
		}
		const where = conditions.length ? and(...conditions) : undefined;
		const rows = await db
			.select()
			.from(cases)
			.where(where)
			.orderBy(desc(cases.updatedAt))
			.limit(pageSize)
			.offset((page - 1) * pageSize);
		const [{ total }] = await db.select({ total: count() }).from(cases).where(where);
		return { rows, total: Number(total) };
	}

	async update(id, values, tx = db) {
		const [row] = await tx
			.update(cases)
			.set({ ...values, updatedAt: new Date() })
			.where(eq(cases.id, id))
			.returning();
		return row ?? null;
	}

	async assignOfficer(values, tx = db) {
		const [row] = await tx
			.insert(caseOfficers)
			.values(values)
			.onConflictDoUpdate({
				target: [caseOfficers.caseId, caseOfficers.userId],
				set: {
					roleOnCase: values.roleOnCase,
					assignedBy: values.assignedBy,
					assignedAt: new Date(),
				},
			})
			.returning();
		return row;
	}

	async removeOfficer(caseId, userId, tx = db) {
		const [row] = await tx
			.delete(caseOfficers)
			.where(and(eq(caseOfficers.caseId, caseId), eq(caseOfficers.userId, userId)))
			.returning();
		return row ?? null;
	}

	async listOfficers(caseId, tx = db) {
		return tx.select().from(caseOfficers).where(eq(caseOfficers.caseId, caseId));
	}

	async countDocuments(caseId, tx = db) {
		const [{ total }] = await tx
			.select({ total: count() })
			.from(documents)
			.where(eq(documents.caseId, caseId));
		return Number(total);
	}
}

export default new CaseRepository();