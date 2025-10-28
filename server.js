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
    //console.log("解密后的 URL:", url);
  } catch (err) {
    return res.status(400).send("Invalid 'jj' parameter");
  }

  try {
    const response = await fetch(url);

    if (url.endsWith(".m3u8")) {
      let data = await response.text();
      const baseUrl = url.substring(0, url.lastIndexOf("/") + 1);

      // 替换 TS 路径 → Base64 编码 + jj 参数
      const direct = req.query.dd === "1"; // 是否直连模式

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

app.listen(PORT, () => console.log(`✅ Proxy running on port ${PORT}`));
