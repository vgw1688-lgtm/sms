const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const SMSOK_API_KEY = process.env.SMSOK_API_KEY;
const SMSOK_API_SECRET = process.env.SMSOK_API_SECRET;
const SMSOK_SENDER = process.env.SMSOK_SENDER;

const SMSOK_SEND_URL = "https://api.smsok.co/s";
const REPORT_FILE = path.join(__dirname, "report.json");

app.get("/", (req, res) => {
  res.status(200).send("LINE SMS BOT OK");
});

app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");

  try {
    const events = req.body.events || [];

    for (const event of events) {
      await handleLineEvent(event);
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

async function handleLineEvent(event) {
  if (event.type !== "message") return;
  if (!event.message || event.message.type !== "text") return;

  const text = String(event.message.text || "").trim();

  if (text === "/help") {
    await replyLine(event.replyToken, getHelpText());
    return;
  }

  if (text === "/report") {
    await replyLine(event.replyToken, buildTodayReport());
    return;
  }

  if (text.startsWith("/sms ")) {
    await handleSmsCommand(event, text);
    return;
  }
}

async function handleSmsCommand(event, text) {
  const parsed = parseSmsCommand(text);

  if (!parsed.ok) {
    await replyLine(event.replyToken, parsed.error);
    return;
  }

  const source = event.source || {};
  const userId = source.userId || "";
  const groupId = source.groupId || "";
  const roomId = source.roomId || "";
  const chatId = groupId || roomId || userId;

  const lineName = await getLineDisplayName(userId, groupId, roomId);

  const result = await sendSmsOk(parsed.phones, parsed.message);

  saveReport({
    lineName,
    userId,
    chatId,
    phones: parsed.phones,
    message: parsed.message,
    success: result.success,
    totalPrice: Number(result.data?.total_price || 0),
    raw: result.raw || "",
    error: result.error || ""
  });

  if (result.success) {
    let msg = "✅ ส่ง SMS สำเร็จ\n\n";
    msg += "ผู้ส่งคำสั่ง: " + lineName + "\n";
    msg += "จำนวนเบอร์: " + parsed.phones.length + "\n";
    msg += "ข้อความ: " + parsed.message;

    if (result.data?.total_price !== undefined) {
      msg += "\nใช้เครดิต: " + result.data.total_price;
    }

    if (result.data?.remaining_balance !== undefined) {
      msg += "\nเครดิตคงเหลือ: " + result.data.remaining_balance;
    }

    await replyLine(event.replyToken, msg);
  } else {
    await replyLine(
      event.replyToken,
      "❌ ส่ง SMS ไม่สำเร็จ\n\n" +
        "ผู้ส่งคำสั่ง: " + lineName + "\n" +
        "สาเหตุ: " + result.error
    );
  }
}

function parseSmsCommand(text) {
  const firstSpace = text.indexOf(" ");

  if (firstSpace === -1) {
    return {
      ok: false,
      error: "❌ รูปแบบผิด\nใช้แบบนี้:\n/sms 0812345678 ข้อความ"
    };
  }

  const afterCommand = text.slice(firstSpace + 1).trim();
  const secondSpace = afterCommand.indexOf(" ");

  if (secondSpace === -1) {
    return {
      ok: false,
      error: "❌ กรุณาใส่เบอร์และข้อความ\n/sms 0812345678 ข้อความ"
    };
  }

  const phoneText = afterCommand.slice(0, secondSpace).trim();
  const message = afterCommand.slice(secondSpace + 1).trim();

  if (!message) {
    return {
      ok: false,
      error: "❌ กรุณาใส่ข้อความ SMS"
    };
  }

  const phones = phoneText
    .split(",")
    .map((p) => p.replace(/[^0-9]/g, ""))
    .filter(Boolean);

  const uniquePhones = [...new Set(phones)];

  if (uniquePhones.length === 0) {
    return {
      ok: false,
      error: "❌ ไม่พบเบอร์โทร"
    };
  }

  if (uniquePhones.length > 500) {
    return {
      ok: false,
      error: "❌ ส่งได้สูงสุด 500 เบอร์ต่อครั้ง"
    };
  }

  const invalidPhones = uniquePhones.filter((p) => !/^0[689]\d{8}$/.test(p));

  if (invalidPhones.length > 0) {
    return {
      ok: false,
      error:
        "❌ พบเบอร์ไม่ถูกต้อง:\n" +
        invalidPhones.join(", ") +
        "\n\nเบอร์ต้องขึ้นต้นด้วย 06, 08, 09 และมี 10 หลัก"
    };
  }

  return {
    ok: true,
    phones: uniquePhones,
    message
  };
}

async function sendSmsOk(phones, message) {
  try {
    if (!SMSOK_API_KEY || !SMSOK_API_SECRET || !SMSOK_SENDER) {
      return {
        success: false,
        error: "ยังไม่ได้ตั้งค่า SMSOK_API_KEY / SMSOK_API_SECRET / SMSOK_SENDER",
        data: {}
      };
    }

    const authText = `${SMSOK_API_KEY}:${SMSOK_API_SECRET}`;
    const authHeader = "Basic " + Buffer.from(authText).toString("base64");

    const payload = {
      sender: SMSOK_SENDER,
      text: message,
      destinations: phones.map((phone) => ({
        destination: phone
      }))
    };

    const response = await axios.post(SMSOK_SEND_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader
      },
      validateStatus: () => true
    });

    const data = response.data || {};
    const raw = JSON.stringify(data);

    if (response.status === 200 || response.status === 201) {
      return {
        success: true,
        data,
        raw
      };
    }

    return {
      success: false,
      error: data.message || data.error || data.detail || raw || "HTTP " + response.status,
      data,
      raw
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      data: {}
    };
  }
}

