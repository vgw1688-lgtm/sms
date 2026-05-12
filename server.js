const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const SMSOK_API_KEY = process.env.SMSOK_API_KEY;
const SMSOK_API_SECRET = process.env.SMSOK_API_SECRET;
const SMSOK_SENDER = process.env.SMSOK_SENDER;

const SMSOK_SEND_URL = "https://api.smsok.co/s";
const REPORT_FILE = path.join(__dirname, "report.json");

const MAX_DESTINATIONS = 500;
const MAX_SMS_LENGTH = 500;

/**
 * หน้าแรกไว้เช็คว่า Server รันอยู่
 */
app.get("/", (req, res) => {
  res.status(200).send("LINE SMS BOT OK");
});

/**
 * LINE Webhook
 */
app.post("/webhook", async (req, res) => {
  // สำคัญ: ตอบ 200 ให้ LINE ก่อน เพื่อไม่ให้ Verify fail
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

/**
 * จัดการ event จาก LINE
 */
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

/**
 * คำสั่งส่ง SMS
 * /sms 0812345678 ข้อความ
 * /sms 0812345678,0899999999 ข้อความ
 */
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
    raw: result.raw || "",
    error: result.error || ""
  });

  if (result.success) {
    let msg = "✅ ส่ง SMS สำเร็จ\n\n";
    msg += "ผู้ส่งคำสั่ง: " + lineName + "\n";
    msg += "จำนวนเบอร์: " + parsed.phones.length + " เบอร์";

    if (result.data?.destinations && result.data.destinations.length > 0) {
      msg += "\n\nสถานะปลายทาง:";

      result.data.destinations.slice(0, 10).forEach((item) => {
        msg += "\n" + item.destination + " = " + (item.status || "sent");
      });

      if (result.data.destinations.length > 10) {
        msg += "\n...แสดง 10 รายการแรก";
      }
    }

    await replyLine(event.replyToken, msg);
  } else {
    let msg = "❌ ส่ง SMS ไม่สำเร็จ\n\n";
    msg += "ผู้ส่งคำสั่ง: " + lineName + "\n";
    msg += "จำนวนเบอร์: " + parsed.phones.length + " เบอร์\n";
    msg += "สาเหตุ: " + result.error;

    await replyLine(event.replyToken, msg);
  }
}

