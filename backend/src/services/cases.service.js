import { conflict, forbidden, notFound } from "../lib/errors.js";
import caseRepository from "../repositories/case.repository.js";
import userRepository from "../repositories/user.repository.js";
import { getActivePolicy } from "../lib/abacPolicy.js";

const clearanceRank = { PUBLIC: 0, RESTRICTED: 1, CONFIDENTIAL: 2, SECRET: 3 };

function userSummary(id) {
  return { id };
}

function toSummary(row, documentCount = 0) {
  return {
    id: row.id,
    caseNumber: row.caseNumber,
    title: row.title,
    type: row.type,
    status: row.status,
    classification: row.classification,
    jurisdictionId: row.jurisdictionId,
    documentCount,
    updatedAt: row.updatedAt,
  };
}

async function requireCase(id) {
  const row = await caseRepository.findById(id);
  if (!row) throw notFound("case not found");
  return row;
}

async function toCase(row) {
  const [officers, documentCount] = await Promise.all([
    caseRepository.listOfficers(row.id),
    caseRepository.countDocuments(row.id),
  ]);
  return {
    ...toSummary(row, documentCount),
    description: row.description ?? undefined,
    createdBy: userSummary(row.createdBy),
    assignedOfficers: officers.map((officer) => ({
      ...userSummary(officer.userId),
      roleOnCase: officer.roleOnCase,
    })),
    legalHold: row.legalHold,
    createdAt: row.createdAt,
  };
}

export async function listCases(filters) {
  const user = await userRepository.findById(filters.userId);
  const policy = await getActivePolicy();
  const crossJurisdiction = Boolean(user && policy.crossJurisdictionRoles.includes(user.role));
  const result = await caseRepository.list({
    ...filters,
    userRole: user?.role,
    userClearance: user?.clearance,
    // Bypass roles see cases across all jurisdictions, not just their own.
    jurisdictionId: crossJurisdiction ? undefined : user?.jurisdictionId,
  });
  const documentCounts = await Promise.all(
    result.rows.map((row) => caseRepository.countDocuments(row.id)),
  );
  return {
    items: result.rows.map((row, index) => toSummary(row, documentCounts[index])),
    total: result.total,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export async function createCase(values, userId) {
  const user = await userRepository.findById(userId);
  const policy = await getActivePolicy();
  const crossJurisdiction = Boolean(user && policy.crossJurisdictionRoles.includes(user.role));
  if (
    !user ||
    user.status !== "ACTIVE" ||
    (!crossJurisdiction && user.jurisdictionId !== values.jurisdictionId) ||
    clearanceRank[user.clearance] === undefined ||
    clearanceRank[values.classification] === undefined ||
    clearanceRank[user.clearance] < clearanceRank[values.classification]
  ) {
    throw forbidden("case is outside the user's authorization scope");
  }
  const row = await caseRepository.create({ ...values, createdBy: userId });
  return toCase(row);
}

export async function getCase(id) {
  return toCase(await requireCase(id));
}

export async function updateCase(id, values) {
  await requireCase(id);
  const row = await caseRepository.update(id, values);
  return toCase(row);
}

export async function assignOfficer(caseId, { userId, roleOnCase }, assignedBy) {
  await requireCase(caseId);

  const user = await userRepository.findById(userId);
  if (!user || user.status !== "ACTIVE") throw notFound("user not found");


  await caseRepository.assignOfficer({
    caseId,
    userId,
    roleOnCase,
    assignedBy,
  });
  return toCase(await requireCase(caseId));
}

export async function removeOfficer(caseId, userId) {
  await requireCase(caseId);
  const removed = await caseRepository.removeOfficer(caseId, userId);
  if (!removed) throw notFound("case officer assignment not found");
  return toCase(await requireCase(caseId));
}

export async function placeLegalHold(caseId, reason) {
  await requireCase(caseId);
  const row = await caseRepository.update(caseId, {
    legalHold: true,
    legalHoldReason: reason,
  });
  return toCase(row);
}

export async function releaseLegalHold(caseId) {
  const row = await requireCase(caseId);
  if (!row.legalHold) throw conflict("case is not on legal hold");
  const updated = await caseRepository.update(caseId, {
    legalHold: false,
    legalHoldReason: null,
  });
  return toCase(updated);
}