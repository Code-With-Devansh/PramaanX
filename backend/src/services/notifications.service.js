import { notFound } from "../lib/errors.js";
import * as repository from "../repositories/notifications.repository.js";
import userRepository from "../repositories/user.repository.js";
import caseRepository from "../repositories/case.repository.js";


export async function listNotifications(userId, pagination) {
  const { items, total } = await repository.listForUser(userId, pagination);
  return {
    items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages: Math.ceil(total / pagination.pageSize),
  };
}

export async function markNotificationRead(userId, notificationId) {
  const notification = await repository.markRead(userId, notificationId);
  if (!notification) throw notFound("notification not found");
}

export async function markAllNotificationsRead(userId) {
  await repository.markAllRead(userId);
}

export async function sendMentionNotification({ commentId, caseId, mentionedUserId, authorId }) {
  const author = await userRepository.findById(authorId);
  const storedCase = await caseRepository.findById(caseId);

  const authorName = author?.fullName ?? "another user";
  const caseTitle = storedCase?.title ?? caseId;

  return repository.create({
    userId: mentionedUserId,
    type: "mention",
    message: `You were mentioned in a comment on case ${caseTitle} by ${authorName}.`,
    link: `/cases/${caseId}?comment=${commentId}`,
    read: false,
  });
}
