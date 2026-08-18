const BASE = 'http://localhost:3123';

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@admin.com', password: 'oZIQHIE4XuLpqpPI6w9CNQ' }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status}`);
  }
  const data = await res.json() as any;
  return data.token;
}

async function verifyPatch() {
  console.log('--- Verify Patched Model Mapping ---');
  try {
    const token = await login();
    console.log('Login success. Sending video request for model sdas-pd-sd2.0-pro-933-5-720p...');
    
    const res = await fetch(`${BASE}/api/video/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        prompt: 'a cute cat running on grass',
        model: 'sdas-pd-sd2.0-pro-933-5-720p',
        aspect_ratio: '16:9',
        video_length: 10,
        resolution: '720p'
      })
    });

    console.log(`HTTP Status: ${res.status}`);
    const text = await res.text();
    console.log('Response body:', text);
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

verifyPatch();
