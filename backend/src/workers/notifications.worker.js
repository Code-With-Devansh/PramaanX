import { Worker } from 'bullmq';
import * as notificationService from '../services/notifications.service.js';
import { connection } from "../jobs/connection.js";
import { publishNotificationEvent } from "../realtime/publisher.js";

export const mentionNotificationWorker = new Worker("mention-notifications", async (job) => {
    console.log(`Processing mention notification job: ${job.id}`);
    console.log(`Job data: ${JSON.stringify(job.data)}`);
    const { commentId, caseId, mentionedUserId, authorId } = job.data;
    const notification = await notificationService.sendMentionNotification({
      commentId,
      caseId,
      mentionedUserId,
      authorId,
    });
    await publishNotificationEvent(notification).catch((error) => {
      console.error(`Could not publish notification ${notification.id}:`, error);
    });
    return notification;

}, {
    connection,
});


mentionNotificationWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed!`);
});

mentionNotificationWorker.on('failed', (job, error) => {
  console.error(`Mention notification job ${job?.id ?? "unknown"} failed:`, error);
});

mentionNotificationWorker.on('error', (error) => {
  console.error("Mention notification worker error:", error);
});



console.log("Mention notification worker started..");