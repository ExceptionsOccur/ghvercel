import https from 'https';
import { parse } from 'url';

export default async function handler(req, res) {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { query } = parse(req.url, true);
  const { type = 'raw', path = '' } = query;

  try {
    switch (type) {
      case 'raw':
        await proxyRaw(req, res, path);
        break;
      case 'repo':
      case 'git':
        await proxyGit(req, res, path);
        break;
      case 'download':
        await proxyDownload(req, res, path);
        break;
      case 'avatar':
        await proxyAvatar(req, res, path);
        break;
      default:
        // 通用代理
        const { url } = query;
        if (url) {
          await proxyGeneric(req, res, url);
        } else {
          res.status(400).json({ error: 'Invalid request' });
        }
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
}

// GitHub 域名映射
const GITHUB_DOMAINS = {
  'raw': 'raw.githubusercontent.com',
  'repo': 'github.com',
  'git': 'github.com',
  'download': 'github.com',
  'avatar': 'avatars.githubusercontent.com'
};

// 核心代理函数
function createProxy(targetUrl, req, res) {
  const parsedUrl = new URL(targetUrl);

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: req.method,
    headers: {
      ...req.headers,
      'host': parsedUrl.hostname,
      'User-Agent': 'GitHub-Proxy/1.0',
      'Accept': '*/*'
    }
  };

  // 添加 GitHub Token（如果有）
  if (process.env.GITHUB_TOKEN) {
    options.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }

  const proxyReq = https.request(options, (proxyRes) => {
    // 处理 Git 协议的特殊 Content-Type
    let contentType = proxyRes.headers['content-type'];
    if (options.path.includes('info/refs')) {
      const service = options.path.includes('upload-pack') ? 'upload' : 'receive';
      contentType = `application/x-git-${service}-pack-advertisement`;
    }

    const headers = {
      ...proxyRes.headers,
      'cache-control': 'public, max-age=3600',
      'access-control-expose-headers': '*'
    };

    if (contentType) {
      headers['content-type'] = contentType;
    }

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    console.error('Proxy request error:', error);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy error', details: error.message });
    }
  });

  // 传输请求体
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

// 代理原始文件
async function proxyRaw(req, res, path) {
  const targetUrl = `https://raw.githubusercontent.com/${path}`;
  createProxy(targetUrl, req, res);
}

// 代理 Git 仓库
async function proxyGit(req, res, path) {
  let targetPath = path;

  // 确保路径正确
  if (!targetPath.startsWith('/')) {
    targetPath = '/' + targetPath;
  }

  // 处理 Git 智能协议
  if (req.url.includes('info/refs')) {
    const service = req.url.includes('upload-pack') ? 'git-upload-pack' : 'git-receive-pack';
    targetPath = `${targetPath}/info/refs?service=${service}`;
  }

  const targetUrl = `https://github.com${targetPath}`;
  createProxy(targetUrl, req, res);
}

// 代理下载
async function proxyDownload(req, res, path) {
  const targetUrl = `https://github.com/${path}`;
  createProxy(targetUrl, req, res);
}

// 代理头像
async function proxyAvatar(req, res, path) {
  const targetUrl = `https://avatars.githubusercontent.com/${path}`;
  createProxy(targetUrl, req, res);
}

// 通用代理
async function proxyGeneric(req, res, url) {
  const decodedUrl = decodeURIComponent(url);
  createProxy(decodedUrl, req, res);
}