import { WebSocket, WebSocketServer } from "ws";
import { verifyAccessToken } from "../lib/tokens.js";
import { accessTokenKey, hashAccessToken } from "../utils/hashToken.js";

export async function attachRealtimeServer(httpServer, redisClient) {
  const subscriber = redisClient.duplicate();
  await subscriber.connect();

  const socketsByUser = new Map();
  const webSocketServer = new WebSocketServer({ noServer: true });

  await subscriber.pSubscribe("user:*:notifications", (message, channel) => {

    const userId = channel.slice("user:".length, -":notifications".length);
    const sockets = socketsByUser.get(userId);
    if (!sockets) return;

    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  });

  httpServer.on("upgrade", async (request, socket, head) => {
    console.log(`Incoming WebSocket upgrade request: ${request.url}`);
    try {
      const requestUrl = new URL(request.url, "http://localhost:3000");
      if (requestUrl.pathname !== "/notifications") {
        socket.destroy();
        return;
      }

      const token = request.headers?.authorization?.split(" ")[1];
      if (!token) throw new Error("missing access token");

      const payload = verifyAccessToken(token);
      if (!payload) throw new Error("invalid access token");

      const storedTokenHash = await redisClient.get(accessTokenKey(payload.sub));
      if (!storedTokenHash || storedTokenHash !== hashAccessToken(token)) {
        throw new Error("access token revoked or invalid");
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        const userId = payload.sub;
        let sockets = socketsByUser.get(userId);
        if (!sockets) {
          sockets = new Set();
          socketsByUser.set(userId, sockets);
        }
        sockets.add(webSocket);

        webSocket.send(JSON.stringify({ type: "connected" }));
        webSocket.on("close", () => {
          sockets.delete(webSocket);
          if (sockets.size === 0) {
            socketsByUser.delete(userId);
          }
        });
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    }
  });

  return {
    async close() {
      webSocketServer.close();
      await subscriber.quit();
    },
  };
}