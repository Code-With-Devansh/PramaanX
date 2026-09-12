import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications } from "../db/schema/index.js";

export async function create(values) {
  const [notification] = await db.insert(notifications).values(values).returning();
  return notification;
}

export async function listForUser(userId, { page, pageSize }) {
  const where = eq(notifications.userId, userId);
  const [items, [{ total }]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(notifications).where(where),
  ]);

  return { items, total: Number(total) };
}

export async function markRead(userId, notificationId) {
  const [row] = await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning({ id: notifications.id });
  return row ?? null;
}

export async function markAllRead(userId) {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
}