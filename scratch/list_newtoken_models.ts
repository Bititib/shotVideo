async function listModels() {
  const baseUrl = 'https://newtoken.club';
  const apiKey = 'sk-tO4xRDsMI4XmyVw5gcsWwdYbC9s14NJieyZDuPmIqNgpA3jW';

  console.log('Listing models on newtoken.club...');
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    console.log(`Status: ${res.status}`);
    const data = await res.json() as any;
    const modelList = data.data || [];
    console.log('Available models:');
    for (const m of modelList) {
      console.log(`- ID: ${m.id}`);
    }
  } catch (err: any) {
    console.error(`Error listing models:`, err.message);
  }
}

listModels().catch(console.error);
