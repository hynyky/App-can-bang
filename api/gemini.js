import crypto from "node:crypto";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function getAuthSecret() {
  const base = process.env.AUTH_SECRET || `${process.env.APP_PASSWORD || "baoanhkiet"}:cb-secret-2026`;
  return crypto.createHash("sha256").update(base).digest("hex");
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", getAuthSecret()).update(data).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export default {
  async fetch(request) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!verifyToken(token)) {
      return json({ error: "Vui lòng mở khóa mật khẩu trước khi dùng AI." }, 401);
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return json({ error: "Chưa cấu hình GEMINI_API_KEY trong Biến môi trường trên Vercel." }, 500);
    }

    try {
      const { prompt, imageBase64, expectJson = true } = await request.json();
      const parts = [{ text: String(prompt || "") }];

      if (imageBase64 && String(imageBase64).includes("base64,")) {
        const [meta, b64] = String(imageBase64).split("base64,");
        const mimeMatch = meta.match(/data:([^;]+);/);
        parts.push({
          inlineData: {
            mimeType: mimeMatch ? mimeMatch[1] : "image/jpeg",
            data: b64
          }
        });
      }

      const payload = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.35,
          ...(expectJson ? { responseMimeType: "application/json" } : {})
        }
      };

      // Thử lần lượt các model Gemini Flash ổn định
      const models = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"];
      let lastErr = "Không kết nối được Gemini AI.";

      for (const model of models) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },
            body: JSON.stringify(payload)
          }
        );

        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
          return json({ ok: true, model, text });
        }

        lastErr = data?.error?.message || `HTTP ${res.status}`;
        if (res.status !== 404 && res.status !== 400) break;
      }

      return json({ error: lastErr }, 502);
    } catch (err) {
      return json({ error: "Lỗi xử lý AI: " + err.message }, 500);
    }
  }
};
