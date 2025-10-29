import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const XOR_KEY = 125;

// ---------------------------
// 简单异或解密函数（用于 .m3u8）
// ---------------------------
function simpleDecrypt(enc, key = XOR_KEY) {
  const buf = Buffer.from(enc, "base64").toString("utf8");
  let result = "";
  for (let i = 0; i < buf.length; i++) {
    result += String.fromCharCode(buf.charCodeAt(i) ^ key);
  }
  return result;
}

// 判断是否 TS 文件（只用 Base64 解码）
function isTsFile(enc) {
  try {
    const decoded = Buffer.from(enc, "base64").toString("utf8");
    return decoded.endsWith(".ts");
  } catch {
    return false;
  }
}

// ---------------------------
// 自定义 fetch 函数（带重试 + Headers）
// ---------------------------
async function fetchWithRetry(url, options = {}, retries = 3) {
  const defaultHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://yunmei.tv/",
    "Origin": "https://yunmei.tv",
    "Connection": "keep-alive"
  };

  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10 秒超时
      const response = await fetch(url, {
        ...options,
        headers: { ...defaultHeaders, ...(options.headers || {}) },
        signal: controller.signal
      });
      clearTimeout(timeout);
      return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`⚠️ Fetch failed (attempt ${i + 1}/${retries}), retrying...`);
      await new Promise(r => setTimeout(r, 1000)); // 等 1 秒再重试
    }
  }
}

// ---------------------------
// 主代理路由
// ---------------------------
app.get("/pp", async (req, res) => {
  const enc = req.query.jj; // jj 参数
  if (!enc) return res.status(400).send("Missing 'jj' parameter");

  let url;
  try {
    if (isTsFile(enc)) {
      // TS 文件 → Base64 解码
      url = Buffer.from(enc, "base64").toString("utf8");
    } else {
      // m3u8 → 异或解密
      url = simpleDecrypt(decodeURIComponent(enc));
    }
  } catch (err) {
    return res.status(400).send("Invalid 'jj' parameter");
  }

  try {
    const response = await fetchWithRetry(url);

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}`);
    }

    if (url.endsWith(".m3u8")) {
      let data = await response.text();
      const baseUrl = url.substring(0, url.lastIndexOf("/") + 1);
      const direct = req.query.dd === "1"; // 是否直连模式

      // 替换 TS 路径 → Base64 编码 + jj 参数
      data = data.replace(/(.*\.ts)/g, (match) => {
        const tsUrl = baseUrl + match;
        if (direct) {
          // 直连模式：返回真实 ts 链接
          return tsUrl;
        } else {
          // 代理模式：返回代理地址
          const encTs = Buffer.from(tsUrl).toString("base64");
          return `/pp?jj=${encodeURIComponent(encTs)}`;
        }
      });

      res.set("Content-Type", response.headers.get("content-type") || "application/vnd.apple.mpegurl");
      res.set("Access-Control-Allow-Origin", "*");
      res.send(data);
    } else {
      // TS 或其他二进制文件
      const buffer = await response.arrayBuffer();
      res.set("Content-Type", response.headers.get("content-type") || "application/octet-stream");
      res.set("Access-Control-Allow-Origin", "*");
      res.send(Buffer.from(buffer));
    }
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy error: " + err.message);
  }
});

// ---------------------------
// 健康检查路由（Render ping）
// ---------------------------
app.get("/health", (req, res) => {
  res.status(200).send("✅ OK - Service is running");
});

// ---------------------------
// 启动服务
// ---------------------------
app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));
