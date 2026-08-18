/**
 * 测试 SD2.5 固定 30s 生成
 * 1. 先登录获取 token
 * 2. 获取模型列表，验证 sd2.5 的 allowedSeconds 只有 [30]
 * 3. 尝试用 video_length=15 调用生成（应被拒绝）
 * 4. 尝试用 video_length=30 调用生成（应成功提交）
 */

const BASE = 'http://localhost:3001';

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@admin.com', password: 'oZIQHIE4XuLpqpPI6w9CNQ' }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Login failed: ${res.status} ${txt}`);
  }
  const data = await res.json() as any;
  return data.token;
}

async function getModels(token: string) {
  const res = await fetch(`${BASE}/api/video/models`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Models failed: ${res.status}`);
  return res.json() as Promise<any[]>;
}

async function generateVideo(token: string, videoLength: number): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}/api/video/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      prompt: '一只猫在花园中行走',
      model: 'sd2.5',
      aspect_ratio: '16:9',
      video_length: videoLength,
      resolution: '720p',
    }),
  });
  const body = await res.text();
  return { status: res.status, body };
}

async function run() {
  console.log('=== SD2.5 固定30s 测试 ===\n');

  // Step 1: Login
  console.log('[1] 登录获取 token...');
  const token = await login();
  console.log(`    ✅ 登录成功, token: ${token.slice(0, 20)}...`);

  // Step 2: Check models API
  console.log('\n[2] 获取模型列表，检查 sd2.5 配置...');
  const models = await getModels(token);
  const sd25 = models.find((m: any) => m.id === 'sd2.5');
  if (!sd25) {
    console.error('    ❌ 未找到 sd2.5 模型!');
    return;
  }
  console.log(`    模型名: ${sd25.name}`);
  console.log(`    描述: ${sd25.description}`);
  console.log(`    allowedSeconds: ${JSON.stringify(sd25.allowedSeconds)}`);
  console.log(`    maxSeconds: ${sd25.maxSeconds}`);

  if (JSON.stringify(sd25.allowedSeconds) === '[30]') {
    console.log('    ✅ allowedSeconds 正确: 只有 [30]');
  } else {
    console.error(`    ❌ allowedSeconds 不正确! 期望 [30]，实际 ${JSON.stringify(sd25.allowedSeconds)}`);
  }

  if (sd25.description.includes('固定 30 秒')) {
    console.log('    ✅ 描述已更新为"固定 30 秒"');
  } else {
    console.error('    ❌ 描述未更新!');
  }

  // Step 3: Test with invalid duration (15s - should be rejected)
  console.log('\n[3] 测试无效时长 video_length=15（应被拒绝）...');
  const r15 = await generateVideo(token, 15);
  console.log(`    状态码: ${r15.status}`);
  if (r15.status === 400) {
    console.log(`    ✅ 正确拒绝: ${r15.body}`);
  } else {
    console.error(`    ❌ 期望400，实际 ${r15.status}: ${r15.body.slice(0, 200)}`);
  }

  // Step 4: Test with valid duration (30s - should be accepted)
  console.log('\n[4] 测试有效时长 video_length=30（应被接受）...');
  const r30 = await generateVideo(token, 30);
  console.log(`    状态码: ${r30.status}`);
  // 200 = SSE stream started (accepted), or could be 503 if no channel configured - both prove validation passed
  if (r30.status === 200) {
    // SSE stream - read first few events
    const lines = r30.body.split('\n').filter(l => l.startsWith('data: ')).slice(0, 5);
    console.log(`    ✅ 请求被接受 (SSE stream), 前几条事件:`);
    lines.forEach(l => console.log(`       ${l}`));
  } else if (r30.status === 503) {
    console.log(`    ✅ 验证通过（但无可用渠道）: ${r30.body}`);
  } else {
    console.error(`    ❌ 意外状态码: ${r30.status}: ${r30.body.slice(0, 300)}`);
  }

  console.log('\n=== 测试完成 ===');
}

run().catch(console.error);
