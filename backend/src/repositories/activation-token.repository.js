import {  desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { activation_tokens } from "../db/schema/index.js";




export const findByUserId = async (userId) => {
    const [result] = await db.select().from(activation_tokens).where(eq(activation_tokens.userId, userId)).orderBy(desc(activation_tokens.createdAt)).limit(1);
    return result;
}


export const findByToken = async (token) => {
    const [result] = await db.select().from(activation_tokens).where(eq(activation_tokens.token, token)).limit(1);
    return result;
}


