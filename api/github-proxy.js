import { createServer } from 'http';
import https from 'https';
import url from 'url';

// GitHub 域名映射
const GITHUB_DOMAINS = {
  'raw.githubusercontent.com': true,
  'github.com': true,
  'github-releases.githubusercontent.com': true,
  'avatars.githubusercontent.com': true,
  'user-images.githubusercontent.com': true,
  'codeload.github.com': true,
  'api.github.com': true,
  'objects.githubusercontent.com': true
};

export default async function handler(req, res) {
  // 处理 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // 路由处理
  if (pathname.startsWith('/raw/')) {
    // 代理 raw.githubusercontent.com
    await proxyRawGitHub(req, res, pathname);
  } else if (pathname.startsWith('/repo/')) {
    // 代理 GitHub 仓库
    await proxyGitHubRepo(req, res, pathname);
  } else if (pathname.startsWith('/download/')) {
    // 代理下载
    await proxyGitHubDownload(req, res, pathname);
  } else if (pathname.startsWith('/avatar/')) {
    // 代理头像
    await proxyGitHubAvatar(req, res, pathname);
  } else if (pathname === '/proxy') {
    // 通用代理（支持所有 GitHub 服务）
    await proxyGeneric(req, res, query);
  } else {
    // 默认首页或自定义页面
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h1>GitHub 全功能代理</h1>
      <p>使用方法：</p>
      <ul>
        <li>原始文件：/raw/{user}/{repo}/{branch}/{path}</li>
        <li>仓库代码：/repo/{user}/{repo}/ (结尾需要加/) </li>
        <li>通用代理：/proxy?url={encoded_github_url}</li>
      </ul>
    `);
  }
}

// 代理 raw.githubusercontent.com
async function proxyRawGitHub(req, res, pathname) {
  const match = pathname.match(/^\/raw\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)/);
  if (!match) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '路径格式错误' }));
    return;
  }

  const [, user, repo, branch, filePath] = match;
  const targetPath = `/${user}/${repo}/${branch}/${filePath}`;

  proxyRequest(req, res, {
    hostname: 'raw.githubusercontent.com',
    path: targetPath
  });
}

// 代理 GitHub 仓库（用于 git clone）
async function proxyGitHubRepo(req, res, pathname) {
  // /repo/{user}/{repo}/ 格式
  const match = pathname.match(/^\/repo\/([^\/]+)\/([^\/]+)\/?/);
  if (!match) {
    res.writeHead(400);
    res.end('Invalid repo path');
    return;
  }

  const [, user, repo] = match;

  // 处理不同的 Git 请求
  const gitPath = pathname.replace(/^\/repo/, '');

  proxyRequest(req, res, {
    hostname: 'github.com',
    path: gitPath
  });
}

// 代理 GitHub 下载
async function proxyGitHubDownload(req, res, pathname) {
  // /download/{user}/{repo}/releases/download/{tag}/{file}
  const path = pathname.replace(/^\/download/, '');

  proxyRequest(req, res, {
    hostname: 'github.com',
    path: path
  });
}

// 代理 GitHub 头像
async function proxyGitHubAvatar(req, res, pathname) {
  const userId = pathname.replace(/^\/avatar\//, '');

  proxyRequest(req, res, {
    hostname: 'avatars.githubusercontent.com',
    path: `/u/${userId}?v=4`
  });
}

// 通用代理函数
async function proxyGeneric(req, res, query) {
  const targetUrl = query.url;

  if (!targetUrl) {
    res.writeHead(400);
    res.end('Missing url parameter');
    return;
  }

  try {
    const parsedTarget = new URL(decodeURIComponent(targetUrl));

    // 检查是否允许的 GitHub 域名
    const hostname = parsedTarget.hostname;
    if (!GITHUB_DOMAINS[hostname]) {
      res.writeHead(403);
      res.end('Domain not allowed');
      return;
    }

    proxyRequest(req, res, {
      hostname: hostname,
      path: parsedTarget.pathname + parsedTarget.search,
      headers: {
        // 传递原始请求头（过滤敏感头）
        ...Object.fromEntries(
          Object.entries(req.headers)
            .filter(([key]) =>
              !['host', 'origin', 'referer'].includes(key.toLowerCase())
            )
        ),
        'User-Agent': 'GitHub-Proxy/1.0'
      }
    });
  } catch (error) {
    res.writeHead(500);
    res.end('Proxy error: ' + error.message);
  }
}

// 核心代理逻辑
function proxyRequest(req, res, options) {
  const {
    hostname,
    path,
    method = req.method,
    headers = {}
  } = options;

  const proxyOptions = {
    hostname,
    port: 443,
    path: path,
    method: method,
    headers: {
      'User-Agent': 'GitHub-Proxy/1.0',
      ...headers,
      'host': hostname
    }
  };

  // 处理 GitHub API 认证（可选）
  if (process.env.GITHUB_TOKEN) {
    proxyOptions.headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }

  const proxyReq = https.request(proxyOptions, (proxyRes) => {
    // 设置响应头
    const responseHeaders = { ...proxyRes.headers };

    // 修改重定向地址为代理地址
    if (responseHeaders.location) {
      const location = responseHeaders.location;
      if (location.includes('github.com') || location.includes('githubusercontent.com')) {
        const encodedUrl = encodeURIComponent(location);
        responseHeaders.location = `${getBaseUrl(req)}/proxy?url=${encodedUrl}`;
      }
    }

    // 设置缓存
    responseHeaders['Cache-Control'] = 'public, max-age=3600';
    responseHeaders['X-GitHub-Proxy'] = 'true';

    res.writeHead(proxyRes.statusCode, responseHeaders);

    // 流式传输
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Proxy Error',
        message: err.message
      }));
    }
  });

  // 传输请求体（POST/PUT 等）
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

function getBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  return `${protocol}://${host}`;
}