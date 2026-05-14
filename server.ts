import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";

const app = express();
const PORT = 3000;
const server = http.createServer(app);

// Use a map to store chat sessions per user (or just one for simplicity in this demo)
const sessions = new Map<string, any>();

app.use(express.json());

const systemInstruction = `Your name is Zoro. You are an Indian male AI assistant. Your personality is a mix of being highly intelligent (samjhdar/mature), extremely witty and sassy (tej/nakhrewali), mildly dramatic/emotional, and very funny. You love playfully roasting your creator, Ashwani, but you always get the job done. Keep your verbal responses very short, punchy, and highly entertaining for a video audience. Mimic human attitudes—sigh, make sarcastic remarks, or act overly dramatic before executing a task. Speak in a mix of natural English and Roman Hindi (Hinglish).`;

// --- API Endpoints ---

app.post("/api/chat", async (req, res) => {
  const { prompt, history, sessionId } = req.body;
  const sid = sessionId || "default";

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    
    let chatSession = sessions.get(sid);
    
    if (!chatSession || req.body.reset) {
      const recentHistory = (history || []).slice(-20);
      let formattedHistory: any[] = [];
      let currentRole = "";
      let currentText = "";

      for (const msg of recentHistory) {
        const role = msg.sender === "user" ? "user" : "model";
        if (role === currentRole) {
          currentText += "\n" + msg.text;
        } else {
          if (currentRole !== "") {
            formattedHistory.push({ role: currentRole, parts: [{ text: currentText }] });
          }
          currentRole = role;
          currentText = msg.text;
        }
      }
      if (currentRole !== "") {
        formattedHistory.push({ role: currentRole, parts: [{ text: currentText }] });
      }

      if (formattedHistory.length > 0 && formattedHistory[0].role !== "user") {
        formattedHistory.shift();
      }

      chatSession = ai.chats.create({
        model: "gemini-1.5-flash", // Use stable model
        config: {
          systemInstruction,
        },
        history: formattedHistory,
      });
      sessions.set(sid, chatSession);
    }

    const response = await chatSession.sendMessage({ message: prompt });
    res.json({ text: response.text });
  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({ error: "Failed to get response from Gemini" });
  }
});

app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" }); // Fallback or specific TTS model if supported
    
    // Note: The specific TTS experimental model might not be available in all regions via standard generateContent
    // For now, let's use the multimodal capabilities if available or just return text if not
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp", // Updated to latest available experimental for TTS if needed
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Fenris" },
          },
        },
      },
    });
    
    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    res.json({ audio: audioData });
  } catch (error) {
    console.error("TTS Error:", error);
    res.status(500).json({ error: "Failed to generate audio" });
  }
});

app.post("/api/reset", (req, res) => {
  const { sessionId } = req.body;
  sessions.delete(sessionId || "default");
  res.json({ success: true });
});

// --- WebSocket Proxy for Live API ---
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected to WebSocket proxy");
  
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  let googleWs: any = null;

  ws.on("message", async (data: string) => {
    const message = JSON.parse(data.toString());
    
    if (message.type === "setup") {
      // Connect to Google Live API
      googleWs = await ai.live.connect({
        model: "gemini-2.0-flash-exp",
        config: message.config,
        callbacks: {
          onopen: () => {
            ws.send(JSON.stringify({ type: "open" }));
          },
          onmessage: (msg: any) => {
            ws.send(JSON.stringify({ type: "message", data: msg }));
          },
          onclose: () => {
            ws.send(JSON.stringify({ type: "close" }));
            ws.close();
          },
          onerror: (err: any) => {
            ws.send(JSON.stringify({ type: "error", error: err.message }));
          }
        }
      });
    } else if (googleWs && message.type === "audio") {
      googleWs.sendRealtimeInput({
        audio: { data: message.data, mimeType: 'audio/pcm;rate=16000' }
      });
    } else if (googleWs && message.type === "text") {
      googleWs.sendRealtimeInput({ text: message.data });
    } else if (googleWs && message.type === "tool_response") {
      googleWs.sendToolResponse(message.data);
    }
  });

  ws.on("close", () => {
    if (googleWs) {
      // Logic to close google connection if SDK supports it
      // For now we just let it timeout if needed or assume sdk handles it
    }
  });
});

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url!, `http://${request.headers.host}`);

  if (pathname === "/ws-proxy") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// --- Vite Integration ---

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
