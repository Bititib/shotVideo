async function testVeo31(payload: any, label: string) {
  const baseUrl = 'https://newtoken.club';
  const apiKey = process.env.NEWTOKEN_API_KEY;
  if (!apiKey) throw new Error('NEWTOKEN_API_KEY is required');

  console.log(`--- Testing payload: ${label} ---`);
  try {
    const res = await fetch(`${baseUrl}/v1/videos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    console.log(`Status: ${res.status}`);
    const text = await res.text();
    console.log(`Response:`, text);
  } catch (err: any) {
    console.error(`Error:`, err.message);
  }
}

async function run() {
  // Test 1: Simple text to video
  await testVeo31({
    model: 'veo-3-1',
    prompt: 'a dog running on grass',
    duration: 8,
    aspect_ratio: '16:9',
  }, 'Simple T2V');

  // Test 2: With reference_images and first_frame_image
  await testVeo31({
    model: 'veo-3-1',
    prompt: 'a dog running on grass',
    duration: 8,
    aspect_ratio: '16:9',
    reference_images: ['https://example.com/img1.png'],
    first_frame_image: 'https://example.com/img1.png',
    last_frame_image: 'https://example.com/img1.png',
  }, 'With reference_images & first/last frame');
}

run().catch(console.error);
