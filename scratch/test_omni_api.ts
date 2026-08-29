async function testGrokVideo() {
  const baseUrl = 'https://grokai.zhubo.asia';
  const apiKey = 'sk-e8ef7f02e49dd0754e6dd742c9d093ad';
  const payload = {
    model: 'grok-imagine-1.0-video',
    prompt: 'a dog running on grass',
    seconds: 6,
    resolution_name: '720p',
  };

  console.log('Testing grok-imagine-1.0-video on grokai.zhubo.asia...');
  try {
    const res = await fetch(`${baseUrl}/v1/videos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    console.log(`Grok Status: ${res.status}`);
    const text = await res.text();
    console.log(`Grok Response:`, text);
  } catch (err: any) {
    console.error(`Grok Error:`, err.message);
  }
}

async function testVeoOmniFlash() {
  const baseUrl = 'https://newtoken.club';
  const apiKey = process.env.NEWTOKEN_API_KEY;
  if (!apiKey) throw new Error('NEWTOKEN_API_KEY is required');
  const payload = {
    model: 'veo-omni-flash',
    prompt: 'a dog running on grass',
    duration: 10,
    aspect_ratio: '16:9',
  };

  console.log('\nTesting veo-omni-flash on newtoken.club with new key...');
  try {
    const res = await fetch(`${baseUrl}/v1/videos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    console.log(`veo-omni-flash Status: ${res.status}`);
    const text = await res.text();
    console.log(`veo-omni-flash Response:`, text);
  } catch (err: any) {
    console.error(`veo-omni-flash Error:`, err.message);
  }
}

async function run() {
  await testGrokVideo();
  await testVeoOmniFlash();
}

run().catch(console.error);
