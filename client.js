// socket-test.js
import { io } from "socket.io-client";

// ✅ URL server Railway của bạn
const SERVER_URL = "https://embeddedprogramming-healtheworldserver.up.railway.app";

console.log("🚀 Connecting to", SERVER_URL, "...");

// ✅ Khởi tạo socket client
const socket = io(SERVER_URL, {
  transports: ["websocket"], // chỉ dùng WebSocket, tránh fallback HTTP polling
  reconnectionAttempts: 5,
  timeout: 5000,
});

// Khi kết nối thành công
socket.on("connect", () => {
  console.log("✅ Connected to server!");
  console.log("🔗 Socket ID:", socket.id);

  // Gửi thử message lên server
  socket.emit("client_message", "Hello from Node.js client 👋");
});

// Khi server emit event "status"
socket.on("status", (data) => {
  console.log("📡 Received 'status' event:", data);
});

// Khi bị ngắt kết nối
socket.on("disconnect", (reason) => {
  console.log("❌ Disconnected:", reason);
});

// Khi gặp lỗi kết nối
socket.on("connect_error", (err) => {
  console.error("⚠️ Connection error:", err.message);
});
