import { createServer } from 'http';
import https from 'https';
import url from 'url';

export default async function handler(req, res) {
  // Git 客户端通常使用智能协议
  const pathname = req.url;

  // 支持多种路径格式
  let repoPath = '';

  if (pathname.startsWith('/git/')) {
    repoPath = pathname.substring(5);
  } else if (pathname.startsWith('/')) {
    repoPath = pathname.substring(1);
  }

  // 去除 .git 后缀（如果需要）
  repoPath = repoPath.replace(/\.git$/, '');

  if (!repoPath) {
    res.writeHead(400);
    res.end('Please specify a repository path');
    return;
  }

  // 构建 GitHub URL
  const gitPaths = [
    // 智能协议
    `/${repoPath}/info/refs?service=git-upload-pack`,
    `/${repoPath}/git-upload-pack`,
    `/${repoPath}/info/refs?service=git-receive-pack`,
    `/${repoPath}/git-receive-pack`,
    // Git 数据
    `/${repoPath}/HEAD`,
    `/${repoPath}/objects/`,
    `/${repoPath}/refs/`
  ];

  // 根据请求路径选择对应的 GitHub 路径
  let targetPath = pathname;
  if (pathname.includes('info/refs')) {
    targetPath = `/${repoPath}/info/refs${pathname.includes('?') ? pathname.split('?')[1] : ''}`;
  } else if (pathname.includes('git-upload-pack')) {
    targetPath = `/${repoPath}/git-upload-pack`;
  } else if (pathname.includes('git-receive-pack')) {
    targetPath = `/${repoPath}/git-receive-pack`;
  }

  // 代理到 GitHub
  proxyToGitHub(req, res, targetPath);
}

function proxyToGitHub(req, res, path) {
  const options = {
    hostname: 'github.com',
    port: 443,
    path: path,
    method: req.method,
    headers: {
      ...req.headers,
      'host': 'github.com',
      'User-Agent': 'git/2.30.0',
      'Accept': '*/*',
      'Pragma': 'no-cache'
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Git 协议需要特定的 Content-Type
    let contentType = proxyRes.headers['content-type'];
    if (path.includes('info/refs')) {
      contentType = `application/x-git-${path.includes('upload-pack') ? 'upload' : 'receive'}-pack-advertisement`;
    } else if (path.includes('git-upload-pack') || path.includes('git-receive-pack')) {
      contentType = `application/x-git-${path.includes('upload-pack') ? 'upload' : 'receive'}-pack-result`;
    }

    const headers = {
      ...proxyRes.headers,
      'content-type': contentType,
      'cache-control': 'no-cache',
      'expires': 'Fri, 01 Jan 1980 00:00:00 GMT',
      'pragma': 'no-cache'
    };

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Git proxy error:', err);
    res.writeHead(502);
    res.end('Git proxy error');
  });

  // 传输请求体
  req.pipe(proxyReq);
}