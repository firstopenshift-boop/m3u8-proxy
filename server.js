import express from "express";
import fetch from "node-fetch"; // 若用 node 18+ 的内置 fetch，可移除此行并直接使用全局 fetch
import { URL } from "url";

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

// 构建 fetch 时的 headers（尽量模仿浏览器）
function buildFetchHeaders(req, targetUrl) {
  const headers = {};

  // User-Agent（优先使用客户端的 UA，如果没有就用常见 UA）
  headers["User-Agent"] =
    req.headers["user-agent"] ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

  // Referer：优先使用 query.ref，否则尝试用目标 URL 的 origin（很多站用 Referer 校验）
  if (req.query.ref) {
    headers["Referer"] = req.query.ref;
  } else {
    try {
      const u = new URL(targetUrl);
      headers["Referer"] = `${u.protocol}//${u.host}/`;
    } catch (e) {
      // ignore
    }
  }

  // Accept / Accept-Language
  headers["Accept"] = req.headers["accept"] || "*/*";
  headers["Accept-Language"] = req.headers["accept-language"] || "zh-CN,zh;q=0.9,en;q=0.8";

  // Range（若客户端请求了分片，则转发给源站）
  if (req.headers.range) {
    headers["Range"] = req.headers.range;
  }

  // 转发客户端的 Cookie（若有）
  if (req.headers.cookie) {
    headers["Cookie"] = req.headers.cookie;
  }

  // 尽量不使用压缩，以避免编码问题（一些源站在压缩后对 Range 处理异常）
  headers["Accept-Encoding"] = req.headers["accept-encoding"] || "identity";

  return headers;
}

// 简单的 fetch + 重试（遇网络异常或 5xx/429 时尝试重试）
async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = 15000) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
      clearTimeout(id);

      // 如果状态是临时性错误，尝试重试
      if (!resp.ok && (resp.status === 429 || resp.status >= 500)) {
        lastErr = new Error(`Status ${resp.status}`);
        await new Promise((r) => setTimeout(r, 400 * (i + 1))); // backoff
        continue;
      }

      return resp;
    } catch (err) {
      lastErr = err;
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

app.get("/pp", async (req, res) => {
  const enc = req.query.jj; // jj 参数
  if (!enc) return res.status(400).send("Missing 'jj' parameter");

  let url;
  try {
    if (isTsFile(enc)) {
      // TS 文件 → Base64 解码
      url = Buffer.from(enc, "base64").toString("utf8");
    } else {
      // m3u8 → 异或解密（保留你原来的 decodeURIComponent）
      url = simpleDecrypt(decodeURIComponent(enc));
    }
    console.log("[/pp] 解密后的 URL:", url);
  } catch (err) {
    console.error("[/pp] 解密失败:", err);
    return res.status(400).send("Invalid 'jj' parameter");
  }

  try {
    // 构建 fetch headers（转发 Range、Cookie、UA、Referer 等）
    const fetchHeaders = buildFetchHeaders(req, url);

    // 发起请求（带重试）
    const response = await fetchWithRetry(url, { headers: fetchHeaders }, 2);

    // 若 origin 返回 403/404，直接返回给客户端（并记录）
    if (response.status === 403 || response.status === 404) {
      console.warn(`[proxy] origin returned ${response.status} for ${url}`);
      return res.status(response.status).send(`Origin returned ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";

    // 判断 m3u8（基于 URL 后缀或 response content-type）
    if (url.endsWith(".m3u8") || contentType.includes("mpegurl") || contentType.includes("application/vnd.apple.mpegurl")) {
      let data = await response.text();
      const baseUrl = url.substring(0, url.lastIndexOf("/") + 1);
      const direct = req.query.dd === "1";

      // 用更保守的正则只替换行内以 .ts 结尾或含 .ts 的行
      // 支持相对路径和带查询参数的 ts
      data = data.replace(/(^.*\.ts(?:[^\s]*)\s*$)/gm, (match) => {
        // trim 行尾空格
        const tsPath = match.trim();
        // 如果已经是绝对 URL，则不拼 baseUrl
        const tsUrl = /^https?:\/\//i.test(tsPath) ? tsPath : (baseUrl + tsPath);
        if (direct) {
          return tsUrl;
        } else {
          const encTs = Buffer.from(tsUrl).toString("base64");
          return `/pp?jj=${encodeURIComponent(encTs)}`;
        }
      });

      // 设置响应头并返回文本
      res.set("Content-Type", response.headers.get("content-type") || "application/vnd.apple.mpegurl");
      res.set("Access-Control-Allow-Origin", "*");
      const cacheControl = response.headers.get("cache-control");
      if (cacheControl) res.set("Cache-Control", cacheControl);

      return res.send(data);
    } else {
      // 二进制流（例如 .ts） - 转发关键 header 并流式返回
      res.status(response.status);

      const passHeaders = [
        "content-type",
        "content-range",
        "content-length",
        "accept-ranges",
        "cache-control",
        "etag",
        "last-modified"
      ];
      passHeaders.forEach((h) => {
        const v = response.headers.get(h);
        if (v) res.set(h, v);
      });

      res.set("Access-Control-Allow-Origin", "*");

      // 如果 response.body 是流，直接 pipe 到 res（高效）
      if (response.body && typeof response.body.pipe === "function") {
        // node-fetch 返回的 body 是 readable stream，可以直接 pipe
        response.body.pipe(res);
      } else {
        // fallback：读取为 ArrayBuffer 然后发送（不推荐，可能占用内存）
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));
      }
    }
  } catch (err) {
    console.error("[/pp] Proxy error:", err);
    // 如果是 fetch 被 abort（超时），返回 504
    if (err.name === "AbortError") {
      return res.status(504).send("Upstream request timed out");
    }
    res.status(500).send("Proxy error: " + (err.message || String(err)));
  }
});

app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));