async function replyLine(replyToken, message) {
  if (!LINE_ACCESS_TOKEN) {
    console.error("Missing LINE_ACCESS_TOKEN");
    return;
  }

  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [
        {
          type: "text",
          text: String(message).slice(0, 4900)
        }
      ]
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + LINE_ACCESS_TOKEN
      },
      validateStatus: () => true
    }
  );
}

async function getLineDisplayName(userId, groupId, roomId) {
  if (!LINE_ACCESS_TOKEN || !userId) return "Unknown";

  let url = "";

  if (groupId) {
    url = `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`;
  } else if (roomId) {
    url = `https://api.line.me/v2/bot/room/${roomId}/member/${userId}`;
  } else {
    url = `https://api.line.me/v2/bot/profile/${userId}`;
  }

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: "Bearer " + LINE_ACCESS_TOKEN
      },
      validateStatus: () => true
    });

    return response.data?.displayName || "Unknown";
  } catch (err) {
    return "Unknown";
  }
}

function readReport() {
  try {
    if (!fs.existsSync(REPORT_FILE)) {
      return { logs: [], daily: {} };
    }

    return JSON.parse(fs.readFileSync(REPORT_FILE, "utf8"));
  } catch (err) {
    return { logs: [], daily: {} };
  }
}

function writeReport(data) {
  fs.writeFileSync(REPORT_FILE, JSON.stringify(data, null, 2));
}

function saveReport(item) {
  const data = readReport();

  const date = getTodayText();

  data.logs.push({
    time: new Date().toISOString(),
    date,
    lineName: item.lineName,
    userId: item.userId,
    chatId: item.chatId,
    phones: item.phones,
    phoneCount: item.phones.length,
    message: item.message,
    status: item.success ? "SUCCESS" : "FAILED",
    totalPrice: item.totalPrice,
    raw: item.raw,
    error: item.error
  });

  if (!data.daily[date]) {
    data.daily[date] = {};
  }

  if (!data.daily[date][item.userId]) {
    data.daily[date][item.userId] = {
      lineName: item.lineName,
      sendCount: 0,
      phoneCount: 0,
      successCount: 0,
      failCount: 0,
      totalPrice: 0
    };
  }

  const row = data.daily[date][item.userId];

  row.lineName = item.lineName;
  row.sendCount += 1;
  row.phoneCount += item.phones.length;

  if (item.success) {
    row.successCount += 1;
  } else {
    row.failCount += 1;
  }

  row.totalPrice += item.totalPrice;

  writeReport(data);
}

function buildTodayReport() {
  const data = readReport();
  const date = getTodayText();
  const today = data.daily[date] || {};
  const rows = Object.values(today);

  if (rows.length === 0) {
    return "ยังไม่มีรายงานวันนี้";
  }

  let totalSend = 0;
  let totalPhone = 0;
  let totalSuccess = 0;
  let totalFail = 0;
  let totalCredit = 0;

  let msg = "📊 รายงานส่ง SMS วันนี้\n";
  msg += "วันที่: " + date + "\n\n";

  for (const row of rows) {
    totalSend += row.sendCount;
    totalPhone += row.phoneCount;
    totalSuccess += row.successCount;
    totalFail += row.failCount;
    totalCredit += row.totalPrice;

    msg += "👤 " + row.lineName + "\n";
    msg += "สั่งส่ง: " + row.sendCount + " ครั้ง\n";
    msg += "จำนวนเบอร์: " + row.phoneCount + " เบอร์\n";
    msg += "สำเร็จ: " + row.successCount + " / ไม่สำเร็จ: " + row.failCount + "\n";
    msg += "เครดิต: " + row.totalPrice + "\n\n";
  }

  msg += "รวมทั้งหมด\n";
  msg += "สั่งส่ง: " + totalSend + " ครั้ง\n";
  msg += "จำนวนเบอร์: " + totalPhone + " เบอร์\n";
  msg += "สำเร็จ: " + totalSuccess + "\n";
  msg += "ไม่สำเร็จ: " + totalFail + "\n";
  msg += "เครดิตรวม: " + totalCredit;

  return msg;
}

function getTodayText() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function getHelpText() {
  return (
    "📌 คำสั่ง SMS Bot\n\n" +
    "ส่ง SMS เบอร์เดียว:\n" +
    "/sms 0812345678 ข้อความ\n\n" +
    "ส่งหลายเบอร์:\n" +
    "/sms 0812345678,0899999999 ข้อความ\n\n" +
    "ดูรายงานวันนี้:\n" +
    "/report\n\n" +
    "ดูคำสั่ง:\n" +
    "/help"
  );
}

app.listen(PORT, () => {
  console.log("LINE SMS BOT running on port " + PORT);
});