/**
 * แยกคำสั่ง SMS
 */
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

  if (message.length > MAX_SMS_LENGTH) {
    return {
      ok: false,
      error:
        "❌ ข้อความยาวเกินไป\n" +
        "ความยาวตอนนี้: " +
        message.length +
        " ตัวอักษร\n" +
        "จำกัดไม่เกิน: " +
        MAX_SMS_LENGTH +
        " ตัวอักษร"
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

  if (uniquePhones.length > MAX_DESTINATIONS) {
    return {
      ok: false,
      error: "❌ ส่งได้สูงสุด " + MAX_DESTINATIONS + " เบอร์ต่อครั้ง"
    };
  }

  const invalidPhones = uniquePhones.filter((p) => !isValidThaiPhone(p));

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

/**
 * ส่ง SMS ผ่าน SMSOK
 */
async function sendSmsOk(phones, message) {
  try {
    if (!SMSOK_API_KEY || !SMSOK_API_SECRET || !SMSOK_SENDER) {
      return {
        success: false,
        error: "ยังไม่ได้ตั้งค่า SMSOK_API_KEY / SMSOK_API_SECRET / SMSOK_SENDER ใน Render Environment",
        data: {},
        raw: ""
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
    const raw = safeStringify(data);

    if (response.status === 200 || response.status === 201) {
      return {
        success: true,
        data,
        raw
      };
    }

    return {
      success: false,
      error: getApiErrorText(data, raw, response.status),
      data,
      raw
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || "Unknown error",
      data: {},
      raw: ""
    };
  }
}

/**
 * แปลง error จาก API ให้เป็นข้อความอ่านรู้เรื่อง
 */
function getApiErrorText(data, raw, statusCode) {
  if (data) {
    if (typeof data === "string") return data;

    if (typeof data.message === "string") return data.message;
    if (data.message) return safeStringify(data.message);

    if (typeof data.error === "string") return data.error;
    if (data.error) return safeStringify(data.error);

    if (typeof data.detail === "string") return data.detail;
    if (data.detail) return safeStringify(data.detail);

    if (Array.isArray(data.errors)) return safeStringify(data.errors);

    if (Object.keys(data).length > 0) {
      return safeStringify(data);
    }
  }

  return raw || "HTTP " + statusCode;
}

/**
 * ตอบกลับ LINE
 */
async function replyLine(replyToken, message) {
  if (!LINE_ACCESS_TOKEN) {
    console.error("Missing LINE_ACCESS_TOKEN");
    return;
  }

  try {
    const response = await axios.post(
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

    if (response.status < 200 || response.status >= 300) {
      console.error("LINE reply error:", response.status, safeStringify(response.data));
    }
  } catch (err) {
    console.error("Reply LINE failed:", err.message);
  }
}

/**
 * ดึงชื่อ LINE ของคนสั่ง
 */
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

/**
 * อ่าน report.json
 */
function readReport() {
  try {
    if (!fs.existsSync(REPORT_FILE)) {
      return {
        logs: [],
        daily: {}
      };
    }

    const raw = fs.readFileSync(REPORT_FILE, "utf8");
    if (!raw.trim()) {
      return {
        logs: [],
        daily: {}
      };
    }

    return JSON.parse(raw);
  } catch (err) {
    console.error("Read report error:", err.message);
    return {
      logs: [],
      daily: {}
    };
  }
}

/**
 * เขียน report.json
 */
function writeReport(data) {
  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Write report error:", err.message);
  }
}

/**
 * บันทึกรีพอร์ต
 */
function saveReport(item) {
  const data = readReport();
  const date = getTodayText();

  if (!Array.isArray(data.logs)) data.logs = [];
  if (!data.daily) data.daily = {};

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
      failCount: 0
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

  writeReport(data);
}

/**
 * รายงานวันนี้ ไม่โชว์เครดิต
 */
function buildTodayReport() {
  const data = readReport();
  const date = getTodayText();
  const today = data.daily?.[date] || {};
  const rows = Object.values(today);

  if (rows.length === 0) {
    return "ยังไม่มีรายงานวันนี้";
  }

  let totalSend = 0;
  let totalPhone = 0;
  let totalSuccess = 0;
  let totalFail = 0;

  let msg = "📊 รายงานส่ง SMS วันนี้\n";
  msg += "วันที่: " + date + "\n\n";

  for (const row of rows) {
    totalSend += Number(row.sendCount) || 0;
    totalPhone += Number(row.phoneCount) || 0;
    totalSuccess += Number(row.successCount) || 0;
    totalFail += Number(row.failCount) || 0;

    msg += "👤 " + row.lineName + "\n";
    msg += "สั่งส่ง: " + row.sendCount + " ครั้ง\n";
    msg += "จำนวนเบอร์: " + row.phoneCount + " เบอร์\n";
    msg += "สำเร็จ: " + row.successCount + " / ไม่สำเร็จ: " + row.failCount + "\n\n";
  }

  msg += "รวมทั้งหมด\n";
  msg += "สั่งส่ง: " + totalSend + " ครั้ง\n";
  msg += "จำนวนเบอร์: " + totalPhone + " เบอร์\n";
  msg += "สำเร็จ: " + totalSuccess + "\n";
  msg += "ไม่สำเร็จ: " + totalFail;

  return msg;
}

/**
 * วันที่ไทย
 */
function getTodayText() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

/**
 * ตรวจเบอร์ไทย
 */
function isValidThaiPhone(phone) {
  return /^0[689]\d{8}$/.test(phone);
}

/**
 * กัน JSON.stringify พัง
 */
function safeStringify(value) {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

/**
 * ข้อความช่วยเหลือ
 */
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
