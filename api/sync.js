import crypto from "node:crypto";

const ROOM_KEY = "cb:shared:baoanhkiet:v1";

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

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest();
}

function checkPassword(input) {
  const expected = process.env.APP_PASSWORD || "baoanhkiet";
  return crypto.timingSafeEqual(sha256(input), sha256(expected));
}

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", getAuthSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
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

async function redisCmd(args) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Chưa kết nối Upstash Redis trong tab Storage của Vercel.");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `Redis HTTP ${res.status}`);
  }
  return data.result;
}

async function readRoom() {
  const raw = await redisCmd(["GET", ROOM_KEY]);
  if (!raw) {
    return { version: 0, updatedByName: "", deviceId: "", state: null, mealFeed: [] };
  }
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { version: 0, updatedByName: "", deviceId: "", state: null, mealFeed: [] };
  }
}

async function writeRoom(room) {
  await redisCmd(["SET", ROOM_KEY, JSON.stringify(room)]);
}

export default {
  async fetch(request) {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "";

    try {
      const body = await request.json().catch(() => ({}));

      // 1. Mở khóa mật khẩu
      if (action === "unlock") {
        const pass = String(body.password || "").trim();
        const roleName = String(body.roleName || "Thành viên").trim().slice(0, 30) || "Thành viên";
        if (!checkPassword(pass)) {
          return json({ error: "Sai mật khẩu! Hãy kiểm tra lại." }, 401);
        }
        const token = signToken({ roleName, iat: Date.now() });
        return json({ ok: true, token, roleName });
      }

      // Kiểm tra token cho các thao tác đồng bộ
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const session = verifyToken(token);
      if (!session) return json({ error: "Phiên đăng nhập hết hạn." }, 401);

      // 2. Kiểm tra nhanh version mới
      if (action === "check") {
        const room = await readRoom();
        return json({ version: room.version || 0, updatedByName: room.updatedByName || "", deviceId: room.deviceId || "" });
      }

      // 3. Lấy toàn bộ dữ liệu + ảnh đồ ăn
      if (action === "get") {
        const room = await readRoom();
        return json(room);
      }

      // 4. Lưu trạng thái ứng dụng (Hồ sơ, Nhật ký, Tủ lạnh, Thực đơn, Cân nặng)
      if (action === "saveState") {
        const room = await readRoom();
        const now = Date.now();
        room.version = now;
        room.updatedByName = session.roleName;
        room.deviceId = body.deviceId || "";
        room.state = body.state || {};
        await writeRoom(room);
        return json({ ok: true, version: now });
      }

      // 5. Đăng ảnh đồ ăn mới lên bảng trực tiếp
      if (action === "postMeal") {
        const room = await readRoom();
        if (!Array.isArray(room.mealFeed)) room.mealFeed = [];

        const entry = {
          id: "m_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex"),
          authorName: session.roleName,
          time: Date.now(),
          title: String(body.title || "Vừa chụp bữa ăn").trim().slice(0, 120),
          kcal: Number(body.kcal || 0),
          protein: Number(body.protein || 0),
          note: String(body.note || "").trim().slice(0, 400),
          imageData: String(body.imageData || "").slice(0, 180000) // ảnh nén ~30-60KB
        };

        room.mealFeed.unshift(entry);
        room.mealFeed = room.mealFeed.slice(0, 18); // Giữ 18 bữa ăn có ảnh gần nhất
        room.version = Date.now();
        room.updatedByName = session.roleName;
        room.deviceId = body.deviceId || "";
        if (body.state) room.state = body.state;

        await writeRoom(room);
        return json({ ok: true, entry, version: room.version, mealFeed: room.mealFeed });
      }

      // 6. Cập nhật tên món/calo AI vào bữa ảnh vừa đăng
      if (action === "updateMeal") {
        const room = await readRoom();
        if (!Array.isArray(room.mealFeed)) room.mealFeed = [];
        const item = room.mealFeed.find((x) => x.id === body.mealId);
        if (item) {
          if (body.title) item.title = String(body.title).slice(0, 120);
          if (body.kcal !== undefined) item.kcal = Number(body.kcal || 0);
          if (body.protein !== undefined) item.protein = Number(body.protein || 0);
          if (body.note !== undefined) item.note = String(body.note).slice(0, 400);
          room.version = Date.now();
          room.updatedByName = session.roleName;
          room.deviceId = body.deviceId || "";
          await writeRoom(room);
        }
        return json({ ok: true, version: room.version, mealFeed: room.mealFeed });
      }

      // 7. Xóa ảnh bữa ăn
      if (action === "deleteMeal") {
        const room = await readRoom();
        room.mealFeed = (room.mealFeed || []).filter((x) => x.id !== body.mealId);
        room.version = Date.now();
        room.updatedByName = session.roleName;
        room.deviceId = body.deviceId || "";
        await writeRoom(room);
        return json({ ok: true, version: room.version, mealFeed: room.mealFeed });
      }

      return json({ error: "Unknown action" }, 400);
    } catch (err) {
      return json({ error: err.message || "Lỗi đồng bộ" }, 500);
    }
  }
};
